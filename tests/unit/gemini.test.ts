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

  it("returns partial content when finishReason is MAX_TOKENS in JSON mode (no throw)", async () => {
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

    const result = await completeWithGemini(baseOptions);
    expect(result.content).toBe('["https://example.com", "https://truncat');
    expect(result.tokensInput).toBe(100);
    expect(result.tokensOutput).toBe(500);
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

  it("does not send maxOutputTokens (API manages its own limits)", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    });

    await completeWithGemini(baseOptions);

    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.maxOutputTokens).toBeUndefined();
  });

  it("does not send thinkingConfig (thinking removed from API)", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    });

    await completeWithGemini(baseOptions);

    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("throws a clear timeout error when Gemini API times out", async () => {
    const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    fetchSpy.mockRejectedValueOnce(timeoutError);

    await expect(completeWithGemini(baseOptions)).rejects.toThrow(
      /Gemini API timed out after 120s/,
    );
  });

  it("passes AbortSignal.timeout to the Gemini fetch call", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    });

    await completeWithGemini(baseOptions);

    const fetchOptions = fetchSpy.mock.calls[0][1];
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("re-throws non-timeout fetch errors as-is", async () => {
    const networkError = new TypeError("fetch failed");
    fetchSpy.mockRejectedValueOnce(networkError);

    await expect(completeWithGemini(baseOptions)).rejects.toThrow("fetch failed");
  });
});
