import { describe, it, expect } from "vitest";

/**
 * Mirrors the markdown-fence stripping logic in src/index.ts /complete handler.
 * If JSON.parse fails on raw content, strip ```json fences and retry.
 * Throws on truly unparsable content (no silent fallback).
 */
function parseJsonWithFenceStrip(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const stripped = trimmed.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    try {
      return JSON.parse(stripped);
    } catch {
      throw new Error(`Model returned non-parsable JSON. Content: ${content.slice(0, 500)}`);
    }
  }
}

describe("JSON markdown fence stripping", () => {
  it("parses plain JSON without fences", () => {
    const result = parseJsonWithFenceStrip('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("strips ```json fences and parses", () => {
    const content = '```json\n{"key": "value"}\n```';
    const result = parseJsonWithFenceStrip(content);
    expect(result).toEqual({ key: "value" });
  });

  it("strips ``` fences without json tag", () => {
    const content = '```\n{"key": "value"}\n```';
    const result = parseJsonWithFenceStrip(content);
    expect(result).toEqual({ key: "value" });
  });

  it("strips ```JSON fences (case-insensitive)", () => {
    const content = '```JSON\n{"items": [1, 2, 3]}\n```';
    const result = parseJsonWithFenceStrip(content);
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it("handles array responses wrapped in fences", () => {
    const content = '```json\n[{"id": 1}, {"id": 2}]\n```';
    const result = parseJsonWithFenceStrip(content);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("throws for truly unparsable content", () => {
    expect(() => parseJsonWithFenceStrip("This is not JSON at all")).toThrow(
      "Model returned non-parsable JSON",
    );
  });

  it("throws for fenced non-JSON content", () => {
    const content = '```json\nnot actually json\n```';
    expect(() => parseJsonWithFenceStrip(content)).toThrow(
      "Model returned non-parsable JSON",
    );
  });

  it("handles fences with no trailing newline", () => {
    const content = '```json\n{"ok": true}```';
    const result = parseJsonWithFenceStrip(content);
    expect(result).toEqual({ ok: true });
  });

  it("handles leading/trailing whitespace around fences", () => {
    const content = '\n```json\n{"isArticle": false, "authors": [], "publishedAt": null}\n```\n';
    const result = parseJsonWithFenceStrip(content);
    expect(result).toEqual({ isArticle: false, authors: [], publishedAt: null });
  });

  it("handles leading/trailing whitespace around plain JSON", () => {
    const content = '  \n{"key": "value"}\n  ';
    const result = parseJsonWithFenceStrip(content);
    expect(result).toEqual({ key: "value" });
  });

  it("handles whitespace inside fences around JSON", () => {
    const content = '```json\n\n  {"key": "value"}\n\n```';
    const result = parseJsonWithFenceStrip(content);
    expect(result).toEqual({ key: "value" });
  });

  it("handles \\r\\n line endings", () => {
    const content = '```json\r\n{"key": "value"}\r\n```';
    const result = parseJsonWithFenceStrip(content);
    expect(result).toEqual({ key: "value" });
  });
});
