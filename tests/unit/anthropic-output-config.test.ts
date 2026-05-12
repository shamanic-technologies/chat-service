import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Anthropic rejects `output_config.format.schema` when the schema is a
 * permissive object (`additionalProperties: true`, no `properties`), with:
 *   400 invalid_request_error — "For 'object' type, 'additionalProperties: true'
 *   is not supported. Please set 'additionalProperties' to false"
 *
 * complete() must NOT pass `output_config` unless the caller supplies a strict
 * `responseSchema`. Anthropic JSON mode without `responseSchema` is rejected
 * upfront at the route handler level (400).
 */

let capturedParams: Record<string, unknown> | undefined;

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: () => {
          throw new Error("create not implemented in mock — complete() must use stream");
        },
        stream: (params: Record<string, unknown>) => {
          capturedParams = params;
          return {
            finalMessage: async () => ({
              content: [{ type: "text", text: '{"ok":true}' }],
              usage: { input_tokens: 10, output_tokens: 5 },
              stop_reason: "end_turn",
            }),
          };
        },
      };
    },
  };
});

const { createAnthropicClient } = await import("../../src/lib/anthropic.js");

describe("anthropic complete() output_config", () => {
  beforeEach(() => {
    capturedParams = undefined;
  });

  it("does NOT pass output_config when responseFormat is json", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });
    await claude.complete("Return JSON", { responseFormat: "json" });

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.output_config).toBeUndefined();
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

  it("passes output_config.format = json_schema when caller supplies responseSchema", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };
    await claude.complete("Return JSON", { responseFormat: "json", responseSchema: schema });

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.output_config).toEqual({
      format: { type: "json_schema", schema },
    });
  });

  it("passes output_config when responseSchema is set even without responseFormat", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { x: { type: "number" } },
    };
    await claude.complete("Return JSON", { responseSchema: schema });

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.output_config).toEqual({
      format: { type: "json_schema", schema },
    });
  });
});
