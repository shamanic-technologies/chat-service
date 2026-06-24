// ---------------------------------------------------------------------------
// Gemini REST API client — lightweight, no SDK dependency
// Used by POST /complete for vision tasks (gemini-3.1-flash-lite)
// ---------------------------------------------------------------------------

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
export const GEMINI_IMAGE_COST_PREFIX = "google-flash-image-3.1";
export const GEMINI_IMAGE_MAX_OUTPUT_TOKENS = 32_000;

export const GEMINI_MODELS: Record<string, string> = {
  "gemini-3.1-flash-lite": "google-flash-lite-3.1",
  "gemini-3-flash-preview": "google-flash-3",
  "gemini-3.1-pro-preview": "google-pro-3.1",
  "gemini-2.5-pro": "google-pro-2.5",
  "gemini-2.5-flash": "google-flash-2.5",
};

/** Model-specific API timeouts in milliseconds. */
const GEMINI_TIMEOUT_MS: Record<string, number> = {
  "gemini-3.1-pro-preview": 15 * 60_000,       // 15 min — Pro
  "gemini-3-flash-preview": 10 * 60_000,        // 10 min — Flash
  "gemini-3.1-flash-lite": 5 * 60_000,          //  5 min — Flash Lite
  "gemini-2.5-pro": 15 * 60_000,                // 15 min — 2.5 Pro
  "gemini-2.5-flash": 10 * 60_000,              // 10 min — 2.5 Flash
};
const DEFAULT_GEMINI_TIMEOUT_MS = 10 * 60_000;  // 10 min fallback

/** Fallback from preview 3.x models to stable 2.5 models. */
const GEMINI_FALLBACK_MODEL: Record<string, string> = {
  "gemini-3.1-pro-preview": "gemini-2.5-pro",
  "gemini-3-flash-preview": "gemini-2.5-flash",
  "gemini-3.1-flash-lite": "gemini-2.5-flash",
};

/** HTTP status codes that warrant a retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503, 504]);

/** Max retries before falling back to the stable model. */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff in ms. */
const RETRY_BASE_DELAY_MS = 1_000;

// Explicit output-token budget for /complete. Without it Gemini falls back to
// its (lower) per-model DEFAULT cap and truncates long responses early, raising
// finishReason:"MAX_TOKENS" — which, in JSON mode, yields truncated JSON and a
// cryptic downstream `JSON.parse: Unterminated string` 502. 64k matches both the
// worst-case hold provisioned/authorized in src/index.ts AND the Anthropic path
// (anthropic.ts MAX_TOKENS). Setting it explicitly gives MORE headroom, not less.
// Do NOT remove (regression history: PR #140 dropped it; incident 2026-06-04).
const GEMINI_MAX_OUTPUT_TOKENS = 64_000;

/** Max delay cap for exponential backoff in ms. */
const RETRY_MAX_DELAY_MS = 30_000;

// Thinking config is GENERATION-SPECIFIC. Gemini 3.x (gemini-3*, incl
// gemini-3.5-flash) uses `thinkingLevel` ("minimal"|"low"|"medium"|"high");
// the Gemini-2.5-era `thinkingBudget` integer is only "accepted for backwards
// compatibility" on Gemini 3 and produces degenerate output — the model spends
// its whole output budget on internal thinking and emits ZERO answer text
// (finishReason: MAX_TOKENS). On /complete that surfaces as the 7-9-token
// truncation: gemini-3.5-flash with NO thinkingConfig defaults to high thinking,
// burns the entire 64k output budget reasoning before emitting any JSON → every
// jsonMode /complete 502s (incident 2026-06-24, brand-service ICP/audiences/
// extract-fields down). The /chat path was already fixed (commit 1991af2); this
// is the same fix on the /complete path. PR #133's old `thinkingBudget: 0` is
// NOT a valid Gemini-3 disable — it must be `thinkingLevel`.
// "low" gives enough reasoning while leaving budget for the answer.
// See https://ai.google.dev/gemini-api/docs/thinking
const GEMINI_3_THINKING_LEVEL = "low";
const GEMINI_25_THINKING_BUDGET = 8192;

// Provider FLOOR for `disableThinking` — the lowest thinking each Gemini gen
// allows. Gemini 3 has NO full-off (verified against
// https://ai.google.dev/gemini-api/docs/thinking): Flash bottoms at "minimal",
// Pro at "low". Gemini 2.5 alone can go fully off (thinkingBudget: 0). So
// disableThinking is "minimize to the floor", documented as such on the
// /complete schema — NOT a guaranteed zero on Gemini 3 (mirror of maxSearches:
// a hard knob on one provider, best-effort on the other).
const GEMINI_3_PRO_MIN_LEVEL = "low";
const GEMINI_3_FLASH_MIN_LEVEL = "minimal";
const GEMINI_25_THINKING_OFF = 0;

/**
 * Build the generation-specific `thinkingConfig`. Shared by /complete
 * (gemini.ts) and /chat (gemini-chat.ts) so both paths bound Gemini-3 thinking
 * identically. When `disableThinking` is set, drop to the provider's floor
 * (fully off on Gemini 2.5; lowest level on Gemini 3 — it has no full-off).
 */
export function buildThinkingConfig(
  model: string,
  disableThinking = false,
): Record<string, unknown> {
  const isGemini3 = model.startsWith("gemini-3");
  if (disableThinking) {
    if (isGemini3) {
      // "pro" id (gemini-3.1-pro-preview) floors at "low"; Flash/flash-lite at "minimal".
      const level = model.includes("pro") ? GEMINI_3_PRO_MIN_LEVEL : GEMINI_3_FLASH_MIN_LEVEL;
      return { thinkingLevel: level };
    }
    return { thinkingBudget: GEMINI_25_THINKING_OFF };
  }
  return isGemini3
    ? { thinkingLevel: GEMINI_3_THINKING_LEVEL }
    : { thinkingBudget: GEMINI_25_THINKING_BUDGET };
}

/** Check if a model ID is a Gemini model. */
export function isGeminiModel(model: string): boolean {
  return model in GEMINI_MODELS;
}

/** Get cost-name prefix for a Gemini model. */
export function geminiCostPrefix(model: string): string {
  return GEMINI_MODELS[model] ?? "google-flash-lite-3.1";
}

export interface ImageContext {
  alt?: string;
  title?: string;
  sourceUrl?: string;
}

interface GeminiCompleteOptions {
  apiKey: string;
  model: string;
  message: string;
  systemPrompt: string;
  imageUrl?: string;
  imageContext?: ImageContext;
  responseFormat?: "json";
  /**
   * Optional JSON Schema enforced server-side by Gemini via
   * `generationConfig.responseSchema`. When present, JSON mode is implied
   * (responseMimeType: "application/json") even if responseFormat is unset.
   * Supported on all Gemini 2.5+ models (pro / flash / flash-lite).
   */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  /**
   * Optional output cap. Defaults to GEMINI_MAX_OUTPUT_TOKENS (64k) — see the
   * constant's note on why the explicit max is required to avoid the lower
   * per-model default. A caller that declares a smaller budget (POST /complete
   * `maxTokens`) caps generation here too.
   */
  maxOutputTokens?: number;
  /**
   * Opt-in native Google Search grounding. When true, the request attaches the
   * `googleSearch` tool so Gemini answers from live web results instead of
   * parametric memory. Default (false/undefined) is byte-identical to a
   * non-grounded call. See POST /complete `webSearch`.
   */
  webSearch?: boolean;
  /**
   * Minimize internal thinking to the provider floor — see POST /complete
   * `disableThinking`. Gemini 2.5 → fully off; Gemini 3 → lowest level the gen
   * allows (no full-off exists). Default (false) keeps the bounded default.
   */
  disableThinking?: boolean;
}

/** A web source surfaced by native grounding/search (provider-agnostic shape). */
export interface WebSearchSource {
  url: string;
  title?: string;
}

interface GeminiCompleteResult {
  content: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  /** Number of Google Search queries the model ran (0 when grounding is off). */
  searchCount: number;
  /** Grounding source URLs surfaced via groundingMetadata (empty when off). */
  sources: WebSearchSource[];
}

interface GeminiImageGenerationOptions {
  apiKey: string;
  prompt: string;
  model?: string;
}

interface GeminiImageGenerationResult {
  imageBase64: string;
  mimeType: string;
  text: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

/**
 * Fetch an image from a URL and return base64-encoded data + MIME type.
 */
async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const IMAGE_FETCH_TIMEOUT_MS = 30_000;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `[chat-service] Image fetch timed out after ${IMAGE_FETCH_TIMEOUT_MS / 1000}s | url=${url}`,
      );
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`[chat-service] Failed to fetch image from ${url}: ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const buffer = await res.arrayBuffer();
  const data = Buffer.from(buffer).toString("base64");
  return { data, mimeType: contentType.split(";")[0].trim() };
}

/** Error thrown when the Gemini API returns a retryable HTTP status. */
class GeminiRetryableError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GeminiRetryableError";
  }
}

export class GeminiProviderError extends Error {
  constructor(
    public readonly status: number,
    public readonly upstreamBody: string,
    message: string,
  ) {
    super(message);
    this.name = "GeminiProviderError";
  }
}

/**
 * Single attempt to call the Gemini API. Throws GeminiRetryableError for
 * retryable status codes so the caller can decide whether to retry.
 */
async function callGeminiOnce(
  model: string,
  apiKey: string,
  body: Record<string, unknown>,
  jsonMode: boolean,
): Promise<GeminiCompleteResult> {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const timeoutMs = GEMINI_TIMEOUT_MS[model] ?? DEFAULT_GEMINI_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new GeminiRetryableError(
        504,
        `[chat-service] Gemini API timed out after ${timeoutMs / 1000}s | model=${model}`,
      );
    }
    throw err;
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "unknown error");
    if (RETRYABLE_STATUS_CODES.has(res.status)) {
      throw new GeminiRetryableError(res.status, `[gemini] API error ${res.status}: ${errorText}`);
    }
    throw new Error(`[gemini] API error ${res.status}: ${errorText}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
      groundingMetadata?: {
        webSearchQueries?: string[];
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      };
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };

  const finishReason = data.candidates?.[0]?.finishReason;
  const tokensIn = data.usageMetadata?.promptTokenCount ?? 0;
  const tokensOut = data.usageMetadata?.candidatesTokenCount ?? 0;
  if (finishReason === "MAX_TOKENS") {
    const diag =
      `[gemini] MAX_TOKENS hit | model=${model}` +
      ` | tokensInput=${tokensIn}` +
      ` | tokensOutput=${tokensOut}` +
      ` | jsonMode=${jsonMode}`;
    // JSON mode: partial content is truncated JSON, so the strict JSON.parse in
    // /complete would throw a cryptic "Unterminated string". Fail loud here with
    // a clear cause instead. Text mode tolerates partial output, so return it
    // with a warning (preserves PR #132 behavior).
    if (jsonMode) {
      console.error(`${diag} — output truncated, failing loud`);
      throw new Error(`[gemini] Output truncated (MAX_TOKENS). ${diag}`);
    }
    console.warn(`${diag} — returning partial content`);
  }

  const content =
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? "";

  // Grounding metadata (present only when the googleSearch tool ran).
  const grounding = data.candidates?.[0]?.groundingMetadata;
  const searchCount = grounding?.webSearchQueries?.length ?? 0;
  const seen = new Set<string>();
  const sources: WebSearchSource[] = [];
  for (const chunk of grounding?.groundingChunks ?? []) {
    const uri = chunk.web?.uri;
    if (typeof uri === "string" && uri.length > 0 && !seen.has(uri)) {
      seen.add(uri);
      sources.push({ url: uri, title: chunk.web?.title });
    }
  }

  return {
    content,
    tokensInput: data.usageMetadata?.promptTokenCount ?? 0,
    tokensOutput: data.usageMetadata?.candidatesTokenCount ?? 0,
    model,
    searchCount,
    sources,
  };
}

export async function generateImageWithGemini(
  options: GeminiImageGenerationOptions,
): Promise<GeminiImageGenerationResult> {
  const model = options.model ?? GEMINI_IMAGE_MODEL;
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`;
  const timeoutMs = GEMINI_TIMEOUT_MS[model] ?? DEFAULT_GEMINI_TIMEOUT_MS;
  const body = {
    contents: [{ parts: [{ text: options.prompt }] }],
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new GeminiRetryableError(
        504,
        `[chat-service] Gemini image generation timed out after ${timeoutMs / 1000}s | model=${model}`,
      );
    }
    throw err;
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "unknown error");
    throw new GeminiProviderError(
      res.status,
      errorText,
      `[gemini-image] API error ${res.status}: ${errorText}`,
    );
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          inlineData?: { mimeType?: string; data?: string };
          inline_data?: { mime_type?: string; data?: string };
        }>;
      };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
  const inlineData = imagePart?.inlineData;
  const inlineDataSnake = imagePart?.inline_data;
  const imageBase64 = inlineData?.data ?? inlineDataSnake?.data;
  if (!imageBase64) {
    const finishReason = data.candidates?.[0]?.finishReason ?? "unknown";
    const text = parts.map((part) => part.text ?? "").join("").trim();
    throw new GeminiProviderError(
      502,
      JSON.stringify({ finishReason, text }),
      `[gemini-image] Gemini response did not include image data | model=${model} | finishReason=${finishReason}`,
    );
  }

  return {
    imageBase64,
    mimeType: inlineData?.mimeType ?? inlineDataSnake?.mime_type ?? "image/png",
    text: parts.map((part) => part.text ?? "").join("").trim(),
    tokensInput: data.usageMetadata?.promptTokenCount ?? 0,
    tokensOutput: data.usageMetadata?.candidatesTokenCount ?? 0,
    model,
  };
}

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * JSON Schema keywords Gemini's OpenAPI 3.0 subset rejects with HTTP 400
 * (`Unknown name "<field>" at 'generation_config.response_schema'`). Stripped
 * recursively from caller-supplied `responseSchema` before forwarding to the
 * Gemini API. The caller's object is not mutated — a new object is returned.
 */
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "patternProperties",
  "dependentRequired",
  "dependentSchemas",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "$comment",
  "definitions",
  "if",
  "then",
  "else",
  "not",
  "const",
  "examples",
  "default",
  "readOnly",
  "writeOnly",
  "contentEncoding",
  "contentMediaType",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

function sanitizeGeminiSchemaInner(value: unknown, removed: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGeminiSchemaInner(item, removed));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) {
      removed.add(key);
      continue;
    }
    out[key] = sanitizeGeminiSchemaInner(val, removed);
  }
  return out;
}

export function sanitizeGeminiSchema(
  schema: Record<string, unknown>,
): { schema: Record<string, unknown>; removed: string[] } {
  const removed = new Set<string>();
  const sanitized = sanitizeGeminiSchemaInner(schema, removed) as Record<string, unknown>;
  return { schema: sanitized, removed: Array.from(removed) };
}

/**
 * Compute delay for exponential backoff with jitter.
 * delay = min(base * 2^attempt, max) + random jitter [0, 500ms]
 */
function retryDelay(attempt: number): number {
  const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jitter = Math.random() * 500;
  return exponential + jitter;
}

/**
 * Non-streaming completion via the Gemini REST API.
 * Supports multimodal (text + image) input.
 *
 * Retry strategy: up to 3 retries with exponential backoff on retryable errors
 * (429, 500, 503, 504, timeout). If all retries fail, falls back to the stable
 * Gemini 2.5 equivalent model for one final attempt.
 */
export async function completeWithGemini(options: GeminiCompleteOptions): Promise<GeminiCompleteResult> {
  const {
    apiKey,
    model,
    message,
    systemPrompt,
    imageUrl,
    imageContext,
    responseFormat,
    responseSchema,
    temperature,
    maxOutputTokens,
    webSearch,
    disableThinking,
  } = options;

  // Passing a responseSchema implies JSON mode regardless of responseFormat.
  const jsonMode = responseFormat === "json" || responseSchema != null;

  // Build content parts — inject image metadata into the text if provided
  let textContent = message;
  if (imageContext && (imageContext.alt || imageContext.title || imageContext.sourceUrl)) {
    const metaLines: string[] = [];
    if (imageContext.alt) metaLines.push(`Alt text: ${imageContext.alt}`);
    if (imageContext.title) metaLines.push(`Title: ${imageContext.title}`);
    if (imageContext.sourceUrl) metaLines.push(`Source page: ${imageContext.sourceUrl}`);
    textContent = `${message}\n\nImage metadata:\n${metaLines.join("\n")}`;
  }
  const parts: Array<Record<string, unknown>> = [{ text: textContent }];

  if (imageUrl) {
    const image = await fetchImageAsBase64(imageUrl);
    parts.push({
      inline_data: {
        mime_type: image.mimeType,
        data: image.data,
      },
    });
  }

  // Sanitize caller-supplied JSON Schema for Gemini's OpenAPI 3.0 subset.
  // Gemini rejects unknown fields (e.g. `additionalProperties`, `$schema`,
  // `$ref`) with HTTP 400. Stripping them lets Zod/JSON-Schema-7 schemas pass
  // through without forcing every caller to maintain a Gemini-only variant.
  let sanitizedSchema: Record<string, unknown> | undefined;
  if (responseSchema != null) {
    const result = sanitizeGeminiSchema(responseSchema);
    sanitizedSchema = result.schema;
    if (result.removed.length > 0) {
      console.warn(
        `[chat-service] Gemini schema sanitized | model=${model}` +
        ` | removed=${result.removed.join(",")}`,
      );
    }
  }

  // FLOOR Gemini-3 thinking on /complete. /complete is extraction / scoring /
  // structured-output — it never needs deep chain-of-thought, and Gemini 3.5
  // Flash FLAKES on large structured outputs when any meaningful thinking is on:
  // thinking + the schema-constrained decode exhaust the 64k budget before the
  // JSON is emitted → finishReason MAX_TOKENS at ~8 output tokens (or MALFORMED).
  // This is a known model bug (googleapis/js-genai#1619). thinkingLevel "low"
  // (the /chat default) is NOT low enough for gemini-3.5-flash here and failed
  // DETERMINISTICALLY in prod on a 17-field extraction (#316 follow-up). So drop
  // Gemini 3 to its floor ("minimal" Flash / "low" Pro) on this path, freeing the
  // whole budget for the structured decode. Gemini 2.5 keeps a small budget
  // unless `disableThinking` zeroes it. /chat is unaffected (it keeps "low" for
  // tool-calling and does not call completeWithGemini).
  const minimizeThinking = disableThinking || model.startsWith("gemini-3");

  // Build request body. When webSearch is on, attach the native googleSearch
  // grounding tool so Gemini answers from live web results. Omitted entirely
  // when off, keeping non-grounded requests byte-identical.
  const body: Record<string, unknown> = {
    contents: [{ parts }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      maxOutputTokens: maxOutputTokens ?? GEMINI_MAX_OUTPUT_TOKENS,
      thinkingConfig: buildThinkingConfig(model, minimizeThinking),
      ...(temperature != null ? { temperature } : {}),
      ...(jsonMode ? { responseMimeType: "application/json" } : {}),
      ...(sanitizedSchema != null ? { responseSchema: sanitizedSchema } : {}),
    },
    ...(webSearch ? { tools: [{ googleSearch: {} }] } : {}),
  };

  // --- Retry loop on the primary model ---
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = retryDelay(attempt - 1);
      console.warn(
        `[chat-service] Gemini retry ${attempt}/${MAX_RETRIES} after ${Math.round(delay)}ms | model=${model}`,
      );
      await sleep(delay);
    }
    try {
      return await callGeminiOnce(model, apiKey, body, jsonMode);
    } catch (err: unknown) {
      if (err instanceof GeminiRetryableError) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  // --- All retries exhausted — try fallback model ---
  const fallbackModel = GEMINI_FALLBACK_MODEL[model];
  if (fallbackModel) {
    console.warn(
      `[chat-service] All ${MAX_RETRIES} retries failed for ${model}, falling back to ${fallbackModel} | lastError=${lastError?.message}`,
    );
    return await callGeminiOnce(fallbackModel, apiKey, body, jsonMode);
  }

  // No fallback available — re-throw the last error
  throw lastError;
}
