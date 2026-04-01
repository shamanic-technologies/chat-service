import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests that createAnthropicClient().complete() passes output_config
 * with json_schema when responseFormat: "json" is requested, ensuring
 * Anthropic's constrained decoding produces valid JSON (no fences, no
 * malformed output).
 */

// Capture the params passed to client.messages.create
let capturedParams: Record<string, unknown> | undefined;

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: async (params: Record<string, unknown>) => {
          capturedParams = params;
          return {
            content: [{ type: "text", text: '{"ok":true}' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
        stream: () => {
          throw new Error("stream not implemented in mock");
        },
      };
    },
  };
});

// Import after mock is set up
const { createAnthropicClient } = await import("../../src/lib/anthropic.js");

describe("anthropic complete() output_config", () => {
  beforeEach(() => {
    capturedParams = undefined;
  });

  it("passes output_config with json_schema when responseFormat is json", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });
    await claude.complete("Return JSON", { responseFormat: "json" });

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: true,
        },
      },
    });
  });

  it("does NOT pass output_config when responseFormat is omitted", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });
    await claude.complete("Hello");

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.output_config).toBeUndefined();
  });

  it("returns parsed content from text blocks", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });
    const result = await claude.complete("Return JSON", { responseFormat: "json" });

    expect(result.content).toBe('{"ok":true}');
    expect(result.tokensInput).toBe(10);
    expect(result.tokensOutput).toBe(5);
  });
});
