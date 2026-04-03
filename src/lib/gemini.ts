// ---------------------------------------------------------------------------
// Gemini REST API client — lightweight, no SDK dependency
// Used by POST /complete for vision tasks (gemini-3.1-flash-lite-preview)
// ---------------------------------------------------------------------------

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const GEMINI_MODELS: Record<string, string> = {
  "gemini-3.1-flash-lite-preview": "google-flash-lite-3.1",
  "gemini-3-flash-preview": "google-flash-3",
  "gemini-3.1-pro-preview": "google-pro-3.1",
  "gemini-2.5-pro": "google-pro-2.5",
  "gemini-2.5-flash": "google-flash-2.5",
};

/** Model-specific API timeouts in milliseconds. */
const GEMINI_TIMEOUT_MS: Record<string, number> = {
  "gemini-3.1-pro-preview": 15 * 60_000,       // 15 min — Pro
  "gemini-3-flash-preview": 10 * 60_000,        // 10 min — Flash
  "gemini-3.1-flash-lite-preview": 5 * 60_000,  //  5 min — Flash Lite
  "gemini-2.5-pro": 15 * 60_000,                // 15 min — 2.5 Pro
  "gemini-2.5-flash": 10 * 60_000,              // 10 min — 2.5 Flash
};
const DEFAULT_GEMINI_TIMEOUT_MS = 10 * 60_000;  // 10 min fallback

/** Fallback from preview 3.x models to stable 2.5 models. */
const GEMINI_FALLBACK_MODEL: Record<string, string> = {
  "gemini-3.1-pro-preview": "gemini-2.5-pro",
  "gemini-3-flash-preview": "gemini-2.5-flash",
  "gemini-3.1-flash-lite-preview": "gemini-2.5-flash",
};

/** HTTP status codes that warrant a retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503, 504]);

/** Max retries before falling back to the stable model. */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff in ms. */
const RETRY_BASE_DELAY_MS = 1_000;

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
  temperature?: number;
}

interface GeminiCompleteResult {
  content: string;
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

/**
 * Single attempt to call the Gemini API. Throws GeminiRetryableError for
 * retryable status codes so the caller can decide whether to retry.
 */
async function callGeminiOnce(
  model: string,
  apiKey: string,
  body: Record<string, unknown>,
  responseFormat: string | undefined,
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
    console.warn(
      `[gemini] MAX_TOKENS hit | model=${model}` +
      ` | tokensInput=${tokensIn}` +
      ` | tokensOutput=${tokensOut}` +
      ` | responseFormat=${responseFormat ?? "text"}` +
      ` — returning partial content`,
    );
  }

  const content =
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? "";

  return {
    content,
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
    temperature,
  } = options;

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

  // Build request body
  const body: Record<string, unknown> = {
    contents: [{ parts }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      ...(temperature != null ? { temperature } : {}),
      ...(responseFormat === "json" ? { responseMimeType: "application/json" } : {}),
    },
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
      return await callGeminiOnce(model, apiKey, body, responseFormat);
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
    return await callGeminiOnce(fallbackModel, apiKey, body, responseFormat);
  }

  // No fallback available — re-throw the last error
  throw lastError;
}
