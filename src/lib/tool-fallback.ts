// ---------------------------------------------------------------------------
// Tool-result fallback answer
// ---------------------------------------------------------------------------
//
// When an agentic chat turn runs one or more tools but the model's follow-up
// turn comes back with NO text, even after the one re-ask (`EMPTY_ANSWER_NOTE`
// in `tool-budget.ts`), the chat must never surface as silence (a frozen tool
// card with no reply). This builds a short assistant message in plain words.
// It does NOT name the tools nor paste their results: raw JSON is
// unreadable for a person and, for an agent driving the chat through the MCP,
// made the answer too big to hand back (prod 2026-10-12: 22 results, 339 KB).
// The results are already on the turn's `tool_result` events and in history.
//
// This is a SAFETY NET, not the happy path: the final round of the tool budget
// and the empty-answer re-ask (`tool-budget.ts`) make the model answer. It
// fires only when the model stayed silent twice, with a loud server log.

/**
 * Build a fallback assistant message for a turn whose tools ran but whose
 * model wrote no answer. Always returns a non-empty string when `toolCalls`
 * is non-empty.
 */
export function buildToolResultFallback(
  toolCalls: Array<{ name: string; result?: unknown }>,
): string {
  if (toolCalls.length === 0) return "";
  // Plain words, no tool names: the person never sees our tools (prod
  // 2026-10-27, WhatsApp: "I looked this up (list_staff_requests, ...)").
  return "Sorry, my answer did not come through. Can you send your message again?";
}
