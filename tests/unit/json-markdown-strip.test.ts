import { describe, it, expect, vi } from "vitest";
import { jsonrepair, JSONRepairError } from "jsonrepair";

// ---------------------------------------------------------------------------
// Mirrors parseModelJson from src/index.ts — progressive JSON repair for LLM output
// ---------------------------------------------------------------------------

interface JsonRepairContext {
  apiKey: string;
  model: string;
  isGemini: boolean;
}

const LLM_REPAIR_MAX_ROUNDS = 3;

function snippetAround(text: string, pos: number, radius = 200): string {
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  return (
    (start > 0 ? "..." : "") +
    text.slice(start, end) +
    (end < text.length ? "..." : "")
  );
}

/**
 * Minimal mock-friendly version: accepts an async llmRepairFn instead of
 * calling the real Gemini/Anthropic clients. The production code uses the
 * same logic but calls the real LLM; tests inject a fake.
 */
async function parseModelJson(
  raw: string,
  repairCtx?: JsonRepairContext,
  llmRepairFn?: (broken: string, diag: string) => Promise<string>,
): Promise<unknown> {
  const trimmed = raw.trim();

  // Attempt 1: direct parse
  try {
    return JSON.parse(trimmed);
  } catch { /* continue */ }

  // Attempt 2: jsonrepair
  let repairError: JSONRepairError | undefined;
  try {
    const repaired = jsonrepair(trimmed);
    return JSON.parse(repaired);
  } catch (err) {
    if (err instanceof JSONRepairError) {
      repairError = err;
    }
  }

  // Attempt 3: LLM-assisted repair (up to 3 rounds)
  if (repairCtx && llmRepairFn) {
    let current = trimmed;
    for (let round = 1; round <= LLM_REPAIR_MAX_ROUNDS; round++) {
      let diagnostic: string;
      try {
        return JSON.parse(current);
      } catch (parseErr) {
        const parseError = parseErr as SyntaxError & { message: string };
        const posMatch = parseError.message.match(/position\s+(\d+)/);
        const pos = posMatch ? parseInt(posMatch[1], 10) : undefined;
        diagnostic = `JSON.parse error: ${parseError.message}`;
        if (pos != null) {
          diagnostic += `\nContext around position ${pos}:\n${snippetAround(current, pos)}`;
        }
        if (repairError && round === 1) {
          diagnostic += `\njsonrepair also failed: ${repairError.message}`;
        }
      }

      try {
        const repaired = await llmRepairFn(current, diagnostic);
        const repairedTrimmed = repaired.trim();

        try {
          return JSON.parse(repairedTrimmed);
        } catch { /* continue */ }

        try {
          const doubleRepaired = jsonrepair(repairedTrimmed);
          return JSON.parse(doubleRepaired);
        } catch { /* continue */ }

        current = repairedTrimmed;
      } catch {
        break;
      }
    }
  }

  throw new Error(
    `Model returned non-parsable JSON despite responseFormat: "json". ` +
    `contentLen=${raw.length}, ` +
    `first500=${raw.slice(0, 500)}, ` +
    `last200=${raw.slice(-200)}`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseModelJson — JSON parsing with progressive repair", () => {
  // --- Attempt 1: Direct parse ---
  it("parses plain JSON object", async () => {
    expect(await parseModelJson('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("parses plain JSON array", async () => {
    expect(await parseModelJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it("handles leading/trailing whitespace", async () => {
    expect(await parseModelJson('  \n{"key": "value"}\n  ')).toEqual({ key: "value" });
  });

  // --- Attempt 2: jsonrepair ---
  it("strips ```json fences and parses", async () => {
    const content = '```json\n{"key": "value"}\n```';
    expect(await parseModelJson(content)).toEqual({ key: "value" });
  });

  it("strips ``` fences without json tag", async () => {
    const content = '```\n{"key": "value"}\n```';
    expect(await parseModelJson(content)).toEqual({ key: "value" });
  });

  it("strips ```JSON fences (case-insensitive)", async () => {
    const content = '```JSON\n{"items": [1, 2, 3]}\n```';
    expect(await parseModelJson(content)).toEqual({ items: [1, 2, 3] });
  });

  it("handles array responses wrapped in fences", async () => {
    const content = '```json\n[{"id": 1}, {"id": 2}]\n```';
    expect(await parseModelJson(content)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("handles fences with no trailing newline", async () => {
    const content = '```json\n{"ok": true}```';
    expect(await parseModelJson(content)).toEqual({ ok: true });
  });

  it("handles leading/trailing whitespace around fences", async () => {
    const content = '\n```json\n{"isArticle": false, "authors": [], "publishedAt": null}\n```\n';
    expect(await parseModelJson(content)).toEqual({ isArticle: false, authors: [], publishedAt: null });
  });

  it("handles whitespace inside fences around JSON", async () => {
    const content = '```json\n\n  {"key": "value"}\n\n```';
    expect(await parseModelJson(content)).toEqual({ key: "value" });
  });

  it("handles \\r\\n line endings", async () => {
    const content = '```json\r\n{"key": "value"}\r\n```';
    expect(await parseModelJson(content)).toEqual({ key: "value" });
  });

  it("repairs trailing comma in object", async () => {
    expect(await parseModelJson('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
  });

  it("repairs trailing comma in array", async () => {
    expect(await parseModelJson('["url1", "url2", "url3",]')).toEqual(["url1", "url2", "url3"]);
  });

  it("repairs trailing comma with whitespace", async () => {
    const content = '[\n  "https://example.com/a",\n  "https://example.com/b",\n]';
    expect(await parseModelJson(content)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("repairs trailing comma inside fenced JSON", async () => {
    const content = '```json\n{"items": [1, 2, 3,],}\n```';
    expect(await parseModelJson(content)).toEqual({ items: [1, 2, 3] });
  });

  it("repairs nested trailing commas", async () => {
    const content = '{"a": {"b": [1, 2,], "c": 3,},}';
    expect(await parseModelJson(content)).toEqual({ a: { b: [1, 2], c: 3 } });
  });

  // --- jsonrepair-specific: things the old manual repair couldn't handle ---
  it("repairs single quotes to double quotes", async () => {
    expect(await parseModelJson("{'key': 'value'}")).toEqual({ key: "value" });
  });

  it("repairs unquoted keys", async () => {
    expect(await parseModelJson("{key: \"value\"}")).toEqual({ key: "value" });
  });

  it("repairs missing closing bracket", async () => {
    expect(await parseModelJson('{"key": "value"')).toEqual({ key: "value" });
  });

  it("strips JavaScript comments", async () => {
    const content = '{"key": "value" /* comment */}';
    expect(await parseModelJson(content)).toEqual({ key: "value" });
  });

  // --- Error cases (no LLM repair context) ---
  // jsonrepair treats bare text as a valid JSON string, so we use text
  // surrounding JSON — the kind of thing LLMs actually produce — to trigger failure.
  const UNPARSABLE = 'Here is your JSON: {"key": "value"}. I hope this helps!';

  it("throws for truly unparsable content without repairCtx", async () => {
    await expect(parseModelJson(UNPARSABLE)).rejects.toThrow(
      "Model returned non-parsable JSON",
    );
  });

  it("includes contentLen and preview in error", async () => {
    await expect(parseModelJson(UNPARSABLE)).rejects.toThrow(/contentLen=\d+/);
    await expect(parseModelJson(UNPARSABLE)).rejects.toThrow(/first500=/);
    await expect(parseModelJson(UNPARSABLE)).rejects.toThrow(/last200=/);
  });
});

describe("parseModelJson — LLM-assisted repair", () => {
  const ctx: JsonRepairContext = { apiKey: "test-key", model: "test-model", isGemini: true };
  // Inputs that defeat both JSON.parse AND jsonrepair (text wrapping JSON)
  const BROKEN = 'Here is your JSON: {"key": "value"}. I hope this helps!';
  const BROKEN2 = 'Sure! Here is the result: {"a": 1}. Let me know if you need more.';
  const BROKEN3 = 'The output is: {"x": true}. Please review it carefully.';

  it("calls LLM when jsonrepair fails, succeeds on first round", async () => {
    const llmRepairFn = vi.fn().mockResolvedValueOnce('{"key": "value"}');

    const result = await parseModelJson(BROKEN, ctx, llmRepairFn);
    expect(result).toEqual({ key: "value" });
    expect(llmRepairFn).toHaveBeenCalledTimes(1);
    // Verify diagnostic is passed
    expect(llmRepairFn.mock.calls[0][1]).toContain("JSON.parse error:");
  });

  it("retries when first LLM round still returns broken JSON", async () => {
    const llmRepairFn = vi
      .fn()
      .mockResolvedValueOnce(BROKEN2)
      .mockResolvedValueOnce('{"fixed": true}');

    const result = await parseModelJson(BROKEN, ctx, llmRepairFn);
    expect(result).toEqual({ fixed: true });
    expect(llmRepairFn).toHaveBeenCalledTimes(2);
  });

  it("succeeds on third round", async () => {
    const llmRepairFn = vi
      .fn()
      .mockResolvedValueOnce(BROKEN2)
      .mockResolvedValueOnce(BROKEN3)
      .mockResolvedValueOnce('{"ok": true}');

    const result = await parseModelJson(BROKEN, ctx, llmRepairFn);
    expect(result).toEqual({ ok: true });
    expect(llmRepairFn).toHaveBeenCalledTimes(3);
  });

  it("throws after 3 failed LLM rounds", async () => {
    const llmRepairFn = vi
      .fn()
      .mockResolvedValueOnce(BROKEN)
      .mockResolvedValueOnce(BROKEN2)
      .mockResolvedValueOnce(BROKEN3);

    await expect(parseModelJson(BROKEN, ctx, llmRepairFn)).rejects.toThrow(
      "Model returned non-parsable JSON",
    );
    expect(llmRepairFn).toHaveBeenCalledTimes(3);
  });

  it("stops retrying if LLM call itself throws", async () => {
    const llmRepairFn = vi.fn().mockRejectedValueOnce(new Error("API error"));

    await expect(parseModelJson(BROKEN, ctx, llmRepairFn)).rejects.toThrow(
      "Model returned non-parsable JSON",
    );
    expect(llmRepairFn).toHaveBeenCalledTimes(1);
  });

  it("applies jsonrepair to LLM output as fallback", async () => {
    // LLM returns something with trailing commas — jsonrepair can fix it
    const llmRepairFn = vi.fn().mockResolvedValueOnce('{"a": 1, "b": 2,}');

    const result = await parseModelJson(BROKEN, ctx, llmRepairFn);
    expect(result).toEqual({ a: 1, b: 2 });
    expect(llmRepairFn).toHaveBeenCalledTimes(1);
  });

  it("does not call LLM when repairCtx is not provided", async () => {
    await expect(parseModelJson(BROKEN)).rejects.toThrow("Model returned non-parsable JSON");
  });

  it("includes jsonrepair error in diagnostic on first round", async () => {
    const llmRepairFn = vi.fn().mockResolvedValueOnce('{"ok": true}');

    await parseModelJson(BROKEN, ctx, llmRepairFn);
    const diagnostic = llmRepairFn.mock.calls[0][1] as string;
    expect(diagnostic).toContain("jsonrepair also failed:");
  });
});

describe("snippetAround", () => {
  it("returns full text if shorter than 2*radius", () => {
    const text = '{"short": "text"}';
    const result = snippetAround(text, 5, 200);
    expect(result).toBe(text);
  });

  it("adds ellipsis for text exceeding radius", () => {
    const text = "A".repeat(600);
    const result = snippetAround(text, 300, 50);
    expect(result.startsWith("...")).toBe(true);
    expect(result.endsWith("...")).toBe(true);
    // 100 chars from the text + 6 chars for "..." on each side
    expect(result.length).toBe(106);
  });

  it("no leading ellipsis when position is near start", () => {
    const text = "A".repeat(600);
    const result = snippetAround(text, 10, 50);
    expect(result.startsWith("...")).toBe(false);
    expect(result.endsWith("...")).toBe(true);
  });

  it("no trailing ellipsis when position is near end", () => {
    const text = "A".repeat(600);
    const result = snippetAround(text, 590, 50);
    expect(result.startsWith("...")).toBe(true);
    expect(result.endsWith("...")).toBe(false);
  });
});
