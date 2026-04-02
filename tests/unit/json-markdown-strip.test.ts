import { describe, it, expect } from "vitest";

/** Remove trailing commas before ] and } — a common LLM output quirk. */
function removeTrailingCommas(s: string): string {
  return s.replace(/,\s*([\]}])/g, "$1");
}

/**
 * Mirrors the parseModelJson logic in src/index.ts /complete handler.
 * Progressive repair: raw parse → strip fences → remove trailing commas.
 * Throws on truly unparsable content (no silent fallback).
 */
function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim();

  // Attempt 1: direct parse
  try {
    return JSON.parse(trimmed);
  } catch { /* continue */ }

  // Attempt 2: strip markdown fences
  const stripped = trimmed
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch { /* continue */ }

  // Attempt 3: remove trailing commas
  const repaired = removeTrailingCommas(stripped);
  try {
    return JSON.parse(repaired);
  } catch { /* continue */ }

  throw new Error(
    `Model returned non-parsable JSON. contentLen=${raw.length}, first500=${raw.slice(0, 500)}`
  );
}

describe("JSON markdown fence stripping", () => {
  it("parses plain JSON without fences", () => {
    const result = parseModelJson('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("strips ```json fences and parses", () => {
    const content = '```json\n{"key": "value"}\n```';
    const result = parseModelJson(content);
    expect(result).toEqual({ key: "value" });
  });

  it("strips ``` fences without json tag", () => {
    const content = '```\n{"key": "value"}\n```';
    const result = parseModelJson(content);
    expect(result).toEqual({ key: "value" });
  });

  it("strips ```JSON fences (case-insensitive)", () => {
    const content = '```JSON\n{"items": [1, 2, 3]}\n```';
    const result = parseModelJson(content);
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it("handles array responses wrapped in fences", () => {
    const content = '```json\n[{"id": 1}, {"id": 2}]\n```';
    const result = parseModelJson(content);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("throws for truly unparsable content", () => {
    expect(() => parseModelJson("This is not JSON at all")).toThrow(
      "Model returned non-parsable JSON",
    );
  });

  it("throws for fenced non-JSON content", () => {
    const content = '```json\nnot actually json\n```';
    expect(() => parseModelJson(content)).toThrow(
      "Model returned non-parsable JSON",
    );
  });

  it("handles fences with no trailing newline", () => {
    const content = '```json\n{"ok": true}```';
    const result = parseModelJson(content);
    expect(result).toEqual({ ok: true });
  });

  it("handles leading/trailing whitespace around fences", () => {
    const content = '\n```json\n{"isArticle": false, "authors": [], "publishedAt": null}\n```\n';
    const result = parseModelJson(content);
    expect(result).toEqual({ isArticle: false, authors: [], publishedAt: null });
  });

  it("handles leading/trailing whitespace around plain JSON", () => {
    const content = '  \n{"key": "value"}\n  ';
    const result = parseModelJson(content);
    expect(result).toEqual({ key: "value" });
  });

  it("handles whitespace inside fences around JSON", () => {
    const content = '```json\n\n  {"key": "value"}\n\n```';
    const result = parseModelJson(content);
    expect(result).toEqual({ key: "value" });
  });

  it("handles \\r\\n line endings", () => {
    const content = '```json\r\n{"key": "value"}\r\n```';
    const result = parseModelJson(content);
    expect(result).toEqual({ key: "value" });
  });
});

describe("trailing comma repair", () => {
  it("repairs trailing comma in object", () => {
    const content = '{"key": "value",}';
    const result = parseModelJson(content);
    expect(result).toEqual({ key: "value" });
  });

  it("repairs trailing comma in array", () => {
    const content = '["url1", "url2", "url3",]';
    const result = parseModelJson(content);
    expect(result).toEqual(["url1", "url2", "url3"]);
  });

  it("repairs trailing comma with whitespace/newlines", () => {
    const content = '[\n  "https://example.com/about",\n  "https://example.com/team",\n]';
    const result = parseModelJson(content);
    expect(result).toEqual(["https://example.com/about", "https://example.com/team"]);
  });

  it("repairs trailing comma in nested structures", () => {
    const content = '{"items": [1, 2, 3,], "nested": {"a": 1,},}';
    const result = parseModelJson(content);
    expect(result).toEqual({ items: [1, 2, 3], nested: { a: 1 } });
  });

  it("repairs trailing comma inside fenced JSON", () => {
    const content = '```json\n["url1", "url2",]\n```';
    const result = parseModelJson(content);
    expect(result).toEqual(["url1", "url2"]);
  });

  it("repairs real-world URL array with trailing comma", () => {
    const content = `[
  "https://nesarabaycity.com/about",
  "https://nesarabaycity.com/major-changes-under-new-ownership",
  "https://nesarabaycity.com/why-invest-in-nesara-bay",
]`;
    const result = parseModelJson(content);
    expect(result).toEqual([
      "https://nesarabaycity.com/about",
      "https://nesarabaycity.com/major-changes-under-new-ownership",
      "https://nesarabaycity.com/why-invest-in-nesara-bay",
    ]);
  });
});

describe("plain JSON arrays", () => {
  it("parses a plain JSON array of strings", () => {
    const content = '["a", "b", "c"]';
    const result = parseModelJson(content);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("parses a plain JSON array of objects", () => {
    const content = '[{"id": 1}, {"id": 2}]';
    const result = parseModelJson(content);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
