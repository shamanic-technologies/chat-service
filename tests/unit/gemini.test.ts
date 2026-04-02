import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { completeWithGemini } from "../../src/lib/gemini.js";

describe("completeWithGemini", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseOptions = {
    apiKey: "test-key",
    model: "gemini-3-flash-preview",
    message: "Return URLs as JSON",
    systemPrompt: "You are helpful.",
    responseFormat: "json" as const,
  };

  it("throws when finishReason is MAX_TOKENS in JSON mode (truncated output)", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: '["https://example.com", "https://truncat' }] },
            finishReason: "MAX_TOKENS",
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 500 },
      }),
    });

    await expect(completeWithGemini(baseOptions)).rejects.toThrow(
      /Output truncated.*max output token limit/,
    );
  });

  it("returns partial content when finishReason is MAX_TOKENS in non-JSON mode", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: "Here are the top outlets for your campaign: 1. TechCrun" }] },
            finishReason: "MAX_TOKENS",
          },
        ],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 1000 },
      }),
    });

    const result = await completeWithGemini({
      ...baseOptions,
      responseFormat: undefined,
    });

    expect(result.content).toBe("Here are the top outlets for your campaign: 1. TechCrun");
    expect(result.tokensInput).toBe(200);
    expect(result.tokensOutput).toBe(1000);
  });

  it("returns content when finishReason is STOP (normal completion)", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: '["https://example.com"]' }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      }),
    });

    const result = await completeWithGemini(baseOptions);
    expect(result.content).toBe('["https://example.com"]');
    expect(result.tokensInput).toBe(100);
    expect(result.tokensOutput).toBe(50);
  });

  it("sends maxOutputTokens: 64000 by default when client omits maxTokens", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    });

    await completeWithGemini(baseOptions);

    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.maxOutputTokens).toBe(64_000);
  });

  it("disables thinking via thinkingConfig.thinkingBudget: 0", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    });

    await completeWithGemini(baseOptions);

    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("uses client-provided maxTokens when specified", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    });

    await completeWithGemini({ ...baseOptions, maxTokens: 1000 });

    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.maxOutputTokens).toBe(1000);
  });
});
