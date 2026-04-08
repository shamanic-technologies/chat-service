import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Inline the isRetryableAnthropicError logic from src/index.ts for unit testing.
 * Mirrors the actual implementation.
 */
function isRetryableAnthropicError(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  const errorBody = err.error as { type?: string; error?: { type?: string } } | undefined;
  if (errorBody?.error?.type === "overloaded_error") return true;
  if (typeof err.status === "number" && [429, 500, 503, 529].includes(err.status)) return true;
  return false;
}

describe("isRetryableAnthropicError", () => {
  it("returns true for overloaded_error with undefined status (streaming SSE error)", () => {
    // During streaming, the SDK calls `new APIError(undefined, parsedBody, undefined, headers)` directly.
    // This is the exact shape from the production logs.
    const err = new Anthropic.APIError(
      undefined,
      {
        type: "error",
        error: { details: null, type: "overloaded_error", message: "Overloaded" },
      },
      undefined,
      new Headers(),
    );
    expect(err.status).toBeUndefined();
    expect(isRetryableAnthropicError(err)).toBe(true);
  });

  it("returns true for 429 rate limit error", () => {
    const err = Anthropic.APIError.generate(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
      "Rate limited",
      new Headers(),
    );
    expect(isRetryableAnthropicError(err)).toBe(true);
  });

  it("returns true for 500 internal server error", () => {
    const err = Anthropic.APIError.generate(
      500,
      { type: "error", error: { type: "api_error", message: "Internal error" } },
      "Internal error",
      new Headers(),
    );
    expect(isRetryableAnthropicError(err)).toBe(true);
  });

  it("returns true for 503 service unavailable", () => {
    const err = Anthropic.APIError.generate(
      503,
      { type: "error", error: { type: "api_error", message: "Unavailable" } },
      "Unavailable",
      new Headers(),
    );
    expect(isRetryableAnthropicError(err)).toBe(true);
  });

  it("returns true for 529 overloaded", () => {
    const err = Anthropic.APIError.generate(
      529,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      "Overloaded",
      new Headers(),
    );
    expect(isRetryableAnthropicError(err)).toBe(true);
  });

  it("returns false for 400 bad request", () => {
    const err = Anthropic.APIError.generate(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "Bad request" } },
      "Bad request",
      new Headers(),
    );
    expect(isRetryableAnthropicError(err)).toBe(false);
  });

  it("returns false for 401 authentication error", () => {
    const err = Anthropic.APIError.generate(
      401,
      { type: "error", error: { type: "authentication_error", message: "Invalid key" } },
      "Invalid key",
      new Headers(),
    );
    expect(isRetryableAnthropicError(err)).toBe(false);
  });

  it("returns false for non-Anthropic errors", () => {
    expect(isRetryableAnthropicError(new Error("random error"))).toBe(false);
    expect(isRetryableAnthropicError("string error")).toBe(false);
    expect(isRetryableAnthropicError(null)).toBe(false);
    expect(isRetryableAnthropicError(undefined)).toBe(false);
  });
});
