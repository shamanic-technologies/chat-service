import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
// isRetryableAnthropicError + getRetryAfterMs are the real implementations,
// imported from the module they now live in (shared by /chat streaming and
// complete()). No inlined copy — testing the actual code prevents drift.
import { isRetryableAnthropicError, getRetryAfterMs } from "../../src/lib/anthropic.js";

/**
 * Inline classifyErrorForClient from src/index.ts (SSE-client-specific; stays in
 * index.ts, which has server side-effects that make it unimportable here).
 */
function classifyErrorForClient(err: unknown): { message: string; code: string } {
  if (err instanceof Anthropic.APIError) {
    const errorBody = err.error as { type?: string; error?: { type?: string } } | undefined;
    const errorType = errorBody?.error?.type;
    if (errorType === "overloaded_error" || err.status === 529) {
      return {
        code: "model_overloaded",
        message: "Claude is temporarily overloaded. Please try again in a moment.",
      };
    }
    if (err.status === 429) {
      return {
        code: "rate_limited",
        message: "Too many requests. Please wait a moment and try again.",
      };
    }
    if (typeof err.status === "number" && err.status >= 500) {
      return {
        code: "model_error",
        message: "Claude encountered a temporary error. Please try again.",
      };
    }
  }
  return {
    code: "internal_error",
    message: "An unexpected error occurred. Please try again.",
  };
}

describe("isRetryableAnthropicError", () => {
  it("returns true for overloaded_error with undefined status (streaming SSE error)", () => {
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

describe("getRetryAfterMs", () => {
  it("parses retry-after header in seconds and converts to ms", () => {
    const headers = new Headers({ "retry-after": "5" });
    const err = new Anthropic.APIError(429, {}, "Rate limited", headers);
    expect(getRetryAfterMs(err)).toBe(5000);
  });

  it("returns null when header is missing", () => {
    const err = new Anthropic.APIError(429, {}, "Rate limited", new Headers());
    expect(getRetryAfterMs(err)).toBeNull();
  });

  it("returns null for non-numeric header value", () => {
    const headers = new Headers({ "retry-after": "not-a-number" });
    const err = new Anthropic.APIError(429, {}, "Rate limited", headers);
    expect(getRetryAfterMs(err)).toBeNull();
  });

  it("returns null for zero or negative values", () => {
    const headers = new Headers({ "retry-after": "0" });
    const err = new Anthropic.APIError(429, {}, "Rate limited", headers);
    expect(getRetryAfterMs(err)).toBeNull();

    const headers2 = new Headers({ "retry-after": "-1" });
    const err2 = new Anthropic.APIError(429, {}, "Rate limited", headers2);
    expect(getRetryAfterMs(err2)).toBeNull();
  });

  it("returns null for non-Anthropic errors", () => {
    expect(getRetryAfterMs(new Error("random"))).toBeNull();
  });

  it("returns null when error has no headers", () => {
    // Streaming errors: new APIError(undefined, body, undefined, headers)
    // but headers could theoretically be undefined
    const err = new Anthropic.APIError(undefined, {}, undefined, undefined as unknown as Headers);
    expect(getRetryAfterMs(err)).toBeNull();
  });
});

describe("classifyErrorForClient", () => {
  it("returns model_overloaded for streaming overloaded_error", () => {
    const err = new Anthropic.APIError(
      undefined,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      undefined,
      new Headers(),
    );
    const result = classifyErrorForClient(err);
    expect(result.code).toBe("model_overloaded");
    expect(result.message).toContain("overloaded");
  });

  it("returns model_overloaded for HTTP 529", () => {
    const err = Anthropic.APIError.generate(
      529,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      "Overloaded",
      new Headers(),
    );
    const result = classifyErrorForClient(err);
    expect(result.code).toBe("model_overloaded");
  });

  it("returns rate_limited for 429", () => {
    const err = Anthropic.APIError.generate(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
      "Rate limited",
      new Headers(),
    );
    const result = classifyErrorForClient(err);
    expect(result.code).toBe("rate_limited");
    expect(result.message).toContain("Too many requests");
  });

  it("returns model_error for 500", () => {
    const err = Anthropic.APIError.generate(
      500,
      { type: "error", error: { type: "api_error", message: "Internal" } },
      "Internal",
      new Headers(),
    );
    const result = classifyErrorForClient(err);
    expect(result.code).toBe("model_error");
  });

  it("returns internal_error for non-Anthropic errors", () => {
    const result = classifyErrorForClient(new Error("something broke"));
    expect(result.code).toBe("internal_error");
    expect(result.message).toContain("unexpected");
  });

  it("returns internal_error for 400 bad request (not retryable)", () => {
    const err = Anthropic.APIError.generate(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "Bad" } },
      "Bad",
      new Headers(),
    );
    const result = classifyErrorForClient(err);
    expect(result.code).toBe("internal_error");
  });
});
