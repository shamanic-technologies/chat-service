import { describe, it, expect } from "vitest";
import {
  toPortableJsonSchema,
  toAnthropicJsonSchema,
  decodeSchemaAnswer,
  decodeSchemaAnswerText,
} from "../../src/lib/vendor-schema.js";
import { checkResponseSchema } from "../../src/lib/response-schema.js";

/**
 * SCHEMA-ANY-VENDOR-1116: any valid caller schema works on every vendor. Each case below is a refusal
 * measured live on 2026-11-16 (one schema per keyword, from the chat-service container).
 */

// The lead answerer's shape: "" = start a new thread. Google's OpenAPI responseSchema refused it.
const LEAD_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["now", "later", "nothing"] },
    replyTo: { type: "string", enum: ["thread-a", "thread-b", ""] },
    message: { type: "string" },
  },
  required: ["decision", "replyTo", "message"],
  additionalProperties: false,
};

describe("toPortableJsonSchema (Google, OpenAI, Z.ai, Moonshot)", () => {
  it("keeps an enum holding the empty string exactly as the caller wrote it", () => {
    const out = toPortableJsonSchema(LEAD_SCHEMA);
    expect(out).toEqual(LEAD_SCHEMA);
  });

  it("does not mutate the caller's schema", () => {
    const schema = { type: "object", properties: { t: { type: "array", items: [{ type: "string" }] } } };
    const before = JSON.stringify(schema);
    toPortableJsonSchema(schema);
    expect(JSON.stringify(schema)).toBe(before);
  });

  it("turns the draft-07 tuple form into prefixItems (+ additionalItems into items)", () => {
    const out = toPortableJsonSchema({
      type: "object",
      properties: { t: { type: "array", items: [{ type: "string" }, { type: "integer" }], additionalItems: false } },
    });
    expect((out.properties as any).t).toEqual({ type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false });
  });

  it("gives an untyped enum its type, and one branch per type when the values mix", () => {
    const one = toPortableJsonSchema({ type: "object", properties: { e: { enum: ["a", ""] } } });
    expect((one.properties as any).e).toEqual({ enum: ["a", ""], type: "string" });
    const mixed = toPortableJsonSchema({ type: "object", properties: { e: { enum: ["a", 1, 2.5, null] } } });
    expect((mixed.properties as any).e).toEqual({
      anyOf: [
        { type: "string", enum: ["a"] },
        { type: "number", enum: [1, 2.5] },
        { type: "null", enum: [null] },
      ],
    });
  });

  it("validates the same instances before and after (lossless)", () => {
    const schema = {
      type: "object",
      properties: {
        e: { enum: ["a", 1, null] },
        t: { type: "array", items: [{ type: "string" }], additionalItems: false },
        n: { type: "string", nullable: true },
      },
    };
    const out = toPortableJsonSchema(schema);
    for (const value of [{ e: "a" }, { e: 1 }, { e: null }, { t: ["x"] }, { n: null }, { n: "s" }]) {
      expect(checkResponseSchema(value, { $schema: "https://json-schema.org/draft/2020-12/schema", ...out }).conforming).toBe(true);
    }
    for (const value of [{ e: "b" }, { t: ["x", "y"] }, { n: 3 }]) {
      expect(checkResponseSchema(value, { $schema: "https://json-schema.org/draft/2020-12/schema", ...out }).conforming).toBe(false);
    }
  });

  it("turns OpenAPI nullable into a null type", () => {
    const out = toPortableJsonSchema({ type: "object", properties: { n: { type: "string", nullable: true } } });
    expect((out.properties as any).n).toEqual({ type: ["string", "null"] });
  });
});

describe("toAnthropicJsonSchema (strict output_config.format)", () => {
  it("keeps the empty enum member and stamps additionalProperties false; no decoding needed", () => {
    const { schema, plan } = toAnthropicJsonSchema(LEAD_SCHEMA);
    expect((schema.properties as any).replyTo.enum).toEqual(["thread-a", "thread-b", ""]);
    expect(schema.additionalProperties).toBe(false);
    expect(plan).toBeNull();
  });

  it("stamps additionalProperties false on every nested object", () => {
    const { schema } = toAnthropicJsonSchema({
      type: "object",
      properties: { o: { type: "object", properties: { k: { type: "string" } } }, a: { type: "array", items: { type: "object", properties: { j: { type: "string" } } } } },
    });
    expect((schema.properties as any).o.additionalProperties).toBe(false);
    expect((schema.properties as any).a.items.additionalProperties).toBe(false);
  });

  it("moves every refused constraint keyword into the description", () => {
    const { schema, plan } = toAnthropicJsonSchema({
      type: "object",
      properties: {
        n: { type: "number", minimum: 0, maximum: 10, description: "score" },
        i: { type: "integer", multipleOf: 2, exclusiveMinimum: 0 },
        a: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4, uniqueItems: true },
        s: { type: "string", format: "phone" },
        ok: { type: "string", format: "email", minLength: 1, pattern: "^a" },
      },
    });
    const p = schema.properties as any;
    expect(p.n).toEqual({ type: "number", description: "score\n\n{minimum: 0, maximum: 10}" });
    expect(p.i).toEqual({ type: "integer", description: "{multipleOf: 2, exclusiveMinimum: 0}" });
    expect(p.a).toEqual({ type: "array", items: { type: "string" }, description: "{minItems: 2, maxItems: 4, uniqueItems: true}" });
    expect(p.s).toEqual({ type: "string", description: "{format: \"phone\"}" });
    expect(p.ok).toEqual({ type: "string", format: "email", minLength: 1, pattern: "^a" });
    expect(plan).toBeNull();
  });

  it("turns oneOf into anyOf and inlines local $refs", () => {
    const { schema } = toAnthropicJsonSchema({
      type: "object",
      $defs: { s: { type: "string", enum: ["x", ""] } },
      properties: { u: { oneOf: [{ type: "string" }, { type: "integer" }] }, r: { $ref: "#/$defs/s" } },
    });
    const p = schema.properties as any;
    expect(p.u).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] });
    expect(p.r).toEqual({ type: "string", enum: ["x", ""] });
    expect(schema.$defs).toBeUndefined();
  });

  it("asks for a node it cannot express as a JSON string and decodes the answer back", () => {
    const caller = {
      type: "object",
      properties: {
        tags: { type: "object", additionalProperties: { type: "string" }, description: "free map" },
        anything: { description: "any value" },
        list: { type: "array", items: { type: "object", properties: { meta: { type: "object" } }, required: ["meta"] } },
      },
      required: ["tags", "anything", "list"],
    };
    const { schema, plan } = toAnthropicJsonSchema(caller);
    const p = schema.properties as any;
    expect(p.tags.type).toBe("string");
    expect(p.tags.description).toContain("free map");
    expect(p.anything.type).toBe("string");
    expect(p.list.items.properties.meta.type).toBe("string");

    const modelAnswer = { tags: '{"a":"b"}', anything: "[1,2]", list: [{ meta: '{"k":1}' }] };
    const decoded = decodeSchemaAnswer(modelAnswer, plan);
    expect(decoded).toEqual({ tags: { a: "b" }, anything: [1, 2], list: [{ meta: { k: 1 } }] });
    expect(checkResponseSchema(decoded, caller).conforming).toBe(true);
  });

  it("encodes a recursive $ref instead of sending a cycle", () => {
    const { schema, plan } = toAnthropicJsonSchema({
      type: "object",
      $defs: { n: { type: "object", properties: { c: { type: "array", items: { $ref: "#/$defs/n" } } } } },
      properties: { tree: { $ref: "#/$defs/n" } },
    });
    const tree = (schema.properties as any).tree;
    expect(tree.properties.c.items.type).toBe("string");
    expect(decodeSchemaAnswer({ tree: { c: ['{"c":[]}'] } }, plan)).toEqual({ tree: { c: [{ c: [] }] } });
  });

  it("wraps a non-object root under `value` and unwraps it", () => {
    const { schema, plan } = toAnthropicJsonSchema({ type: "array", items: { type: "string", enum: ["a", ""] } });
    expect(schema).toEqual({
      type: "object",
      properties: { value: { type: "array", items: { type: "string", enum: ["a", ""] } } },
      required: ["value"],
      additionalProperties: false,
    });
    expect(decodeSchemaAnswerText('{"value":["",  "a"]}', plan)).toBe('["","a"]');
  });

  it("leaves the answer text untouched when nothing needs decoding, or when it is not JSON", () => {
    expect(decodeSchemaAnswerText('{"replyTo": ""}', null)).toBe('{"replyTo": ""}');
    expect(decodeSchemaAnswerText("not json", { kind: "json" })).toBe("not json");
  });
});
