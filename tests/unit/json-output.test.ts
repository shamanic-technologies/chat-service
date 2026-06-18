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

  it("rejects JSON wrapped in a markdown fence", () => {
    expect(() => parseModelJsonOutput('```json\n{"ok":true}\n```')).toThrow(
      "Model returned markdown-fenced JSON in JSON mode.",
    );
  });

  it("rejects trailing prose after a complete JSON value", () => {
    expect(() => parseModelJsonOutput('{"ok":true}\n\nDone.')).toThrow(
      "Model returned trailing non-JSON content after a JSON value.",
    );
  });

  it("rejects prose before a JSON value", () => {
    expect(() => parseModelJsonOutput('Here is the JSON:\n{"ok":true}')).toThrow(
      "Model returned a non-JSON prefix before the JSON value.",
    );
  });

  it("rejects malformed JSON", () => {
    expect(() => parseModelJsonOutput('{"ok":true')).toThrow(
      "Model returned malformed or truncated JSON.",
    );
  });
});
