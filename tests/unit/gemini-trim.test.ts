import { describe, it, expect } from "vitest";
import { trimGeminiHistoryToBudget, GEMINI_TRIM_TRIGGER_TOKENS, GEMINI_TRIM_TARGET_TOKENS } from "../../src/lib/gemini-trim.js";

const CHAR_PER_TOKEN = 4;

function makeMessage(role: "user" | "assistant", chars: number) {
  return { role, content: "x".repeat(chars) };
}

describe("trimGeminiHistoryToBudget", () => {
  it("returns history untouched when under trigger threshold", () => {
    const history = [
      makeMessage("user", 100),
      makeMessage("assistant", 200),
      makeMessage("user", 300),
    ];
    const result = trimGeminiHistoryToBudget(history);
    expect(result.history).toEqual(history);
    expect(result.trimmed).toBe(false);
  });

  it("drops oldest message pairs when over trigger threshold", () => {
    // 50 messages × 12k chars = 600k chars ≈ 150k tokens (> 100k trigger)
    const charsPerMessage = 12_000;
    const history = Array.from({ length: 50 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", charsPerMessage),
    );

    const result = trimGeminiHistoryToBudget(history);

    expect(result.trimmed).toBe(true);
    expect(result.history.length).toBeLessThan(history.length);
    // Should retain at least the last 4 messages (2 pairs)
    expect(result.history.length).toBeGreaterThanOrEqual(4);
    // Last messages preserved
    expect(result.history.at(-1)).toEqual(history.at(-1));
    expect(result.history.at(-2)).toEqual(history.at(-2));
    // Trimmed result under target
    const trimmedChars = result.history.reduce((sum, m) => sum + m.content.length, 0);
    expect(trimmedChars / CHAR_PER_TOKEN).toBeLessThanOrEqual(GEMINI_TRIM_TARGET_TOKENS);
  });

  it("never trims to fewer than 2 messages even if last 2 exceed budget", () => {
    // One enormous user + assistant message pair > trigger
    const giant = GEMINI_TRIM_TRIGGER_TOKENS * CHAR_PER_TOKEN * 2;
    const history = [
      makeMessage("user", 50),
      makeMessage("assistant", 50),
      makeMessage("user", giant),
      makeMessage("assistant", giant),
    ];
    const result = trimGeminiHistoryToBudget(history);
    expect(result.history.length).toBeGreaterThanOrEqual(2);
    // Last two messages always present
    expect(result.history.at(-1)).toEqual(history.at(-1));
    expect(result.history.at(-2)).toEqual(history.at(-2));
  });

  it("handles empty history", () => {
    const result = trimGeminiHistoryToBudget([]);
    expect(result.history).toEqual([]);
    expect(result.trimmed).toBe(false);
  });
});
