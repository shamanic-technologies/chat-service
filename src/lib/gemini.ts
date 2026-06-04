// ---------------------------------------------------------------------------
// Gemini REST API client — lightweight, no SDK dependency
// Used by POST /complete for vision tasks (gemini-3.1-flash-lite)
// ---------------------------------------------------------------------------

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

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
   * Opt-in native Google Search grounding. When true, the request attaches the
   * `googleSearch` tool so Gemini answers from live web results instead of
   * parametric memory. Default (false/undefined) is byte-identical to a
   * non-grounded call. See POST /complete `webSearch`.
   */
  webSearch?: boolean;
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
    webSearch,
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

  // Build request body. When webSearch is on, attach the native googleSearch
  // grounding tool so Gemini answers from live web results. Omitted entirely
  // when off, keeping non-grounded requests byte-identical.
  const body: Record<string, unknown> = {
    contents: [{ parts }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
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
