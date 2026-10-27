import { describe, it, expect } from "vitest";
import { EMPTY_ANSWER_NOTE, FINAL_ROUND_NOTE, isFinalToolRound, MAX_TOOL_CHAIN_DEPTH, needsAnswerNudge } from "../../src/lib/tool-budget.js";

describe("tool budget of a /chat turn", () => {
  it("allows MAX_TOOL_CHAIN_DEPTH tool rounds, then one final round with tools off", () => {
    expect(MAX_TOOL_CHAIN_DEPTH).toBe(10);
    for (let depth = 0; depth < MAX_TOOL_CHAIN_DEPTH; depth++) expect(isFinalToolRound(depth)).toBe(false);
    expect(isFinalToolRound(MAX_TOOL_CHAIN_DEPTH)).toBe(true);
  });

  it("tells the model to answer now", () => {
    expect(FINAL_ROUND_NOTE).toMatch(/no more tool calls/);
    expect(FINAL_ROUND_NOTE).toMatch(/Answer the user now/);
  });

  // SOPHIE-NO-ANSWER-1028: a turn that ran tools and ended silent is re-asked
  // once, tools off, instead of sending the canned fallback.
  it("re-asks once a turn whose tools ran but whose answer is empty", () => {
    expect(needsAnswerNudge({ toolsRan: true, answerText: "", alreadyNudged: false })).toBe(true);
    expect(needsAnswerNudge({ toolsRan: true, answerText: "  \n", alreadyNudged: false })).toBe(true);
    expect(needsAnswerNudge({ toolsRan: true, answerText: "", alreadyNudged: true })).toBe(false);
    expect(needsAnswerNudge({ toolsRan: true, answerText: "Here you go", alreadyNudged: false })).toBe(false);
    expect(needsAnswerNudge({ toolsRan: false, answerText: "", alreadyNudged: false })).toBe(false);
    expect(EMPTY_ANSWER_NOTE).toMatch(/Write your answer now/);
    expect(EMPTY_ANSWER_NOTE).toMatch(/no more tool calls/);
  });
});
