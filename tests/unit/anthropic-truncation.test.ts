import { describe, it, expect, vi } from "vitest";

/**
 * Tests that complete() returns partial content when Anthropic returns
 * stop_reason: "max_tokens" — it should never throw, regardless of responseFormat.
 */

let mockCreateResponse: Record<string, unknown>;

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: async () => mockCreateResponse,
        stream: () => {
          throw new Error("stream not implemented in mock");
        },
      };
    },
  };
});

const { createAnthropicClient } = await import("../../src/lib/anthropic.js");

describe("anthropic complete() truncation detection", () => {
  it("returns partial content when stop_reason is max_tokens with responseFormat json", async () => {
    mockCreateResponse = {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: '{"partial": "dat' }],
      usage: { input_tokens: 100, output_tokens: 16000 },
    };

    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });
    const result = await claude.complete("Return JSON", { responseFormat: "json" });

    expect(result.content).toBe('{"partial": "dat');
    expect(result.tokensInput).toBe(100);
    expect(result.tokensOutput).toBe(16000);
  });

  it("returns partial content when stop_reason is max_tokens without responseFormat json", async () => {
    mockCreateResponse = {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "some long text that got cut off" }],
      usage: { input_tokens: 100, output_tokens: 16000 },
    };

    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });
    const result = await claude.complete("Write a long essay");

    expect(result.content).toBe("some long text that got cut off");
  });

  it("does NOT throw when stop_reason is end_turn with responseFormat json", async () => {
    mockCreateResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"complete": true}' }],
      usage: { input_tokens: 50, output_tokens: 20 },
    };

    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });
    const result = await claude.complete("Return JSON", { responseFormat: "json" });

    expect(result.content).toBe('{"complete": true}');
  });
});
