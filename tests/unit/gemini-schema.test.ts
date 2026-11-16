import { describe, it, expect } from "vitest";
import { sanitizeGeminiSchema, decodeGeminiAnswer, throwIfGeminiRefusedShape, GeminiUnsupportedOptionError } from "../../src/lib/gemini.js";

// SCHEMA-ANY-VENDOR-1116: the four valid JSON Schema forms Gemini refuses with
// a 400 (probed live 2026-11-16) are translated, and the answer is decoded back
// to the caller's own values.
describe("sanitizeGeminiSchema — translate what Gemini refuses", () => {
  it("sends an empty enum member as a placeholder and decodes it back to \"\"", () => {
    const { schema, decode } = sanitizeGeminiSchema({
      type: "object",
      properties: { replyTo: { type: "string", enum: ["m1", "m2", ""] } },
      required: ["replyTo"],
    });
    const replyTo = (schema.properties as Record<string, { enum: string[] }>).replyTo;
    expect(replyTo.enum).toEqual(["m1", "m2", "(empty)"]);
    expect(replyTo.enum).not.toContain("");
    expect(decode!({ replyTo: "(empty)" })).toEqual({ replyTo: "" });
    expect(decode!({ replyTo: "m2" })).toEqual({ replyTo: "m2" });
  });

  it("picks a placeholder the caller's enum does not already use", () => {
    const { schema, decode } = sanitizeGeminiSchema({ type: "string", enum: ["(empty)", ""] });
    expect(schema.enum).toEqual(["(empty)", "(empty 1)"]);
    expect(decode!("(empty 1)")).toBe("");
    expect(decode!("(empty)")).toBe("(empty)");
  });

  it("sends a number / boolean enum as strings and decodes the caller's types back", () => {
    const { schema, decode } = sanitizeGeminiSchema({
      type: "object",
      properties: { n: { type: "integer", enum: [1, 2, 3] }, b: { enum: [true, false] } },
    });
    const props = schema.properties as Record<string, { type: string; enum: string[] }>;
    expect(props.n).toEqual({ type: "string", enum: ["1", "2", "3"] });
    expect(props.b).toEqual({ enum: ["true", "false"], type: "string" });
    expect(decode!({ n: "2", b: "false" })).toEqual({ n: 2, b: false });
  });

  it("decodes inside arrays and anyOf branches", () => {
    const { decode } = sanitizeGeminiSchema({
      type: "array",
      items: { anyOf: [{ type: "string", enum: ["", "a"] }, { type: "number" }] },
    });
    expect(decode!(["(empty)", "a", 4])).toEqual(["", "a", 4]);
  });

  it("drops a required name with no property and names it", () => {
    const { schema, removed } = sanitizeGeminiSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a", "b"] });
    expect(schema.required).toEqual(["a"]);
    expect(removed).toContain("required[undefined property]");
  });

  it("gives an array with no items `items: {}`", () => {
    const { schema } = sanitizeGeminiSchema({ type: "object", properties: { a: { type: "array" } } });
    expect((schema.properties as Record<string, unknown>).a).toEqual({ type: "array", items: {} });
  });

  it("leaves a schema Gemini already accepts untouched, with no decoder", () => {
    const input = { type: "object", properties: { a: { type: "string", enum: ["x", "y"] } }, required: ["a"] };
    const { schema, decode, removed } = sanitizeGeminiSchema(input);
    expect(schema).toEqual(input);
    expect(decode).toBeUndefined();
    expect(removed).toEqual([]);
  });
});

describe("decodeGeminiAnswer", () => {
  it("returns the content byte-equal when nothing needs decoding", () => {
    expect(decodeGeminiAnswer('{ "a":1 }', undefined)).toBe('{ "a":1 }');
  });
  it("leaves unreadable JSON for the route's strict parse to refuse", () => {
    const { decode } = sanitizeGeminiSchema({ type: "string", enum: [""] });
    expect(decodeGeminiAnswer('{"a"', decode)).toBe('{"a"');
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
