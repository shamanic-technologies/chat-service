// ---------------------------------------------------------------------------
// Direct-vendor OpenAI-compatible client — ONE adapter, N vendors
//
// The third provider path, alongside the two hand-written native clients
// (anthropic.ts, gemini.ts). Where those speak a vendor-specific dialect and
// carry that vendor's accumulated quirks, this one speaks ONE generic dialect
// (OpenAI Chat Completions) against vendors that all serve it.
//
// It replaces the Vercel AI Gateway path (removed 2026-08-15). The gateway
// charged above the vendors' own list prices (1.4x on DeepSeek V4 Flash, 4x on
// V4 Pro), added a payment-processing fee on every top-up, and gated recent
// models behind a paid tier. We call the vendors directly instead.
//
// The vendors differ in exactly three things, and all three are DATA here, not
// code: the base URL, the key-service provider slug, and where the usage
// payload reports cached prompt tokens. Adding a seventh model is a MODEL_MAP
// entry; adding a fourth vendor is a VENDORS entry. Neither is a new client.
//
// Scope is deliberately narrow (see README "Direct vendor models"):
// non-streaming `/complete` + `/internal/platform-complete` only. No /chat, no
// tool calling, no web search, no images, no embeddings.
// ---------------------------------------------------------------------------

/** Request timeout. Matches the Gemini Flash-tier budget. */
const VENDOR_TIMEOUT_MS = 10 * 60_000;

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

export class VendorProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorProviderError";
  }
}

/**
 * Vendors reachable through this adapter. The id doubles as the API `provider`
 * value AND the key-service provider slug — one vendor, one key, one name.
 */
export type VendorId = "deepseek" | "zai" | "moonshot";

/** Raw `usage` object as returned by an OpenAI-compatible chat completion. */
export interface VendorUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** DeepSeek: prompt tokens served from its context cache. */
  prompt_cache_hit_tokens?: number;
  /** DeepSeek: prompt tokens that missed the cache. Carried for logging only. */
  prompt_cache_miss_tokens?: number;
  /** Moonshot / Kimi: prompt tokens served from cache, flat on `usage`. */
  cached_tokens?: number;
  /** Z.ai and the OpenAI convention: nested under `prompt_tokens_details`. */
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * A vendor's time-of-day price schedule, mirrored from the catalog rows.
 *
 * `peakWindowsUtc` is the costs-service `regimeHoursUtc` value split on the
 * comma, and the two segments are the literal name parts the catalog uses — so
 * the string this produces is byte-equal to a real row rather than an
 * independently-invented convention.
 */
export interface PricingRegimeSchedule {
  /** UTC windows in which the peak regime applies, `"HH:MM-HH:MM"` each. */
  peakWindowsUtc: string[];
  /** Name segment for the peak rows. */
  peakSegment: string;
  /** Name segment for every other hour. */
  offPeakSegment: string;
}

/**
 * What a vendor's costs-service catalog actually prices.
 *
 * The three vendors do not agree, and the asymmetry is real rather than an
 * oversight: DeepSeek prices a cache hit AND a time-of-day regime, Z.ai prices
 * a cache hit only, Moonshot prices nothing yet. Declaring a dimension a vendor
 * does not carry names a row that does not exist (422 at declaration); assuming
 * one it does carry bills a hit at the miss rate. So each vendor states its own
 * dimensions here and `buildLlmCostNames` (src/lib/cost-names.ts) reads them —
 * a vendor added later declares what it prices and nothing else.
 */
export type VendorPricing =
  | {
      kind: "priced";
      /** True when the catalog carries a separate `-tokens-cached-input` row. */
      cachedInput: boolean;
      /** Non-null when the catalog splits prices by time of day. */
      regime: PricingRegimeSchedule | null;
    }
  | {
      kind: "unpriced";
      /** Why there is no price yet — surfaced in the fail-loud message. */
      reason: string;
    };

export interface VendorConfig {
  id: VendorId;
  /** Human-readable name, used in caller-facing error messages. */
  label: string;
  /**
   * OpenAI-compatible API base, no trailing slash. The adapter POSTs to
   * `${baseUrl}/chat/completions`.
   */
  baseUrl: string;
  /** Vendor's own API documentation, for whoever debugs this next. */
  docsUrl: string;
  /**
   * Where THIS vendor reports cached prompt tokens.
   *
   * All three price a cache hit far below a fresh token (50x cheaper at
   * DeepSeek), and all three report the count — but each in a different place.
   * That divergence is the only reason this function exists; everything else
   * about the three requests is identical. See `mapVendorResponse` for what the
   * number is used for.
   */
  readCachedTokens: (usage: VendorUsage) => number;
  /**
   * The priced dimensions THIS vendor's catalog rows carry. Read at cost
   * declaration; see `VendorPricing`.
   */
  pricing: VendorPricing;
}

export const VENDORS: Record<VendorId, VendorConfig> = {
  // https://api-docs.deepseek.com/quick_start/pricing — read 2026-08-15.
  // Cache hit $0.014 vs cache miss $0.44 per 1M input tokens (peak): 31x.
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    docsUrl: "https://api-docs.deepseek.com",
    // DeepSeek splits the prompt count itself: prompt_tokens = hit + miss.
    readCachedTokens: (usage) => usage.prompt_cache_hit_tokens ?? 0,
    // Both dimensions. Peak hours are DeepSeek's own, copied from the catalog
    // rows' regimeHoursUtc ("01:00-04:00,06:00-10:00"); every other hour is
    // off-peak. The time-of-day rates take effect 2026-08-16T16:00Z and
    // costs-service handled that with effective-dated price points — both
    // regimes already carry today's identical rate — so the regime is selected
    // by the clock alone, never by the date.
    pricing: {
      kind: "priced",
      cachedInput: true,
      regime: {
        peakWindowsUtc: ["01:00-04:00", "06:00-10:00"],
        peakSegment: "peak",
        offPeakSegment: "off-peak",
      },
    },
  },
  // https://docs.z.ai/api-reference/llm/chat-completion — read 2026-08-15.
  // Cached input $0.26 vs $1.4 per 1M on glm-5.2; $0.01 vs $0.07 on flashx.
  zai: {
    id: "zai",
    label: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    docsUrl: "https://docs.z.ai",
    // Follows the OpenAI convention: usage.prompt_tokens_details.cached_tokens.
    readCachedTokens: (usage) => usage.prompt_tokens_details?.cached_tokens ?? 0,
    // Cached input is its own catalog row; Z.ai publishes no time-of-day
    // schedule, so its rows carry no regime and the names have no regime
    // segment. Inventing one here would name a row that does not exist.
    pricing: { kind: "priced", cachedInput: true, regime: null },
  },
  // https://platform.kimi.ai/docs/api/chat — read 2026-08-15.
  // Cache hit $0.30 vs $3.00 per 1M on kimi-k3; $0.16 vs $0.95 on kimi-k2.6.
  moonshot: {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    docsUrl: "https://platform.kimi.ai/docs",
    // Moonshot reports it flat on `usage`, not nested. Fall back to the
    // OpenAI-shaped location so a future API alignment does not silently lose
    // the count (and with it the cache discount).
    readCachedTokens: (usage) =>
      usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
    // Priced since costs-service v0.46.0, which read the per-model pages the
    // pricing index does not carry figures on. Cache-hit input is its own row at
    // the vendor's own rate; Moonshot publishes no time-of-day schedule, so the
    // names carry no regime segment — the same shape as Z.ai.
    pricing: { kind: "priced", cachedInput: true, regime: null },
  },
};

export const VENDOR_IDS = Object.keys(VENDORS) as VendorId[];

/** True when the resolved provider is one of the direct-vendor OpenAI-compatible paths. */
export function isVendorProvider(provider: string): provider is VendorId {
  return Object.prototype.hasOwnProperty.call(VENDORS, provider);
}

/**
 * Look up a vendor, failing loud on an unknown slug rather than defaulting to
 * one — a request billed against the wrong vendor's catalog name is worse than
 * a 500.
 */
export function vendorConfig(provider: string): VendorConfig {
  const config = VENDORS[provider as VendorId];
  if (!config) {
    throw new VendorProviderError(
      `[vendor] Unknown vendor "${provider}". Known vendors: ${VENDOR_IDS.join(", ")}.`,
    );
  }
  return config;
}

export interface VendorCompleteOptions {
  vendor: VendorId;
  apiKey: string;
  /** Vendor model id, e.g. "deepseek-v4-flash", "glm-5.2", "kimi-k3". */
  model: string;
  message: string;
  systemPrompt?: string;
  responseFormat?: "text" | "json";
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface VendorCompleteResult {
  content: string;
  /** TOTAL prompt tokens, cached and fresh — the vendor's own `prompt_tokens`. */
  tokensInput: number;
  tokensOutput: number;
  model: string;
  /** Always 0 — web search is not wired on the direct-vendor paths. Keeps the shape uniform. */
  searchCount: number;
  /** Always empty — see searchCount. */
  sources: Array<{ url: string; title?: string }>;
  /**
   * Prompt tokens the vendor served from ITS cache, a SUBSET of `tokensInput`.
   *
   * This one is billed, not merely logged. All three vendors price a cache hit
   * far below a fresh token, and our dominant workload is a large stable prompt
   * with a small per-lead block — so cache hits are the normal case, not the
   * exception. `/complete` declares `tokensInput - cachedInputTokens` under
   * `<prefix>-tokens-input` and this count under `<prefix>-tokens-cached-input`.
   *
   * (The removed gateway path deliberately did NOT discount these, because
   * Vercel billed implicit-cache tokens at the full input price regardless of
   * what the underlying vendor charged — vercel/ai#13907. Calling the vendor
   * directly is exactly what makes the discount real on our invoice.)
   */
  cachedInputTokens: number;
  /** Which vendor served the request — for logs and cost reconciliation. */
  vendor: VendorId;
}

interface VendorChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}

interface VendorResponseBody {
  id?: string;
  model?: string;
  choices?: VendorChoice[];
  usage?: VendorUsage;
  error?: { message?: string; type?: string; code?: string } | string;
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
 * Deliberately carries NO routing / fallback knobs — no `models` array, no
 * `sort`, no provider `order`. A request that silently resolved to a DIFFERENT
 * model than the alias we priced would declare the wrong cost name, so the
 * model must be the one thing that cannot move under us. `assertModelMatches`
 * below is the second half of that guarantee.
 *
 * The caller's `systemPrompt` is forwarded byte-equal — no preamble, no
 * postamble, no "respond with JSON" nudge (README "Prompt Ownership").
 */
export function buildVendorRequestBody(options: VendorCompleteOptions): Record<string, unknown> {
  const { model, message, systemPrompt, responseFormat, responseSchema, temperature, maxOutputTokens } = options;

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: message });

  const body: Record<string, unknown> = { model, messages, stream: false };

  if (temperature != null) body.temperature = temperature;
  if (maxOutputTokens != null) body.max_tokens = maxOutputTokens;

  // JSON mode via native provider metadata only. Enforcement strength varies by
  // vendor and model, so the request may reach a model that treats it as a hint.
  // That is acceptable and NOT a silent fallback: parseModelJsonOutput still
  // fails loud (502) on output it cannot read.
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
 * The response echoes which model actually answered. If it is not the model we
 * asked for, the cost prefix we are about to declare no longer describes the
 * spend — fail loud rather than bill the wrong catalog name.
 *
 * A DATED BUILD of the requested model is accepted (`deepseek-v4-pro` served as
 * `deepseek-v4-pro-0813`): our aliases are version-free by convention, the
 * vendor resolves the current build, and it is the same model at the same
 * price. A different model is not, and throws.
 */
export function assertModelMatches(requested: string, returned: string | undefined): void {
  if (!returned) return;
  const normalize = (m: string) => m.trim().toLowerCase();
  const req = normalize(requested);
  const got = normalize(returned);
  if (got === req || got.startsWith(`${req}-`)) return;
  throw new VendorProviderError(
    `[vendor] Model mismatch: requested "${requested}" but the vendor served "${returned}". ` +
      `Refusing to declare cost under the requested model's catalog name.`,
  );
}

/** Extract an in-band error message from a 200-status body, if present. */
function inBandError(body: VendorResponseBody): string | null {
  if (!body.error) return null;
  if (typeof body.error === "string") return body.error;
  return body.error.message ?? JSON.stringify(body.error);
}

export function mapVendorResponse(
  vendor: VendorId,
  requestedModel: string,
  body: VendorResponseBody,
): VendorCompleteResult {
  const errMessage = inBandError(body);
  if (errMessage) {
    throw new VendorProviderError(
      `[vendor:${vendor}] Provider returned an error: ${errMessage}`,
    );
  }

  assertModelMatches(requestedModel, body.model);

  const choice = body.choices?.[0];
  const content = choice?.message?.content;

  // Fail loud on a wholly-empty response rather than returning "" with HTTP 200 —
  // the same contract the Gemini path learned the hard way (incident 2026-06-01).
  if (typeof content !== "string" || content.length === 0) {
    throw new VendorProviderError(
      `[vendor:${vendor}] Empty response from "${requestedModel}" (finish_reason=${choice?.finish_reason ?? "none"}).`,
    );
  }

  if (choice?.finish_reason === "length") {
    console.warn(
      `[chat-service] [vendor:${vendor}] Output truncated (finish_reason=length) for "${requestedModel}".`,
    );
  }

  const usage = body.usage ?? {};
  const tokensInput = usage.prompt_tokens ?? 0;

  // Every vendor reports the cached count as a SUBSET of prompt_tokens. Clamp
  // rather than trust: a cached count above the prompt total would make the
  // fresh-token quantity negative and runs-service would reject the whole
  // declaration, failing a call that actually succeeded.
  const rawCached = vendorConfig(vendor).readCachedTokens(usage);
  const cachedInputTokens = Math.max(0, Math.min(rawCached, tokensInput));

  return {
    content,
    tokensInput,
    tokensOutput: usage.completion_tokens ?? 0,
    model: body.model ?? requestedModel,
    searchCount: 0,
    sources: [],
    cachedInputTokens,
    vendor,
  };
}

/**
 * Non-streaming completion against a vendor's OpenAI-compatible endpoint.
 *
 * Retries ONLY connect-phase failures (a thrown fetch rejection whose cause is
 * a transient socket error). A completed HTTP response — including a 5xx — is a
 * real answer from the vendor and may already have been billed upstream, so it
 * is never replayed. This is intentionally stricter than gemini.ts, which
 * retries 429/5xx status codes.
 *
 * A vendor being down fails loud. There is no cross-vendor fallback: silently
 * answering from a different model would bill spend under a catalog name that
 * does not describe what ran, and hand the caller an answer from a model it did
 * not choose.
 */
export async function completeWithVendor(
  options: VendorCompleteOptions,
): Promise<VendorCompleteResult> {
  const { apiKey, model, vendor } = options;
  const config = vendorConfig(vendor);
  const body = buildVendorRequestBody(options);

  let lastConnectError: unknown = null;

  for (let attempt = 0; attempt <= MAX_CONNECT_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VENDOR_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/chat/completions`, {
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
          `[chat-service] [vendor:${vendor}] Connect-phase failure for "${model}" ` +
            `(attempt ${attempt + 1}/${MAX_CONNECT_RETRIES + 1}), retrying.`,
        );
        await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
        continue;
      }
      throw err instanceof Error ? err : new VendorProviderError(String(err ?? lastConnectError));
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new VendorProviderError(
        `[vendor:${vendor}] ${res.status} from ${model}: ${text.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as VendorResponseBody;
    const result = mapVendorResponse(vendor, model, json);

    // Reconciliation breadcrumb: the cache split drives what we declare, so log
    // it next to the totals rather than only the totals.
    console.log(
      `[chat-service] [vendor:${vendor}] model="${result.model}" ` +
        `in=${result.tokensInput} cached=${result.cachedInputTokens} out=${result.tokensOutput}`,
    );

    return result;
  }

  throw new VendorProviderError(
    `[vendor:${vendor}] Exhausted connect retries for "${model}": ${String(lastConnectError)}`,
  );
}

/**
 * Caller-facing message for a key-service resolution failure.
 *
 * The three vendor keys are provisioned independently, so "which one is
 * missing" is the whole content of the error. Name the vendor and the slug the
 * key must be stored under — a generic "failed to resolve API key" sends the
 * reader to the wrong console.
 */
export function keyResolutionErrorMessage(provider: string, scope: "org" | "platform"): string {
  const suffix =
    scope === "platform"
      ? "Store the platform key in key-service under that provider slug."
      : "Ensure the key is configured in key-service under that provider slug.";
  if (isVendorProvider(provider)) {
    const { label, docsUrl } = VENDORS[provider];
    return (
      `Failed to resolve the ${label} API key (key-service provider "${provider}"). ` +
      `${suffix} Vendor docs: ${docsUrl}`
    );
  }
  return `Failed to resolve ${provider} API key. ${suffix}`;
}
