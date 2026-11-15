import { describe, expect, it } from "vitest";
import {
  ModelSchemaMismatchError,
  ResponseSchemaInvalidError,
  assertFollowsResponseSchema,
  compileResponseSchema,
} from "../../src/lib/response-schema.js";
import { ModelJsonOutputError } from "../../src/lib/json-output.js";

// The lead answerer's shape (SCHEMA-HONOURED-1115, prod 2026-11-15: GLM-5.3 Flash sent empty objects and a
// `message` beside `decision: later`, all served as 200).
const LEAD_ANSWER = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["now", "later", "nothing"] },
    message: { type: "string" },
    followUpInDays: { type: "integer", minimum: 0 },
  },
  required: ["decision", "message"],
  additionalProperties: false,
};

function mismatch(value: unknown, schema: Record<string, unknown> = LEAD_ANSWER): ModelSchemaMismatchError {
  try {
    assertFollowsResponseSchema(value, schema);
  } catch (err) {
    expect(err).toBeInstanceOf(ModelSchemaMismatchError);
    expect(err).toBeInstanceOf(ModelJsonOutputError);
    return err as ModelSchemaMismatchError;
  }
  throw new Error("expected a mismatch");
}

describe("assertFollowsResponseSchema", () => {
  it("a conforming answer passes unchanged", () => {
    const answer = { decision: "now", message: "Hi Dana,\n\nOnboarding takes a week.", followUpInDays: 3 };
    const before = JSON.stringify(answer);
    expect(() => assertFollowsResponseSchema(answer, LEAD_ANSWER)).not.toThrow();
    expect(JSON.stringify(answer)).toBe(before);
  });

  it("an empty object fails loud, naming every missing key", () => {
    const err = mismatch({});
    expect(err.violations).toContain('(root) is missing required key "decision"');
    expect(err.violations).toContain('(root) is missing required key "message"');
  });

  it("a value outside the enum fails loud", () => {
    expect(mismatch({ decision: "cold_email_followup", message: "x" }).message).toContain("/decision must be one of");
  });

  it("a wrong type fails loud", () => {
    expect(mismatch({ decision: "now", message: 42 }).message).toContain("/message must be string");
    expect(mismatch({ decision: "now", message: "x", followUpInDays: 1.5 }).message).toContain("/followUpInDays");
  });

  it("a key the schema forbids fails loud", () => {
    expect(mismatch({ decision: "now", message: "x", subject: "s" }).message).toContain('"subject"');
  });

  it("a non-object answer to an object schema fails loud", () => {
    expect(mismatch("why not now").message).toContain("(root) must be object");
    expect(mismatch(null).message).toContain("(root) must be object");
  });

  it("never judges the writer's text: any string in a string field passes", () => {
    expect(() => assertFollowsResponseSchema({ decision: "later", message: "" }, LEAD_ANSWER)).not.toThrow();
    expect(() => assertFollowsResponseSchema({ decision: "now", message: "subject: hi\n> quoted" }, LEAD_ANSWER)).not.toThrow();
  });

  it("format is an annotation, never asserted", () => {
    const schema = { type: "object", properties: { url: { type: "string", format: "uri" } } };
    expect(() => assertFollowsResponseSchema({ url: "not a url" }, schema)).not.toThrow();
  });

  it("reads OpenAPI nullable, draft-07 and 2020-12 schemas", () => {
    expect(() => assertFollowsResponseSchema({ c: null }, { type: "object", properties: { c: { type: "string", nullable: true } } })).not.toThrow();
    const d7 = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { a: { $ref: "#/definitions/A" }, t: { type: "array", items: [{ type: "string" }] } },
      definitions: { A: { type: "string" } },
      required: ["a"],
    };
    expect(() => assertFollowsResponseSchema({ a: "x", t: ["y"] }, d7)).not.toThrow();
    mismatch({ a: 1 }, d7);
    const d2020 = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: { A: { type: "string" } },
      required: ["a"],
    };
    expect(() => assertFollowsResponseSchema({ a: "x" }, d2020)).not.toThrow();
    mismatch({ a: 1 }, d2020);
  });
});

describe("compileResponseSchema", () => {
  it("refuses a schema that cannot be compiled", () => {
    expect(() => compileResponseSchema({ type: "object", properties: { a: { $ref: "#/nowhere" } } })).toThrow(ResponseSchemaInvalidError);
  });

  it("caches by content", () => {
    expect(compileResponseSchema({ type: "string" })).toBe(compileResponseSchema({ type: "string" }));
  });
});
