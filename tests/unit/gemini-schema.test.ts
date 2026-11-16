import { describe, it, expect } from "vitest";
import { throwIfGeminiRefusedShape, GeminiUnsupportedOptionError } from "../../src/lib/gemini.js";
import { toGeminiJsonSchema } from "../../src/lib/vendor-schema.js";

// SCHEMA-ANY-VENDOR-1116: Google's JSON Schema fields (responseJsonSchema, parametersJsonSchema) accept the
// forms its OpenAPI responseSchema refused (probed live 2026-11-16): an enum member "", number / boolean enum
// members, an array with no items. They are sent untouched; nothing to decode.
describe("toGeminiJsonSchema — only what Google's JSON Schema field still refuses is translated", () => {
  it("sends an empty enum member, number and boolean enums, and an itemless array as the caller wrote them", () => {
    const input = {
      type: "object",
      properties: {
        replyTo: { type: "string", enum: ["m1", "m2", ""] },
        n: { type: "integer", enum: [1, 2, 3] },
        b: { type: "boolean", enum: [true, false] },
        list: { type: "array" },
      },
      required: ["replyTo"],
    };
    expect(toGeminiJsonSchema(input)).toEqual(input);
  });

  it("declares a required name with no property as an any-value property (Google: 'requires unspecified property')", () => {
    const out = toGeminiJsonSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a", "ghost"] });
    expect(out).toEqual({ type: "object", properties: { a: { type: "string" }, ghost: {} }, required: ["a", "ghost"] });
  });

  it("does it at any depth", () => {
    const out = toGeminiJsonSchema({
      type: "object",
      properties: { o: { type: "array", items: { type: "object", properties: {}, required: ["k"] } } },
    });
    expect((out.properties as any).o.items.properties).toEqual({ k: {} });
  });
});

describe("throwIfGeminiRefusedShape", () => {
  it("turns a 400 INVALID_ARGUMENT into a non-retryable shape refusal carrying Google's message", () => {
    const body = '{"error":{"code":400,"message":"* response_schema.properties[replyTo].enum[2]: cannot be empty","status":"INVALID_ARGUMENT"}}';
    expect(() => throwIfGeminiRefusedShape(400, body)).toThrow(GeminiUnsupportedOptionError);
    try {
      throwIfGeminiRefusedShape(400, body);
    } catch (err) {
      expect((err as GeminiUnsupportedOptionError).vendorMessage).toMatch(/cannot be empty/);
    }
  });
  it("keeps an invalid API key and every other status a provider failure", () => {
    expect(() => throwIfGeminiRefusedShape(400, '{"error":{"message":"API key not valid","status":"INVALID_ARGUMENT"}}')).not.toThrow();
    expect(() => throwIfGeminiRefusedShape(404, "not found")).not.toThrow();
  });
});
