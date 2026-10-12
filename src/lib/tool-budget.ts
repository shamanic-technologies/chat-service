// ---------------------------------------------------------------------------
// Tool budget of one /chat turn — shared by the Anthropic and Gemini loops.
//
// A turn may call tools for MAX_TOOL_CHAIN_DEPTH rounds. The round after that
// is the FINAL round: the model is called with tools switched off (Anthropic
// `tool_choice: none`, Gemini `functionCallingConfig.mode: NONE`) and told its
// budget is spent, so it writes an answer from what it already has. Without
// it, a turn that kept calling tools ended with no text at all and the user
// got the raw tool fallback (prod 2026-10-12, Copilot: 22 calls, 339 KB SSE).
// ---------------------------------------------------------------------------

export const MAX_TOOL_CHAIN_DEPTH = 10;

/** True for the round where tools are off and the model must answer. */
export function isFinalToolRound(depth: number): boolean {
  return depth >= MAX_TOOL_CHAIN_DEPTH;
}

/** Sent beside the last tool results, before the final round. */
export const FINAL_ROUND_NOTE =
  "Tool budget for this turn is used up: no more tool calls. Answer the user now " +
  "with what you already have, and say plainly what is still missing.";
