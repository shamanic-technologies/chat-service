import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { completeWithGemini } from "../../src/lib/gemini.js";

// Native Google Search grounding on completeWithGemini: the googleSearch tool is
// attached only when webSearch is true, and groundingMetadata is parsed into a
// search-query count + deduped source URLs. webSearch off must be byte-identical.

describe("completeWithGemini — native web search", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const base = {
    apiKey: "test-key",
    model: "gemini-3-flash-preview",
    message: "who won the match?",
    systemPrompt: "Be brief.",
  };

  const grounded = {
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: { parts: [{ text: "Team A won." }] },
          finishReason: "STOP",
          groundingMetadata: {
            webSearchQueries: ["who won the match", "match result"],
            groundingChunks: [
              { web: { uri: "https://news.example/a", title: "News A" } },
              { web: { uri: "https://news.example/a", title: "News A" } }, // dup
              { web: { uri: "https://news.example/b", title: "News B" } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
    }),
  };

  const ungrounded = {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
  };

  it("attaches the googleSearch tool only when webSearch is true", async () => {
    fetchSpy.mockResolvedValueOnce(grounded);
    await completeWithGemini({ ...base, webSearch: true });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.tools).toEqual([{ googleSearch: {} }]);
  });

  it("omits tools entirely when webSearch is off (byte-identical request)", async () => {
    fetchSpy.mockResolvedValueOnce(ungrounded);
    await completeWithGemini({ ...base });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });

  it("parses searchCount + deduped sources from groundingMetadata", async () => {
    fetchSpy.mockResolvedValueOnce(grounded);
    const r = await completeWithGemini({ ...base, webSearch: true });
    expect(r.searchCount).toBe(2);
    expect(r.sources).toEqual([
      { url: "https://news.example/a", title: "News A" },
      { url: "https://news.example/b", title: "News B" },
    ]);
    expect(r.content).toBe("Team A won.");
  });

  it("returns searchCount 0 and empty sources when no grounding metadata is present", async () => {
    fetchSpy.mockResolvedValueOnce(ungrounded);
    const r = await completeWithGemini({ ...base });
    expect(r.searchCount).toBe(0);
    expect(r.sources).toEqual([]);
  });
});
