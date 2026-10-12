import { describe, it, expect } from "vitest";
import { FINAL_ROUND_NOTE, isFinalToolRound, MAX_TOOL_CHAIN_DEPTH } from "../../src/lib/tool-budget.js";

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
});
