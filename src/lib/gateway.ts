// ---------------------------------------------------------------------------
// Vercel AI Gateway client — OpenAI-compatible, no SDK dependency
//
// The third provider path, alongside the two hand-written native clients
// (anthropic.ts, gemini.ts). Where those speak a vendor-specific dialect and
// carry that vendor's accumulated quirks, this one speaks ONE generic dialect
// (OpenAI Chat Completions) against a gateway that fronts hundreds of models.
// Adding a model behind it is a MODEL_MAP entry, not a new client.
//
// Scope is deliberately narrow (see README "Vercel AI Gateway"): non-streaming
// `/complete` + `/internal/platform-complete` only. No /chat, no tool calling,
// no web search, no images, no embeddings.
// ---------------------------------------------------------------------------

const GATEWAY_API_BASE = "https://ai-gateway.vercel.sh/v1";

/** Provider slug used for key-service resolution and the costs-service catalog. */
export const GATEWAY_PROVIDER = "vercel";

/** Request timeout. Matches the Gemini Flash-tier budget. */
const GATEWAY_TIMEOUT_MS = 10 * 60_000;

/** Max connect-phase retries before giving up. */
const MAX_CONNECT_RETRIES = 3;

/** Backoff schedule for connect-phase retries (ms). */
const RETRY_DELAYS_MS = [250, 500, 1000];

/**
 * Transient connect-phase error codes. A request that fails with one of these
 * NEVER reached the server, so replaying it cannot double-spend.
 */
const TRANSIENT_CONNECT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export class GatewayProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayProviderError";
  }
}

export interface GatewayCompleteOptions {
  apiKey: string;
  /** Gateway model id, e.g. "deepseek/deepseek-v4-flash". */
  model: string;
  message: string;
  systemPrompt?: string;
  responseFormat?: "text" | "json";
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GatewayCompleteResult {
  content: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  /** Always 0 — web search is not wired on the gateway path. Keeps the shape uniform. */
  searchCount: number;
  /** Always empty — see searchCount. */
  sources: Array<{ url: string; title?: string }>;
  /**
   * Cached input tokens the provider reported, for OBSERVABILITY ONLY.
   *
   * These are NOT discounted when the cost is declared: they are billed at the
   * full cache-MISS rate, exactly like Anthropic cache reads are today (the
   * costs catalog has no `-tokens-cached-input` name for any provider). Two
   * reasons, and both must hold before that changes:
   *   1. AI Gateway currently bills implicit-cache tokens at full input price
   *      for OpenAI/DeepSeek-class providers (vercel/ai#13907, open). So the
   *      cache discount does not exist on our invoice yet.
   *   2. Our catalog price is DeepSeek's PEAK list rate, above what every
   *      provider of this model currently charges — cheap reads are margin.
   * Log it, do not bill on it.
   */
  cachedInputTokens: number;
  /** Gateway-reported inference cost in USD, for reconciliation against what we declared. */
  gatewayCostUsd: string | null;
  /** Which upstream provider actually served the request (routing is dynamic). */
  finalProvider: string | null;
}

interface GatewayUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface GatewayChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}

interface GatewayResponseBody {
  id?: string;
  model?: string;
  choices?: GatewayChoice[];
  usage?: GatewayUsage;
  error?: { message?: string; type?: string; code?: string } | string;
  provider_metadata?: {
    gateway?: {
      cost?: string;
      generationId?: string;
      routing?: { finalProvider?: string; resolvedProvider?: string };
    };
  };
}

/** Walk an error (and any `cause` / AggregateError chain) for a transient connect code. */
function isTransientConnectError(err: unknown, depth = 0): boolean {
  if (!err || depth > 5) return false;
  const e = err as { code?: string; cause?: unknown; errors?: unknown[] };
  if (typeof e.code === "string" && TRANSIENT_CONNECT_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.some((sub) => isTransientConnectError(sub, depth + 1))) {
    return true;
  }
  return isTransientConnectError(e.cause, depth + 1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the OpenAI-compatible request body.
 *
 * Deliberately carries NO gateway routing knobs — no `models` fallback array,
 * no `sort`, no `order`. A request that silently resolved to a DIFFERENT model
 * than the alias we priced would declare the wrong cost name, so the model must
 * be the one thing that cannot move under us. `assertModelMatches` below is the
 * second half of that guarantee.
 *
 * The caller's `systemPrompt` is forwarded byte-equal — no preamble, no
 * postamble, no "respond with JSON" nudge (README "Prompt Ownership").
 */
export function buildGatewayRequestBody(options: GatewayCompleteOptions): Record<string, unknown> {
  const { model, message, systemPrompt, responseFormat, responseSchema, temperature, maxOutputTokens } = options;

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: message });

  const body: Record<string, unknown> = { model, messages, stream: false };

  if (temperature != null) body.temperature = temperature;
  if (maxOutputTokens != null) body.max_tokens = maxOutputTokens;

  // JSON mode via native provider metadata only. Note that not every model
  // behind the gateway enforces it (DeepSeek V4 Flash does not advertise
  // `response_format` support on any of its endpoints), so the gateway may pass
  // it through to a provider that ignores it. That is acceptable and NOT a
  // silent fallback: parseModelJsonOutput still fails loud (502) on output it
  // cannot read. It is also exactly what the bake-off has to measure before any
  // caller is migrated onto a gateway model.
  if (responseSchema != null) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema: responseSchema },
    };
  } else if (responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }

  return body;
}

/**
 * The gateway routes dynamically across every provider serving a model, so the
 * response echoes which model actually answered. If it is not the model we
 * asked for, the cost prefix we are about to declare no longer describes the
 * spend — fail loud rather than bill the wrong catalog name.
 */
export function assertModelMatches(requested: string, returned: string | undefined): void {
  if (!returned) return;
  const normalize = (m: string) => m.trim().toLowerCase();
  if (normalize(returned) !== normalize(requested)) {
    throw new GatewayProviderError(
      `[gateway] Model mismatch: requested "${requested}" but the gateway served "${returned}". ` +
        `Refusing to declare cost under the requested model's catalog name.`,
    );
  }
}

/** Extract an in-band error message from a 200-status body, if present. */
function inBandError(body: GatewayResponseBody): string | null {
  if (!body.error) return null;
  if (typeof body.error === "string") return body.error;
  return body.error.message ?? JSON.stringify(body.error);
}

export function mapGatewayResponse(
  requestedModel: string,
  body: GatewayResponseBody,
): GatewayCompleteResult {
  const errMessage = inBandError(body);
  if (errMessage) {
    throw new GatewayProviderError(`[gateway] Provider returned an error: ${errMessage}`);
  }

  assertModelMatches(requestedModel, body.model);

  const choice = body.choices?.[0];
  const content = choice?.message?.content;

  // Fail loud on a wholly-empty stream rather than returning "" with HTTP 200 —
  // the same contract the Gemini path learned the hard way (incident 2026-06-01).
  if (typeof content !== "string" || content.length === 0) {
    throw new GatewayProviderError(
      `[gateway] Empty response from "${requestedModel}" (finish_reason=${choice?.finish_reason ?? "none"}).`,
    );
  }

  if (choice?.finish_reason === "length") {
    console.warn(
      `[chat-service] [gateway] Output truncated (finish_reason=length) for "${requestedModel}".`,
    );
  }

  const usage = body.usage ?? {};
  const gw = body.provider_metadata?.gateway;

  return {
    content,
    tokensInput: usage.prompt_tokens ?? 0,
    tokensOutput: usage.completion_tokens ?? 0,
    model: body.model ?? requestedModel,
    searchCount: 0,
    sources: [],
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    gatewayCostUsd: gw?.cost ?? null,
    finalProvider: gw?.routing?.finalProvider ?? gw?.routing?.resolvedProvider ?? null,
  };
}

/**
 * Non-streaming completion through the Vercel AI Gateway.
 *
 * Retries ONLY connect-phase failures (a thrown fetch rejection whose cause is
 * a transient socket error). A completed HTTP response — including a 5xx — is a
 * real answer from the gateway and may already have been billed upstream, so it
 * is never replayed. This is intentionally stricter than gemini.ts, which
 * retries 429/5xx status codes.
 */
export async function completeWithGateway(
  options: GatewayCompleteOptions,
): Promise<GatewayCompleteResult> {
  const { apiKey, model } = options;
  const body = buildGatewayRequestBody(options);

  let lastConnectError: unknown = null;

  for (let attempt = 0; attempt <= MAX_CONNECT_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${GATEWAY_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (isTransientConnectError(err) && attempt < MAX_CONNECT_RETRIES) {
        lastConnectError = err;
        console.warn(
          `[chat-service] [gateway] Connect-phase failure for "${model}" ` +
            `(attempt ${attempt + 1}/${MAX_CONNECT_RETRIES + 1}), retrying.`,
        );
        await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
        continue;
      }
      throw err instanceof Error ? err : new GatewayProviderError(String(err ?? lastConnectError));
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GatewayProviderError(
        `[gateway] ${res.status} from ${model}: ${text.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as GatewayResponseBody;
    const result = mapGatewayResponse(model, json);

    // Reconciliation breadcrumb: what the gateway says the call cost vs what we
    // declare from the catalog, plus which provider served it (routing is
    // dynamic and per-provider rates differ ~3x for the same model).
    console.log(
      `[chat-service] [gateway] model="${result.model}" provider="${result.finalProvider ?? "unknown"}" ` +
        `in=${result.tokensInput} out=${result.tokensOutput} cached=${result.cachedInputTokens} ` +
        `gatewayCostUsd=${result.gatewayCostUsd ?? "n/a"}`,
    );

    return result;
  }

  throw new GatewayProviderError(
    `[gateway] Exhausted connect retries for "${model}": ${String(lastConnectError)}`,
  );
}
