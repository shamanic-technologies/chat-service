// ---------------------------------------------------------------------------
// Tool-result fallback summary
// ---------------------------------------------------------------------------
//
// When an agentic chat turn runs one or more tools but the model's follow-up
// "summarize" turn comes back with NO text, the chat must never surface to the
// user as silence (a frozen tool card with no reply). This builds a readable
// fallback assistant message from the raw tool results so the user always sees
// what the tools returned — provider-agnostic (used by both the Gemini and
// Anthropic agentic loops).
//
// This is a SAFETY NET, not the happy path: the model normally writes its own
// summary. The fallback only fires when that summary is empty, and it renders
// the REAL tool results (no fabricated data), alongside a loud server log so
// the empty-turn root cause stays diagnosable.

const MAX_RENDERED_RESULT_CHARS = 4000;

/** Render a single tool result as readable markdown, truncated for safety. */
function renderToolResult(result: unknown): string {
  if (result === null || result === undefined) return "_(no result)_";
  if (typeof result === "string") {
    return result.length > MAX_RENDERED_RESULT_CHARS
      ? result.slice(0, MAX_RENDERED_RESULT_CHARS) + "…"
      : result;
  }
  let json: string;
  try {
    json = JSON.stringify(result, null, 2);
  } catch {
    json = String(result);
  }
  const body =
    json.length > MAX_RENDERED_RESULT_CHARS
      ? json.slice(0, MAX_RENDERED_RESULT_CHARS) + "\n…"
      : json;
  return "```json\n" + body + "\n```";
}

/**
 * Build a fallback assistant message summarizing the tool calls that ran when
 * the model produced no summary text of its own. Always returns a non-empty
 * string when `toolCalls` is non-empty.
 */
export function buildToolResultFallback(
  toolCalls: Array<{ name: string; result?: unknown }>,
): string {
  if (toolCalls.length === 0) return "";
  const header =
    "I retrieved the requested information, but couldn't generate a written " +
    "summary this time. Here is what the tools returned:";
  const blocks = toolCalls.map(
    (tc) => `**${tc.name}**\n${renderToolResult(tc.result)}`,
  );
  return [header, ...blocks].join("\n\n");
}
