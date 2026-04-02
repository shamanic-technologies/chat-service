import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests that createAnthropicClient().complete() passes model-specific
 * timeout values to the Anthropic SDK request options.
 */

let capturedRequestOptions: Record<string, unknown> | undefined;

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: async (_params: Record<string, unknown>, options?: Record<string, unknown>) => {
          capturedRequestOptions = options;
          return {
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
          };
        },
        stream: () => {
          throw new Error("stream not implemented in mock");
        },
      };
    },
  };
});

const { createAnthropicClient } = await import("../../src/lib/anthropic.js");

describe("anthropic complete() model-specific timeouts", () => {
  beforeEach(() => {
    capturedRequestOptions = undefined;
  });

  it("uses 15 min timeout for opus", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "test" });
    await claude.complete("Hello", { model: "claude-opus-4-6" });

    expect(capturedRequestOptions).toBeDefined();
    expect(capturedRequestOptions!.timeout).toBe(15 * 60_000);
  });

  it("uses 10 min timeout for sonnet (default model)", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "test" });
    await claude.complete("Hello");

    expect(capturedRequestOptions).toBeDefined();
    expect(capturedRequestOptions!.timeout).toBe(10 * 60_000);
  });

  it("uses 5 min timeout for haiku", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "test" });
    await claude.complete("Hello", { model: "claude-haiku-4-5" });

    expect(capturedRequestOptions).toBeDefined();
    expect(capturedRequestOptions!.timeout).toBe(5 * 60_000);
  });

  it("falls back to 10 min for unknown models", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "test" });
    await claude.complete("Hello", { model: "claude-unknown-99" });

    expect(capturedRequestOptions).toBeDefined();
    expect(capturedRequestOptions!.timeout).toBe(10 * 60_000);
  });
});
