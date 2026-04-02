import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Mirrors parseModelJson from src/index.ts — progressive JSON repair for LLM output
// ---------------------------------------------------------------------------

function removeTrailingCommas(s: string): string {
  return s.replace(/,\s*([\]}])/g, "$1");
}

function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim();

  try {
    return JSON.parse(trimmed);
  } catch { /* continue */ }

  const stripped = trimmed
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch { /* continue */ }

  const repaired = removeTrailingCommas(stripped);
  try {
    return JSON.parse(repaired);
  } catch { /* continue */ }

  throw new Error(
    `Model returned non-parsable JSON despite responseFormat: "json". ` +
    `contentLen=${raw.length}, ` +
    `first500=${raw.slice(0, 500)}, ` +
    `last200=${raw.slice(-200)}`
  );
}

describe("parseModelJson — JSON parsing with progressive repair", () => {
  // --- Direct parse ---
  it("parses plain JSON object", () => {
    expect(parseModelJson('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("parses plain JSON array", () => {
    expect(parseModelJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it("handles leading/trailing whitespace", () => {
    expect(parseModelJson('  \n{"key": "value"}\n  ')).toEqual({ key: "value" });
  });

  // --- Markdown fence stripping ---
  it("strips ```json fences and parses", () => {
    const content = '```json\n{"key": "value"}\n```';
    expect(parseModelJson(content)).toEqual({ key: "value" });
  });

  it("strips ``` fences without json tag", () => {
    const content = '```\n{"key": "value"}\n```';
    expect(parseModelJson(content)).toEqual({ key: "value" });
  });

  it("strips ```JSON fences (case-insensitive)", () => {
    const content = '```JSON\n{"items": [1, 2, 3]}\n```';
    expect(parseModelJson(content)).toEqual({ items: [1, 2, 3] });
  });

  it("handles array responses wrapped in fences", () => {
    const content = '```json\n[{"id": 1}, {"id": 2}]\n```';
    expect(parseModelJson(content)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("handles fences with no trailing newline", () => {
    const content = '```json\n{"ok": true}```';
    expect(parseModelJson(content)).toEqual({ ok: true });
  });

  it("handles leading/trailing whitespace around fences", () => {
    const content = '\n```json\n{"isArticle": false, "authors": [], "publishedAt": null}\n```\n';
    expect(parseModelJson(content)).toEqual({ isArticle: false, authors: [], publishedAt: null });
  });

  it("handles whitespace inside fences around JSON", () => {
    const content = '```json\n\n  {"key": "value"}\n\n```';
    expect(parseModelJson(content)).toEqual({ key: "value" });
  });

  it("handles \\r\\n line endings", () => {
    const content = '```json\r\n{"key": "value"}\r\n```';
    expect(parseModelJson(content)).toEqual({ key: "value" });
  });

  // --- Trailing comma repair ---
  it("repairs trailing comma in object", () => {
    expect(parseModelJson('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
  });

  it("repairs trailing comma in array", () => {
    expect(parseModelJson('["url1", "url2", "url3",]')).toEqual(["url1", "url2", "url3"]);
  });

  it("repairs trailing comma with whitespace", () => {
    const content = '[\n  "https://example.com/a",\n  "https://example.com/b",\n]';
    expect(parseModelJson(content)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("repairs trailing comma inside fenced JSON", () => {
    const content = '```json\n{"items": [1, 2, 3,],}\n```';
    expect(parseModelJson(content)).toEqual({ items: [1, 2, 3] });
  });

  it("repairs nested trailing commas", () => {
    const content = '{"a": {"b": [1, 2,], "c": 3,},}';
    expect(parseModelJson(content)).toEqual({ a: { b: [1, 2], c: 3 } });
  });

  // --- Error cases ---
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

  it("includes contentLen and preview in error", () => {
    const content = "broken json content here";
    expect(() => parseModelJson(content)).toThrow(/contentLen=\d+/);
    expect(() => parseModelJson(content)).toThrow(/first500=/);
    expect(() => parseModelJson(content)).toThrow(/last200=/);
  });
});
