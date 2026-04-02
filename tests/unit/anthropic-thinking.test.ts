import { describe, it, expect, vi } from "vitest";

let lastCreateParams: Record<string, unknown>;
let mockCreateResponse: Record<string, unknown>;

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: async (params: Record<string, unknown>) => {
          lastCreateParams = params;
          return mockCreateResponse;
        },
        stream: () => {
          throw new Error("stream not implemented in mock");
        },
      };
    },
  };
});

const { createAnthropicClient } = await import("../../src/lib/anthropic.js");

describe("anthropic complete() options", () => {
  const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });

  it("does NOT send thinking config (thinking removed from API)", async () => {
    mockCreateResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "result" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    await claude.complete("Simple task");

    expect(lastCreateParams.thinking).toBeUndefined();
  });

  it("preserves caller temperature", async () => {
    mockCreateResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "result" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    await claude.complete("Simple task", { temperature: 0.3 });

    expect(lastCreateParams.temperature).toBe(0.3);
  });

  it("does not send temperature when omitted", async () => {
    mockCreateResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "result" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    await claude.complete("Simple task");

    expect(lastCreateParams.temperature).toBeUndefined();
  });
});
