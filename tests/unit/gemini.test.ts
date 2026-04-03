import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { completeWithGemini } from "../../src/lib/gemini.js";

describe("completeWithGemini", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseOptions = {
    apiKey: "test-key",
    model: "gemini-3-flash-preview",
    message: "Return URLs as JSON",
    systemPrompt: "You are helpful.",
    responseFormat: "json" as const,
  };

  const okResponse = (text = '["https://example.com"]', tokensIn = 100, tokensOut = 50) => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: tokensIn, candidatesTokenCount: tokensOut },
    }),
  });

  const errorResponse = (status: number, body = "overloaded") => ({
    ok: false,
    status,
    text: async () => body,
  });

  /** Run completeWithGemini and advance fake timers until it resolves. */
  async function runWithTimers(opts: Parameters<typeof completeWithGemini>[0]) {
    const promise = completeWithGemini(opts);
    // Prevent unhandled rejection warnings — caller will handle via .rejects
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    return promise;
  }

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

    const result = await runWithTimers(baseOptions);
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

    const result = await runWithTimers({ ...baseOptions, responseFormat: undefined });
    expect(result.content).toBe("Here are the top outlets for your campaign: 1. TechCrun");
    expect(result.tokensInput).toBe(200);
    expect(result.tokensOutput).toBe(1000);
  });

  it("returns content when finishReason is STOP (normal completion)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe('["https://example.com"]');
    expect(result.tokensInput).toBe(100);
    expect(result.tokensOutput).toBe(50);
  });

  it("does not send maxOutputTokens (API manages its own limits)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers(baseOptions);
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.maxOutputTokens).toBeUndefined();
  });

  it("does not send thinkingConfig (thinking removed from API)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers(baseOptions);
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("passes AbortSignal.timeout to the Gemini fetch call", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers(baseOptions);
    const fetchOptions = fetchSpy.mock.calls[0][1];
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("re-throws non-retryable fetch errors as-is", async () => {
    const networkError = new TypeError("fetch failed");
    fetchSpy.mockRejectedValueOnce(networkError);
    await expect(runWithTimers(baseOptions)).rejects.toThrow("fetch failed");
  });

  it("re-throws non-retryable HTTP errors (e.g. 400) without retrying", async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse(400, "bad request"));
    await expect(runWithTimers(baseOptions)).rejects.toThrow("[gemini] API error 400: bad request");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // --- Retry behavior ---

  it("retries on 503 and succeeds on second attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(okResponse("ok"));

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe("ok");
    expect(result.model).toBe("gemini-3-flash-preview");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 and succeeds on third attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(okResponse("ok"));

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("retries on 500 and succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(okResponse("recovered"));

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe("recovered");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on timeout (DOMException TimeoutError) and succeeds", async () => {
    const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    fetchSpy
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(okResponse("recovered"));

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe("recovered");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // --- Fallback behavior ---

  it("falls back to gemini-2.5-flash after all retries fail for flash-preview", async () => {
    // 1 initial + 3 retries = 4 calls on primary model, all 503
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      // fallback call succeeds
      .mockResolvedValueOnce(okResponse("fallback-ok"));

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe("fallback-ok");
    expect(result.model).toBe("gemini-2.5-flash");
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    const fallbackUrl = fetchSpy.mock.calls[4][0] as string;
    expect(fallbackUrl).toContain("gemini-2.5-flash");
  });

  it("falls back to gemini-2.5-pro after all retries fail for pro-preview", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(504))
      .mockResolvedValueOnce(errorResponse(504))
      .mockResolvedValueOnce(errorResponse(504))
      .mockResolvedValueOnce(errorResponse(504))
      .mockResolvedValueOnce(okResponse("pro-fallback"));

    const result = await runWithTimers({ ...baseOptions, model: "gemini-3.1-pro-preview" });
    expect(result.content).toBe("pro-fallback");
    expect(result.model).toBe("gemini-2.5-pro");
    const fallbackUrl = fetchSpy.mock.calls[4][0] as string;
    expect(fallbackUrl).toContain("gemini-2.5-pro");
  });

  it("falls back to gemini-2.5-flash after all retries fail for flash-lite-preview", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(okResponse("lite-fallback"));

    const result = await runWithTimers({ ...baseOptions, model: "gemini-3.1-flash-lite-preview" });
    expect(result.content).toBe("lite-fallback");
    expect(result.model).toBe("gemini-2.5-flash");
  });

  it("throws when fallback also fails", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503, "fallback also down"));

    await expect(runWithTimers(baseOptions)).rejects.toThrow(
      "[gemini] API error 503: fallback also down",
    );
  });

  it("throws when all retries fail and there is no fallback model", async () => {
    const unknownModel = "gemini-99-turbo-preview";
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503));

    await expect(
      runWithTimers({ ...baseOptions, model: unknownModel }),
    ).rejects.toThrow("[gemini] API error 503");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("retries on timeout then falls back after all retries exhausted", async () => {
    const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    fetchSpy
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(okResponse("timeout-fallback"));

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe("timeout-fallback");
    expect(result.model).toBe("gemini-2.5-flash");
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("logs a warning for each retry attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(okResponse("ok"));

    await runWithTimers(baseOptions);

    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((msg) => msg.includes("Gemini retry"));
    expect(warnCalls).toHaveLength(2);
    expect(warnCalls[0]).toMatch(/retry 1\/3/);
    expect(warnCalls[1]).toMatch(/retry 2\/3/);
  });

  it("logs a warning when falling back to stable model", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(okResponse("fallback"));

    await runWithTimers(baseOptions);

    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string);
    const fallbackWarn = warnCalls.find((msg) => msg.includes("falling back to"));
    expect(fallbackWarn).toBeDefined();
    expect(fallbackWarn).toContain("gemini-2.5-flash");
  });
});
