import { describe, it, expect } from "vitest";
import {
  buildNudgeState,
  nudgeVerdict,
  NUDGE_QUESTION,
  NUDGE_QUESTION_KEY,
  NUDGE_SPEAK_THRESHOLD,
  NUDGE_TRIGGER_MESSAGE,
  type NudgeTurn,
} from "../../src/lib/copilot-nudge.js";

const now = new Date("2026-10-15T10:10:00.000Z");
const at = (iso: string) => new Date(iso);
const turn = (o: Partial<NudgeTurn>): NudgeTurn => ({
  role: "user",
  content: "",
  createdAt: at("2026-10-15T10:00:00.000Z"),
  proactiveTrigger: false,
  hasChoices: false,
  ...o,
});

describe("buildNudgeState", () => {
  it("passes the context through and says when the Copilot last spoke first", () => {
    const state = buildNudgeState(
      { currentPage: "offer-today", recentActions: [{ kind: "page", label: "/v2" }] },
      [
        turn({ role: "user", content: "hi", createdAt: at("2026-10-15T10:00:00.000Z") }),
        turn({ role: "assistant", content: "Hello.", createdAt: at("2026-10-15T10:00:05.000Z") }),
        turn({ role: "user", content: NUDGE_TRIGGER_MESSAGE, proactiveTrigger: true, createdAt: at("2026-10-15T10:09:30.000Z") }),
        turn({ role: "assistant", content: "Want to see your funnels?", hasChoices: true, createdAt: at("2026-10-15T10:09:35.000Z") }),
      ],
      now,
    );
    expect(state.context).toEqual({ currentPage: "offer-today", recentActions: [{ kind: "page", label: "/v2" }] });
    expect(state.secondsSinceLastProactiveMessage).toBe(30);
    expect(state.secondsSinceLastUserMessage).toBe(600);
    expect(state.copilotIsWaitingForAnAnswer).toBe(true);
    // The hidden trigger is never shown to Jev as something the user said.
    const turns = state.lastTurns as Array<{ from: string; text: string }>;
    expect(turns.map((t) => t.from)).toEqual(["user", "copilot", "copilot"]);
    expect(turns.some((t) => t.text.includes("Not written by the user"))).toBe(false);
  });

  it("a new chat has no timing yet", () => {
    const state = buildNudgeState(undefined, [], now);
    expect(state).toMatchObject({
      context: {},
      secondsSinceLastProactiveMessage: null,
      secondsSinceLastUserMessage: null,
      copilotIsWaitingForAnAnswer: false,
      lastTurns: [],
    });
  });

  it("cuts long turns and keeps only the latest few", () => {
    const many = Array.from({ length: 10 }, (_, i) => turn({ role: i % 2 ? "assistant" : "user", content: `t${i} ${"x".repeat(1000)}` }));
    const turns = buildNudgeState({}, many, now).lastTurns as Array<{ text: string }>;
    expect(turns).toHaveLength(6);
    expect(turns[0].text.startsWith("t4")).toBe(true);
    expect(turns[0].text.length).toBeLessThanOrEqual(601);
  });
});

describe("nudgeVerdict", () => {
  it("speaks at or above the threshold, stays quiet below it", () => {
    expect(nudgeVerdict({ [NUDGE_QUESTION_KEY]: { type: "noul", noul: 0.9 } }).speak).toBe(true);
    expect(nudgeVerdict({ [NUDGE_QUESTION_KEY]: { type: "noul", noul: NUDGE_SPEAK_THRESHOLD } }).speak).toBe(true);
    expect(nudgeVerdict({ [NUDGE_QUESTION_KEY]: { type: "noul", noul: 0.5 } }).speak).toBe(false);
  });

  it("throws on a missing or mistyped answer instead of guessing", () => {
    expect(() => nudgeVerdict({})).toThrow(/speak_first/);
    expect(() =>
      nudgeVerdict({ [NUDGE_QUESTION_KEY]: { type: "choice", choice: "a", confidence: 1, probabilities: { a: 1 } } }),
    ).toThrow();
  });

  it("asks one yes/no question that names the three quiet cases", () => {
    expect(NUDGE_QUESTION.type).toBe("noul");
    const no = (NUDGE_QUESTION as { criteria: { false: string } }).criteria.false;
    expect(no).toMatch(/progressing/);
    expect(no).toMatch(/secondsSinceLastProactiveMessage/);
    expect(no).toMatch(/typing or answering/);
  });
});
