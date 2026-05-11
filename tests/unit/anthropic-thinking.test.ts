import { describe, it, expect, vi } from "vitest";

let lastStreamParams: Record<string, unknown>;
let mockFinalMessage: Record<string, unknown>;

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: () => {
          throw new Error("create not implemented in mock — complete() must use stream");
        },
        stream: (params: Record<string, unknown>) => {
          lastStreamParams = params;
          return {
            finalMessage: async () => mockFinalMessage,
          };
        },
      };
    },
  };
});

const { createAnthropicClient } = await import("../../src/lib/anthropic.js");

describe("anthropic complete() options", () => {
  const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });

  it("does NOT send thinking config (thinking removed from API)", async () => {
    mockFinalMessage = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "result" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    await claude.complete("Simple task");

    expect(lastStreamParams.thinking).toBeUndefined();
  });

  it("preserves caller temperature", async () => {
    mockFinalMessage = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "result" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    await claude.complete("Simple task", { temperature: 0.3 });

    expect(lastStreamParams.temperature).toBe(0.3);
  });

  it("does not send temperature when omitted", async () => {
    mockFinalMessage = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "result" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    await claude.complete("Simple task");

    expect(lastStreamParams.temperature).toBeUndefined();
  });
});
