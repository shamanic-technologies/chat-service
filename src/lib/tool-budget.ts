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

/**
 * A turn whose tools ran but whose model then ended with NO text gets ONE more
 * round, tools off, with this note beside the last tool results (both loops).
 * Prod 2026-10-27 (SOPHIE-NO-ANSWER-1028): the Copilot ran 15 tools, the final
 * round came back empty, and the person got "did not finish writing the
 * answer" on WhatsApp. The person always gets an answer; the canned fallback
 * is only for a model that stays silent twice.
 */
export const EMPTY_ANSWER_NOTE =
  "You ended your turn without writing anything to the person. Write your answer now, " +
  "from the conversation and what you already found: no more tool calls.";

/** True when a turn that ran tools ended silent and has not been re-asked yet. */
export function needsAnswerNudge(opts: { toolsRan: boolean; answerText: string; alreadyNudged: boolean }): boolean {
  return opts.toolsRan && !opts.alreadyNudged && opts.answerText.trim() === "";
}

/**
 * A turn that must END by calling one tool (ONE-AI-CONVERSES-1029: a Lead event
 * turn answers its caller through `answer_person`). Tools are never switched
 * off for it (the answer IS a tool call): the final round and the re-ask say
 * to call that tool now instead, in both loops.
 */
export function endToolFinalNote(toolName: string): string {
  return `Tool budget for this turn is used up: call ${toolName} now with what you already have. No other tool.`;
}

/** Sent once when a turn that must end on `toolName` stopped without calling it. */
export function endToolNudgeNote(toolName: string): string {
  return `You ended your turn without calling ${toolName}. Your turn only counts once you call it: call ${toolName} now, from the conversation and what you already found.`;
}
