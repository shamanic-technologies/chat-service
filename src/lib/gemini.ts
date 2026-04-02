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
  maxTokens?: number;
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
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[gemini] Failed to fetch image from ${url}: ${res.status} ${res.statusText}`);
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
    maxTokens,
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
  // Disable thinking (internal reasoning) — thinking tokens share the
  // maxOutputTokens budget and can consume it entirely, leaving nothing for
  // the actual response.  POST /complete is used for extraction tasks that
  // don't benefit from chain-of-thought reasoning.
  const body: Record<string, unknown> = {
    contents: [{ parts }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      ...(temperature != null ? { temperature } : {}),
      maxOutputTokens: maxTokens ?? 64_000,
      ...(responseFormat === "json" ? { responseMimeType: "application/json" } : {}),
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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
  const effectiveMax = maxTokens ?? 64_000;

  if (finishReason === "MAX_TOKENS") {
    const contentPreview = (data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "").join("") ?? "").slice(0, 300);
    const diag = [
      `[gemini] MAX_TOKENS hit`,
      `model=${model}`,
      `maxOutputTokens=${effectiveMax}`,
      `tokensInput=${tokensIn}`,
      `tokensOutput=${tokensOut}`,
      `responseFormat=${responseFormat ?? "text"}`,
      `systemPromptLen=${systemPrompt.length}`,
      `messageLen=${message.length}`,
      `contentPreview=${JSON.stringify(contentPreview)}`,
    ].join(" | ");

    if (responseFormat === "json") {
      console.error(diag);
      throw new Error(`[gemini] Output truncated (MAX_TOKENS). ${diag}`);
    }
    console.warn(`${diag} — returning partial content`);
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
