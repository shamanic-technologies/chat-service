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

  it("recovers JSON wrapped in a bare (no-lang) markdown fence", () => {
    expect(parseModelJsonOutput('```\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("recovers a complete JSON value with trailing prose (Gemini-3 thinking leak)", () => {
    expect(parseModelJsonOutput('{"ok":true}\n\nDone.')).toEqual({ ok: true });
  });

  it("recovers a complete JSON array with trailing prose", () => {
    expect(parseModelJsonOutput('[1,2,3]\n\nParsed successfully.')).toEqual([1, 2, 3]);
  });

  it("does not miscount braces inside string values during recovery", () => {
    expect(parseModelJsonOutput('{"a":"} not a close","b":[1]}\ntrailing')).toEqual({
      a: "} not a close",
      b: [1],
    });
  });

  it("recovers a fenced value that also has trailing prose after the fence", () => {
    expect(parseModelJsonOutput('```json\n{"ok":true}\n```\n\nHope that helps!')).toEqual({
      ok: true,
    });
  });

  it("rejects prose before a JSON value", () => {
    expect(() => parseModelJsonOutput('Here is the JSON:\n{"ok":true}')).toThrow(
      "Model returned a non-JSON prefix before the JSON value.",
    );
  });

  it("rejects truncated / unbalanced JSON", () => {
    expect(() => parseModelJsonOutput('{"ok":true')).toThrow(
      "Model returned malformed or truncated JSON.",
    );
  });

  it("rejects truncated JSON even with trailing content it cannot balance", () => {
    expect(() => parseModelJsonOutput('{"ok":true, "items":[1,2')).toThrow(
      "Model returned malformed or truncated JSON.",
    );
  });

  it("rejects an empty response", () => {
    expect(() => parseModelJsonOutput("   ")).toThrow(
      "Model returned an empty JSON-mode response.",
    );
  });
});
