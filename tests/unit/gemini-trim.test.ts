import { describe, it, expect } from "vitest";
import { trimGeminiHistoryToBudget, GEMINI_TRIM_TRIGGER_TOKENS, GEMINI_TRIM_TARGET_TOKENS, STALE_HISTORY_MS } from "../../src/lib/gemini-trim.js";

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

  // COPILOT-LATENCY-1125 (prod 2026-11-25): 3-week-old turns re-sent on every round of a new question.
  it("drops messages older than a day first, keeps the recent ones and always the last exchange", () => {
    const now = new Date("2026-11-25T11:05:51Z");
    const old = (role: "user" | "assistant") => ({ role, content: "old", createdAt: new Date("2026-11-07T22:43:52Z") });
    const recent = (role: "user" | "assistant") => ({ role, content: "recent", createdAt: new Date(now.getTime() - 60_000) });
    const r1 = trimGeminiHistoryToBudget([old("user"), old("assistant"), recent("user"), recent("assistant")], now);
    expect(r1.history.map((m) => m.content)).toEqual(["recent", "recent"]);
    expect(r1.trimmed).toBe(true);
    const r2 = trimGeminiHistoryToBudget([old("user"), old("assistant"), old("user"), old("assistant")], now);
    expect(r2.history).toHaveLength(2);
    const undated = [makeMessage("user", 10), makeMessage("assistant", 10)];
    expect(trimGeminiHistoryToBudget(undated, now)).toEqual({ history: undated, trimmed: false, estimatedInputTokens: 5 });
    expect(STALE_HISTORY_MS).toBe(24 * 60 * 60_000);
  });
});
