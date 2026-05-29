import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function loadModule() {
  vi.resetModules();
  return import("../../src/lib/embeddings.js");
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", async () => {
    const { cosineSimilarity } = await loadModule();
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", async () => {
    const { cosineSimilarity } = await loadModule();
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposite vectors", async () => {
    const { cosineSimilarity } = await loadModule();
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it("returns 0 when either vector is zero", async () => {
    const { cosineSimilarity } = await loadModule();
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("ranks documents by similarity to a query vector", async () => {
    const { cosineSimilarity } = await loadModule();
    const query = [1, 0, 0];
    const docs = [
      [0, 1, 0], // orthogonal
      [0.9, 0.1, 0], // close
      [-1, 0, 0], // opposite
    ];
    const scores = docs.map((d) => cosineSimilarity(query, d));
    expect(scores[1]).toBeGreaterThan(scores[0]);
    expect(scores[0]).toBeGreaterThan(scores[2]);
  });

  it("throws on length mismatch", async () => {
    const { cosineSimilarity } = await loadModule();
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/length mismatch/);
  });
});

describe("contentHash", () => {
  it("is deterministic for the same input", async () => {
    const { contentHash } = await loadModule();
    const h1 = contentHash({ industry: "SaaS", voice: "data-driven" });
    const h2 = contentHash({ industry: "SaaS", voice: "data-driven" });
    expect(h1).toBe(h2);
  });

  it("is order-independent across keys", async () => {
    const { contentHash } = await loadModule();
    const h1 = contentHash({ industry: "SaaS", voice: "data-driven" });
    const h2 = contentHash({ voice: "data-driven", industry: "SaaS" });
    expect(h1).toBe(h2);
  });

  it("changes when any value changes", async () => {
    const { contentHash } = await loadModule();
    const h1 = contentHash({ industry: "SaaS", voice: "data-driven" });
    const h2 = contentHash({ industry: "SaaS", voice: "founder-led" });
    expect(h1).not.toBe(h2);
  });

  it("changes when a key is added or removed", async () => {
    const { contentHash } = await loadModule();
    const h1 = contentHash({ industry: "SaaS" });
    const h2 = contentHash({ industry: "SaaS", expertise: "pricing" });
    expect(h1).not.toBe(h2);
  });

  it("returns hex sha256 (64 chars)", async () => {
    const { contentHash } = await loadModule();
    const h = contentHash({ a: "b" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("embedTexts", () => {
  it("posts to batchEmbedContents with correct shape", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          embeddings: [
            { values: [0.1, 0.2, 0.3] },
            { values: [0.4, 0.5, 0.6] },
          ],
        }),
    });

    const { embedTexts } = await loadModule();
    const vecs = await embedTexts("test-key", ["hello", "world"], "gemini-embedding-001");

    expect(vecs).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url: string = call[0];
    const init = call[1] as RequestInit;
    expect(url).toContain(
      "/v1beta/models/gemini-embedding-001:batchEmbedContents",
    );
    expect(url).toContain("key=test-key");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      requests: [
        { model: "models/gemini-embedding-001", content: { parts: [{ text: "hello" }] } },
        { model: "models/gemini-embedding-001", content: { parts: [{ text: "world" }] } },
      ],
    });
  });

  it("returns empty array for empty input without calling fetch", async () => {
    const { embedTexts } = await loadModule();
    const vecs = await embedTexts("test-key", []);
    expect(vecs).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on non-retryable HTTP error (e.g. 400)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("bad request"),
    });

    const { embedTexts } = await loadModule();
    await expect(embedTexts("test-key", ["x"])).rejects.toThrow(/Gemini API error 400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws when embeddings count differs from input count", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [{ values: [0.1] }] }),
    });

    const { embedTexts } = await loadModule();
    await expect(embedTexts("test-key", ["a", "b"])).rejects.toThrow(
      /returned 1 embeddings for 2 inputs/,
    );
  });

  it("throws when any embedding is empty", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [{ values: [] }] }),
    });

    const { embedTexts } = await loadModule();
    await expect(embedTexts("test-key", ["a"])).rejects.toThrow(/empty embedding/);
  });
});

describe("embeddingCostPrefix", () => {
  it("normalizes gemini-embedding-001 to the costs-service catalog name", async () => {
    const { embeddingCostPrefix } = await loadModule();
    // Producer cost name must be byte-equal to the costs-service catalog row,
    // which follows the google-* convention (google-flash-3, google-pro-3.1).
    expect(embeddingCostPrefix("gemini-embedding-001")).toBe("google-embedding-001");
  });

  it("throws on an unmapped model instead of emitting an unmatched cost name", async () => {
    const { embeddingCostPrefix } = await loadModule();
    expect(() => embeddingCostPrefix("text-embedding-004")).toThrow(
      /no cost-name prefix mapped/,
    );
  });
});

describe("estimateTokens", () => {
  it("approximates at ~4 chars per token (ceil)", async () => {
    const { estimateTokens } = await loadModule();
    expect(estimateTokens(["abcd"])).toBe(1); // 4 chars / 4
    expect(estimateTokens(["a".repeat(10)])).toBe(3); // ceil(10 / 4)
  });

  it("sums across multiple texts", async () => {
    const { estimateTokens } = await loadModule();
    expect(estimateTokens(["ab", "cd"])).toBe(1); // 4 chars total / 4
    expect(estimateTokens(["a".repeat(6), "b".repeat(6)])).toBe(3); // ceil(12 / 4)
  });

  it("returns 0 for empty input", async () => {
    const { estimateTokens } = await loadModule();
    expect(estimateTokens([])).toBe(0);
    expect(estimateTokens(["", ""])).toBe(0);
  });
});
