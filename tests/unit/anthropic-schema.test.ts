import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression: Anthropic strict structured-output mode REQUIRES every
 * `type: "object"` node in `output_config.format.schema` to carry an explicit
 * `additionalProperties: false`. A caller-supplied JSON-Schema-7 / Zod schema
 * that omits it returns:
 *   400 invalid_request_error — "output_config.format.schema: For 'object' type,
 *   'additionalProperties' must be explicitly set to false"
 * which (no fallback parsing on /complete) kills the chat turn.
 *
 * prepareAnthropicSchema() stamps `additionalProperties: false` onto every object
 * node before the schema is sent (the translation lives in vendor-schema.ts,
 * SCHEMA-ANY-VENDOR-1116; its own cases are in vendor-schema.test.ts).
 */

import { prepareAnthropicSchema } from "../../src/lib/anthropic.js";

describe("prepareAnthropicSchema", () => {
  it("stamps additionalProperties:false on a root object missing it (the 400 case)", () => {
    const input = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const out = prepareAnthropicSchema(input);
    expect(out.additionalProperties).toBe(false);
    // properties + required preserved untouched
    expect(out.properties).toEqual({ name: { type: "string" } });
    expect(out.required).toEqual(["name"]);
  });

  it("recurses into nested object properties", () => {
    const out = prepareAnthropicSchema({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      },
    });
    expect(out.additionalProperties).toBe(false);
    expect((out.properties as any).user.additionalProperties).toBe(false);
  });

  it("recurses into array items that are objects", () => {
    const out = prepareAnthropicSchema({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { v: { type: "number" } } },
        },
      },
    });
    expect(out.additionalProperties).toBe(false);
    expect((out.properties as any).items.items.additionalProperties).toBe(false);
    // arrays are not objects — no additionalProperties stamped on the array node
    expect((out.properties as any).items.additionalProperties).toBeUndefined();
  });

  it("recurses into anyOf branches and inlines $defs (no $defs left to send)", () => {
    const out = prepareAnthropicSchema({
      type: "object",
      properties: {
        choice: {
          anyOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "string" },
          ],
        },
        inner: { $ref: "#/$defs/Inner" },
      },
      $defs: {
        Inner: { type: "object", properties: { b: { type: "boolean" } } },
      },
    });
    expect((out.properties as any).choice.anyOf[0].additionalProperties).toBe(false);
    expect((out.properties as any).inner).toEqual({ type: "object", properties: { b: { type: "boolean" } }, additionalProperties: false });
    expect(out.$defs).toBeUndefined();
  });

  it("a free-form map (additionalProperties: schema, refused by Anthropic) is asked for as a JSON string", () => {
    const out = prepareAnthropicSchema({
      type: "object",
      properties: { tags: { type: "object", additionalProperties: { type: "string" } } },
    });
    expect((out.properties as any).tags.type).toBe("string");
    expect(out.additionalProperties).toBe(false);
  });

  it("wraps a non-object root under `value` and does not mutate the input", () => {
    const input = { type: "string", enum: ["a", "b"] };
    const out = prepareAnthropicSchema(input);
    expect(out).toEqual({ type: "object", properties: { value: { type: "string", enum: ["a", "b"] } }, required: ["value"], additionalProperties: false });
    expect(input).toEqual({ type: "string", enum: ["a", "b"] });
  });
});

// --- Wiring: the schema reaches the provider normalized ---------------------

let capturedParams: Record<string, unknown> | undefined;
let mockText = '{"name":"x"}';
let mockError: Error | null = null;

const { MockAPIError } = vi.hoisted(() => ({
  MockAPIError: class MockAPIError extends Error {
    constructor(public status: number | undefined, message: string) {
      super(message);
    }
  },
}));

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      static APIError = MockAPIError;
      messages = {
        create: () => {
          throw new Error("create not implemented in mock — complete() must use stream");
        },
        stream: (params: Record<string, unknown>) => {
          capturedParams = params;
          return {
            finalMessage: async () => {
              if (mockError) throw mockError;
              return {
              content: [{ type: "text", text: mockText }],
              usage: { input_tokens: 10, output_tokens: 5 },
              stop_reason: "end_turn",
              };
            },
          };
        },
      };
    },
  };
});

const { createAnthropicClient } = await import("../../src/lib/anthropic.js");

describe("complete() normalizes responseSchema for Anthropic strict mode", () => {
  beforeEach(() => {
    capturedParams = undefined;
    mockText = '{"name":"x"}';
    mockError = null;
  });

  it("sends additionalProperties:false even when the caller omits it", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "You are helpful." });
    // Permissive schema as a JSON-Schema-7 / Zod caller would emit — no additionalProperties.
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    await claude.complete("Extract the name", { responseFormat: "json", responseSchema: schema });

    expect(capturedParams).toBeDefined();
    const sentSchema = (capturedParams!.output_config as any).format.schema;
    expect(sentSchema.additionalProperties).toBe(false);
    // caller's schema object is not mutated
    expect((schema as any).additionalProperties).toBeUndefined();
  });

  it("keeps an enum holding the empty string and serves the answer unchanged (SCHEMA-ANY-VENDOR-1116)", async () => {
    mockText = '{"replyTo":""}';
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "s" });
    const schema = { type: "object", properties: { replyTo: { type: "string", enum: ["thread-a", ""] } }, required: ["replyTo"] };
    const result = await claude.complete("x", { responseFormat: "json", responseSchema: schema });
    expect((capturedParams!.output_config as any).format.schema.properties.replyTo.enum).toEqual(["thread-a", ""]);
    expect(result.content).toBe('{"replyTo":""}');
  });

  it("decodes a node asked for as a JSON string back into what the caller's schema describes", async () => {
    mockText = '{"tags":"{\\"a\\":\\"b\\"}"}';
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "s" });
    const schema = { type: "object", properties: { tags: { type: "object", additionalProperties: { type: "string" } } }, required: ["tags"] };
    const result = await claude.complete("x", { responseFormat: "json", responseSchema: schema });
    expect((capturedParams!.output_config as any).format.schema.properties.tags.type).toBe("string");
    expect(JSON.parse(result.content)).toEqual({ tags: { a: "b" } });
  });

  it("a 400 from Anthropic is an AnthropicUnsupportedOptionError carrying its message (routes answer 400, retryable:false)", async () => {
    mockError = new MockAPIError(400, "output_config.format.schema: Schema type 'oneOf' is not supported");
    const { AnthropicUnsupportedOptionError } = await import("../../src/lib/anthropic.js");
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "s" });
    const err = await claude.complete("x", { responseFormat: "json", responseSchema: { type: "object", properties: {} } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicUnsupportedOptionError);
    expect((err as Error).message).toContain("'oneOf' is not supported");
    expect((err as Error).message).toContain("retrying will not help");
  });
});
