import { describe, expect, it } from "vitest";
import { parseModelJsonOutput } from "../../src/lib/json-output.js";

describe("parseModelJsonOutput", () => {
  it("parses strict JSON", () => {
    expect(parseModelJsonOutput('{"ok":true,"items":[1,2]}')).toEqual({
      ok: true,
      items: [1, 2],
    });
  });

  it("allows surrounding whitespace", () => {
    expect(parseModelJsonOutput('\n  {"ok":true}\n')).toEqual({ ok: true });
  });

  it("recovers JSON wrapped in a markdown fence", () => {
    expect(parseModelJsonOutput('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("recovers JSON wrapped in a bare fence", () => {
    expect(parseModelJsonOutput('```\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("recovers a value with trailing prose after a complete JSON object", () => {
    expect(parseModelJsonOutput('{"ok":true}\n\nDone.')).toEqual({ ok: true });
  });

  it("recovers a value with trailing prose after a complete JSON array", () => {
    expect(parseModelJsonOutput('[1,2,3]\n\nThat is the list.')).toEqual([1, 2, 3]);
  });

  it("ignores delimiters inside strings when scanning", () => {
    expect(parseModelJsonOutput('{"a":"}] not real","b":[1,2]}\ntrailing')).toEqual({
      a: "}] not real",
      b: [1, 2],
    });
  });

  it("recovers when escaped quotes appear inside strings", () => {
    expect(parseModelJsonOutput('{"a":"he said \\"hi\\" }"}\nDone')).toEqual({
      a: 'he said "hi" }',
    });
  });

  it("rejects prose before a JSON value", () => {
    expect(() => parseModelJsonOutput('Here is the JSON:\n{"ok":true}')).toThrow(
      "Model returned a non-JSON prefix before the JSON value.",
    );
  });

  it("rejects malformed / truncated (unbalanced) JSON", () => {
    expect(() => parseModelJsonOutput('{"ok":true')).toThrow(
      "Model returned malformed or truncated JSON.",
    );
  });

  it("rejects an unbalanced object even with trailing prose", () => {
    expect(() => parseModelJsonOutput('{"ok":true, "items":[1,2\n\nDone.')).toThrow(
      ModelJsonOutputErrorMessage(),
    );
  });

  it("rejects an empty response", () => {
    expect(() => parseModelJsonOutput("")).toThrow(
      "Model returned an empty JSON-mode response.",
    );
  });
});

// Both the trailing/prefix classification branches produce distinct messages;
// an unbalanced-with-trailing case surfaces the trailing-content classification.
function ModelJsonOutputErrorMessage(): RegExp {
  return /Model returned (trailing non-JSON content after a JSON value|malformed or truncated JSON)\./;
}
