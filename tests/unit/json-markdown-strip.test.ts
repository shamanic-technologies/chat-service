import { describe, it, expect } from "vitest";

/**
 * Mirrors the markdown-fence stripping logic in src/index.ts /complete handler.
 * If JSON.parse fails on raw content, strip ```json fences and retry.
 */
function parseJsonWithFenceStrip(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    const stripped = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    try {
      return JSON.parse(stripped);
    } catch {
      return null;
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

  it("returns null for truly unparsable content", () => {
    const result = parseJsonWithFenceStrip("This is not JSON at all");
    expect(result).toBeNull();
  });

  it("returns null for fenced non-JSON content", () => {
    const content = '```json\nnot actually json\n```';
    const result = parseJsonWithFenceStrip(content);
    expect(result).toBeNull();
  });

  it("handles fences with no trailing newline", () => {
    const content = '```json\n{"ok": true}```';
    const result = parseJsonWithFenceStrip(content);
    expect(result).toEqual({ ok: true });
  });
});
