import { describe, expect, it } from "vitest";
import {
  NOT_JSON,
  buildSchemaConformanceRead,
  checkResponseSchema,
  type SchemaConformanceDayRow,
} from "../../src/lib/response-schema.js";

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

describe("checkResponseSchema", () => {
  it("a conforming answer conforms, and is left unchanged", () => {
    const answer = { decision: "now", message: "Hi Dana,\n\nOnboarding takes a week.", followUpInDays: 3 };
    const before = JSON.stringify(answer);
    expect(checkResponseSchema(answer, LEAD_ANSWER)).toEqual({ conforming: true, violations: [] });
    expect(JSON.stringify(answer)).toBe(before);
  });

  it("an empty object does not conform, naming every missing key", () => {
    const c = checkResponseSchema({}, LEAD_ANSWER);
    expect(c.conforming).toBe(false);
    expect(c.violations).toContain('(root) is missing required key "decision"');
    expect(c.violations).toContain('(root) is missing required key "message"');
  });

  it("names a value outside the enum, a wrong type and a forbidden key", () => {
    expect(checkResponseSchema({ decision: "cold_email_followup", message: "x" }, LEAD_ANSWER).violations.join()).toContain("/decision must be one of");
    expect(checkResponseSchema({ decision: "now", message: 42 }, LEAD_ANSWER).violations.join()).toContain("/message must be string");
    expect(checkResponseSchema({ decision: "now", message: "x", followUpInDays: 1.5 }, LEAD_ANSWER).violations.join()).toContain("/followUpInDays");
    expect(checkResponseSchema({ decision: "now", message: "x", subject: "s" }, LEAD_ANSWER).violations.join()).toContain('"subject"');
    expect(checkResponseSchema("why not now", LEAD_ANSWER).violations.join()).toContain("(root) must be object");
  });

  it("never judges the writer's text: any string in a string field conforms", () => {
    expect(checkResponseSchema({ decision: "later", message: "" }, LEAD_ANSWER).conforming).toBe(true);
    expect(checkResponseSchema({ decision: "now", message: "subject: hi\n> quoted" }, LEAD_ANSWER).conforming).toBe(true);
  });

  it("format is an annotation, never asserted", () => {
    expect(checkResponseSchema({ url: "not a url" }, { type: "object", properties: { url: { type: "string", format: "uri" } } }).conforming).toBe(true);
  });

  it("reads OpenAPI nullable, draft-07 and 2020-12 schemas", () => {
    expect(checkResponseSchema({ c: null }, { type: "object", properties: { c: { type: "string", nullable: true } } }).conforming).toBe(true);
    const d7 = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { a: { $ref: "#/definitions/A" }, t: { type: "array", items: [{ type: "string" }] } },
      definitions: { A: { type: "string" } },
      required: ["a"],
    };
    expect(checkResponseSchema({ a: "x", t: ["y"] }, d7).conforming).toBe(true);
    expect(checkResponseSchema({ a: 1 }, d7).conforming).toBe(false);
    const d2020 = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: { A: { type: "string" } },
      required: ["a"],
    };
    expect(checkResponseSchema({ a: "x" }, d2020).conforming).toBe(true);
    expect(checkResponseSchema({ a: 1 }, d2020).conforming).toBe(false);
  });

  it("a schema that cannot be compiled is reported, never thrown", () => {
    const c = checkResponseSchema({}, { type: "object", properties: { a: { $ref: "#/nowhere" } } });
    expect(c.conforming).toBe(false);
    expect(c.violations[0]).toMatch(/responseSchema cannot be compiled/);
  });
});

describe("buildSchemaConformanceRead", () => {
  const row = (model: string, answered: number, bad: number, day = "2026-11-16"): SchemaConformanceDayRow => ({
    day, provider: "p", model, route: "platform-complete", answeredCalls: answered, nonConformingCalls: bad,
    lastViolations: bad ? `(root) is missing required key "message"` : null, lastNonConformingAt: bad ? `${day}T10:00:00.000Z` : null,
  });

  it("red only when broken: >5% of >=20 answers; few answers is not red", () => {
    const read = buildSchemaConformanceRead([row("kimi-k3", 10, 10), row("kimi-k3", 10, 10, "2026-11-15"), row("glm-5.3", 40, 1), row("new", 3, 3)], 30);
    expect(read.verdict).toBe("broken");
    expect(read.models.map((m) => [m.model, m.verdict])).toEqual([["kimi-k3", "broken"], ["glm-5.3", "ok"], ["new", "not_enough_answers"]]);
    expect(read.models[0]).toMatchObject({ answeredCalls: 20, nonConformingCalls: 20, lastViolations: '(root) is missing required key "message"' });
    expect(read.models[0].sentence).toContain("20 of 20 answers");
    expect(read.series).toHaveLength(4);
  });

  it("all ok reads ok; NOT_JSON counts as a miss", () => {
    expect(buildSchemaConformanceRead([row("glm-5.3", 100, 2)], 30).verdict).toBe("ok");
    expect(NOT_JSON.conforming).toBe(false);
  });
});
