// ---------------------------------------------------------------------------
// Gemini embeddings client + cosine similarity utilities.
// Used by POST /orgs/rag/score for RAG-style semantic similarity scoring.
// ---------------------------------------------------------------------------

import crypto from "crypto";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Default Gemini text embedding model. Override per call if needed. */
export const DEFAULT_EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";

/** Cost-name prefix used for billing the embedding model. */
export function embeddingCostPrefix(model: string): string {
  return model;
}

/** HTTP timeout for a single embedding call in ms. */
const EMBEDDING_TIMEOUT_MS = 30_000;

/** HTTP statuses that warrant a retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503, 504]);

/** Max retries before giving up. */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff. */
const RETRY_BASE_DELAY_MS = 1_000;

/** Max delay cap. */
const RETRY_MAX_DELAY_MS = 15_000;

class EmbeddingRetryableError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EmbeddingRetryableError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return exponential + Math.random() * 250;
}

interface BatchEmbedResponseBody {
  embeddings?: Array<{ values?: number[] }>;
  error?: { message?: string };
}

async function callBatchEmbedOnce(
  model: string,
  apiKey: string,
  texts: string[],
): Promise<number[][]> {
  const url =
    `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:batchEmbedContents` +
    `?key=${encodeURIComponent(apiKey)}`;

  const requests = texts.map((text) => ({
    model: `models/${model}`,
    content: { parts: [{ text }] },
  }));

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new EmbeddingRetryableError(
        504,
        `[embeddings] Gemini batchEmbedContents timed out after ${EMBEDDING_TIMEOUT_MS / 1000}s | model=${model}`,
      );
    }
    throw err;
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "unknown error");
    if (RETRYABLE_STATUS_CODES.has(res.status)) {
      throw new EmbeddingRetryableError(
        res.status,
        `[embeddings] Gemini API error ${res.status}: ${errorText}`,
      );
    }
    throw new Error(`[embeddings] Gemini API error ${res.status}: ${errorText}`);
  }

  const data = (await res.json()) as BatchEmbedResponseBody;
  const embeddings = data.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error(
      `[embeddings] Gemini returned ${embeddings?.length ?? 0} embeddings for ${texts.length} inputs`,
    );
  }

  return embeddings.map((e, i) => {
    const v = e.values;
    if (!Array.isArray(v) || v.length === 0) {
      throw new Error(`[embeddings] empty embedding at index ${i}`);
    }
    return v;
  });
}

/**
 * Batch-embed a list of text inputs via Gemini's batchEmbedContents endpoint.
 * Retries on transient errors (429, 500, 503, 504, timeout) with exponential backoff.
 */
export async function embedTexts(
  apiKey: string,
  texts: string[],
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = retryDelay(attempt - 1);
      console.warn(
        `[chat-service] Gemini embed retry ${attempt}/${MAX_RETRIES} after ${Math.round(delay)}ms | model=${model}`,
      );
      await sleep(delay);
    }
    try {
      return await callBatchEmbedOnce(model, apiKey, texts);
    } catch (err: unknown) {
      if (err instanceof EmbeddingRetryableError) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/** Embed a single text input. Convenience wrapper around `embedTexts`. */
export async function embedText(
  apiKey: string,
  text: string,
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<number[]> {
  const [vec] = await embedTexts(apiKey, [text], model);
  return vec;
}

/**
 * Cosine similarity between two equal-length vectors.
 * Returns a value in [-1, 1] (typically [0, 1] for normalized embeddings).
 * Returns 0 when either vector is the zero vector.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`[embeddings] cosineSimilarity: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Stable content hash of a key/value map. Keys are sorted lexicographically
 * before hashing so the result is order-independent.
 *
 * Used to key the brand-profile embedding cache so that any change to the
 * resolved brand fields (industry, expertise, target audience, voice, ...)
 * invalidates the cached embedding.
 */
export function contentHash(fields: Record<string, unknown>): string {
  const sortedKeys = Object.keys(fields).sort();
  const canonical = JSON.stringify(sortedKeys.map((k) => [k, fields[k]]));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
