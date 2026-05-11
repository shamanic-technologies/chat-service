import { describe, it, expect, vi } from "vitest";

/**
 * Regression: Anthropic SDK rejects non-streaming requests when max_tokens
 * implies >10 min latency with `AnthropicError: Streaming is required for
 * operations that may take longer than 10 minutes`.
 *
 * complete() must use messages.stream().finalMessage() under the hood so it
 * never trips that pre-flight check.
 */

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: async () => {
          throw new Error(
            "Streaming is required for operations that may take longer than 10 minutes.",
          );
        },
        stream: () => ({
          finalMessage: async () => ({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "streamed ok" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        }),
      };
    },
  };
});

const { createAnthropicClient } = await import("../../src/lib/anthropic.js");

describe("anthropic complete() must use streaming transport", () => {
  it("resolves successfully even when messages.create would throw 'Streaming is required'", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "test" });
    const result = await claude.complete("Hello");

    expect(result.content).toBe("streamed ok");
    expect(result.tokensInput).toBe(10);
    expect(result.tokensOutput).toBe(5);
  });
});
