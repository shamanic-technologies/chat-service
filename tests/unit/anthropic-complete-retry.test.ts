import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Regression: createAnthropicClient().complete() must retry transient Anthropic
 * errors (overloaded_error, 429, 5xx) before surfacing a failure. Prod incident
 * 2026-06-02: a mid-stream `overloaded_error` (HTTP 529, status undefined) on
 * POST /complete became an immediate 502 because this path — unlike /chat
 * streaming and the Gemini client — had NO retry. complete() is non-streaming
 * from the caller's view, so the whole call is always safe to retry.
 */

// mockStream stands in for client.messages.stream. Each call returns an object
// with a finalMessage() we control per-attempt. vi.hoisted so the mock factory
// (hoisted above imports) can close over it.
const { mockStream } = vi.hoisted(() => ({ mockStream: vi.fn() }));

vi.mock("@anthropic-ai/sdk", async (importActual) => {
  const actual = await importActual<typeof import("@anthropic-ai/sdk")>();
  const Real = actual.default;
  class MockAnthropic {
    messages = { stream: mockStream };
    // Preserve the real APIError so `err instanceof Anthropic.APIError` (in the
    // source's isRetryableAnthropicError) and our test constructors both work.
    static APIError = Real.APIError;
  }
  return { ...actual, default: MockAnthropic };
});

const { createAnthropicClient } = await import("../../src/lib/anthropic.js");

const okMessage = {
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: "end_turn",
};

/** Mid-stream overloaded error: status undefined, signal in the SSE body. */
function overloadedError(): Anthropic.APIError {
  return new Anthropic.APIError(
    undefined,
    { type: "error", error: { details: null, type: "overloaded_error", message: "Overloaded" } },
    "Overloaded",
    new Headers(),
  );
}

/** Non-retryable 400 — must NOT be retried. */
function badRequestError(): Anthropic.APIError {
  return Anthropic.APIError.generate(
    400,
    { type: "error", error: { type: "invalid_request_error", message: "Bad request" } },
    "Bad request",
    new Headers(),
  );
}

const streamReturning = (finalMessage: () => Promise<unknown>) => ({ finalMessage });

/** Run complete() and drain fake-timer backoff so retries resolve without real waits. */
async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {}); // swallow — caller asserts via expect/rejects
  await vi.runAllTimersAsync();
  return promise;
}

describe("anthropic complete() transient-error retry", () => {
  beforeEach(() => {
    mockStream.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries on overloaded_error then succeeds on the 3rd attempt", async () => {
    mockStream
      .mockReturnValueOnce(streamReturning(() => Promise.reject(overloadedError())))
      .mockReturnValueOnce(streamReturning(() => Promise.reject(overloadedError())))
      .mockReturnValueOnce(streamReturning(() => Promise.resolve(okMessage)));

    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "test" });
    const result = await runWithTimers(claude.complete("Hello"));

    expect(result.content).toBe("ok");
    expect(result.tokensInput).toBe(10);
    expect(result.tokensOutput).toBe(5);
    expect(mockStream).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("propagates the error after retries are exhausted", async () => {
    mockStream.mockReturnValue(streamReturning(() => Promise.reject(overloadedError())));

    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "test" });
    await expect(runWithTimers(claude.complete("Hello"))).rejects.toThrow();

    expect(mockStream).toHaveBeenCalledTimes(3); // 1 initial + 2 retries, then give up
  });

  it("does NOT retry a non-retryable error (400) — fails fast", async () => {
    mockStream.mockReturnValue(streamReturning(() => Promise.reject(badRequestError())));

    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "test" });
    await expect(runWithTimers(claude.complete("Hello"))).rejects.toThrow();

    expect(mockStream).toHaveBeenCalledTimes(1); // no retry
  });

  it("does NOT retry when the first attempt succeeds", async () => {
    mockStream.mockReturnValueOnce(streamReturning(() => Promise.resolve(okMessage)));

    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "test" });
    const result = await runWithTimers(claude.complete("Hello"));

    expect(result.content).toBe("ok");
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});
