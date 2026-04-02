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

describe("anthropic complete() thinking support", () => {
  const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });

  it("sends thinking config when thinkingBudget > 0", async () => {
    mockCreateResponse = {
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "Let me reason about this..." },
        { type: "text", text: '{"answer": 42}' },
      ],
      usage: { input_tokens: 50, output_tokens: 200 },
    };

    const result = await claude.complete("Think about this", {
      thinkingBudget: 8000,
      maxTokens: 16000,
    });

    expect(lastCreateParams.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    // Thinking blocks should be excluded from content
    expect(result.content).toBe('{"answer": 42}');
    expect(result.tokensOutput).toBe(200);
  });

  it("does NOT send thinking config when thinkingBudget is 0", async () => {
    mockCreateResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "no thinking" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    await claude.complete("Simple task", { thinkingBudget: 0 });

    expect(lastCreateParams.thinking).toBeUndefined();
  });

  it("does NOT send thinking config when thinkingBudget is omitted", async () => {
    mockCreateResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "no thinking" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    await claude.complete("Simple task");

    expect(lastCreateParams.thinking).toBeUndefined();
  });

  it("omits caller temperature when thinking is enabled (Anthropic forces temp=1)", async () => {
    mockCreateResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "result" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    await claude.complete("Think about this", {
      thinkingBudget: 2000,
      maxTokens: 16000,
      temperature: 0.3,
    });

    expect(lastCreateParams.temperature).toBeUndefined();
    expect(lastCreateParams.thinking).toEqual({ type: "enabled", budget_tokens: 2000 });
  });

  it("preserves caller temperature when thinking is NOT enabled", async () => {
    mockCreateResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "result" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    await claude.complete("Simple task", { temperature: 0.3 });

    expect(lastCreateParams.temperature).toBe(0.3);
    expect(lastCreateParams.thinking).toBeUndefined();
  });
});
