// ---------------------------------------------------------------------------
// Tool-result fallback answer
// ---------------------------------------------------------------------------
//
// When an agentic chat turn runs one or more tools but the model's follow-up
// turn comes back with NO text, the chat must never surface as silence (a
// frozen tool card with no reply). This builds a short assistant message
// naming what was looked up. It does NOT paste the tool results: raw JSON is
// unreadable for a person and, for an agent driving the chat through the MCP,
// made the answer too big to hand back (prod 2026-10-12: 22 results, 339 KB).
// The results are already on the turn's `tool_result` events and in history.
//
// This is a SAFETY NET, not the happy path: the final round of the tool budget
// (`tool-budget.ts`) makes the model answer. It fires only when that answer is
// still empty, alongside a loud server log so the root cause stays findable.

/**
 * Build a fallback assistant message for a turn whose tools ran but whose
 * model wrote no answer. Always returns a non-empty string when `toolCalls`
 * is non-empty.
 */
export function buildToolResultFallback(
  toolCalls: Array<{ name: string; result?: unknown }>,
): string {
  if (toolCalls.length === 0) return "";
  const names = [...new Set(toolCalls.map((tc) => tc.name))];
  return (
    `I looked this up (${names.join(", ")}) but did not finish writing the answer. ` +
    "Ask me again and I will pick up from there."
  );
}
