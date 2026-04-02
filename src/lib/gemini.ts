// ---------------------------------------------------------------------------
// Gemini REST API client — lightweight, no SDK dependency
// Used by POST /complete for vision tasks (gemini-3.1-flash-lite-preview)
// ---------------------------------------------------------------------------

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const GEMINI_MODELS: Record<string, string> = {
  "gemini-3.1-flash-lite-preview": "google-flash-lite-3.1",
  "gemini-3-flash-preview": "google-flash-3",
  "gemini-3.1-pro-preview": "google-pro-3.1",
};

/** Model-specific API timeouts in milliseconds. */
const GEMINI_TIMEOUT_MS: Record<string, number> = {
  "gemini-3.1-pro-preview": 15 * 60_000,       // 15 min — Pro
  "gemini-3-flash-preview": 10 * 60_000,        // 10 min — Flash
  "gemini-3.1-flash-lite-preview": 5 * 60_000,  //  5 min — Flash Lite
};
const DEFAULT_GEMINI_TIMEOUT_MS = 10 * 60_000;  // 10 min fallback

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

/**
 * Non-streaming completion via the Gemini REST API.
 * Supports multimodal (text + image) input.
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
      throw new Error(
        `[chat-service] Gemini API timed out after ${timeoutMs / 1000}s | model=${model}`,
      );
    }
    throw err;
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "unknown error");
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
