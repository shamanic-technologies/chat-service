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
 * node before the schema is sent. Mirror of sanitizeGeminiSchema (which strips it).
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

  it("recurses into anyOf/allOf/oneOf and $defs", () => {
    const out = prepareAnthropicSchema({
      type: "object",
      properties: {
        choice: {
          anyOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "string" },
          ],
        },
      },
      $defs: {
        Inner: { type: "object", properties: { b: { type: "boolean" } } },
      },
    });
    expect((out.properties as any).choice.anyOf[0].additionalProperties).toBe(false);
    expect((out.$defs as any).Inner.additionalProperties).toBe(false);
  });

  it("does NOT clobber an explicit additionalProperties value", () => {
    const out = prepareAnthropicSchema({
      type: "object",
      additionalProperties: { type: "string" },
      properties: {},
    });
    expect(out.additionalProperties).toEqual({ type: "string" });
  });

  it("leaves non-object schemas untouched and does not mutate the input", () => {
    const input = { type: "string", enum: ["a", "b"] };
    const out = prepareAnthropicSchema(input);
    expect(out).toEqual({ type: "string", enum: ["a", "b"] });
    expect((input as any).additionalProperties).toBeUndefined();
  });
});

// --- Wiring: the schema reaches the provider normalized ---------------------

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
              content: [{ type: "text", text: '{"name":"x"}' }],
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

describe("complete() normalizes responseSchema for Anthropic strict mode", () => {
  beforeEach(() => {
    capturedParams = undefined;
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
});
