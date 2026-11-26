// ---------------------------------------------------------------------------
// Gemini history trimming — keep the prompt within a 200k-token budget so
// Gemini stays in the same context window class as Claude (no opt-in to the
// 1M-token tier).
//
// Strategy: heuristic estimate (chars / 4) on the message history. When the
// estimate exceeds GEMINI_TRIM_TRIGGER_TOKENS, drop the oldest messages until
// the running estimate falls under GEMINI_TRIM_TARGET_TOKENS. The last 2
// messages are always preserved so the model still sees the immediate turn.
// ---------------------------------------------------------------------------

// A message stored more than STALE_HISTORY_MS before this turn is dropped first
// (COPILOT-LATENCY-1125, prod 2026-11-25): the dashboard keeps one Copilot
// session per person for weeks, so "état des lieux de mes offers" re-sent ~60k
// tokens of three-week-old hot-lead turns on each of its 11 rounds (107-124k
// input a call, 4 min for one answer). The account itself is read fresh every
// turn (client brief, situation brief, tools); the last exchange is always kept.
export const STALE_HISTORY_MS = 24 * 60 * 60_000;

export const GEMINI_TRIM_TRIGGER_TOKENS = 100_000;
export const GEMINI_TRIM_TARGET_TOKENS = 60_000;
const CHARS_PER_TOKEN = 4;
const MIN_KEEP_MESSAGES = 2;

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  /** When the message was stored; a message without it is never dropped for its age. */
  createdAt?: Date | string | null;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
  }> | null;
}

export interface TrimResult {
  history: HistoryMessage[];
  trimmed: boolean;
  estimatedInputTokens: number;
}

function estimateTokens(messages: HistoryMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    if (m.toolCalls && m.toolCalls.length > 0) {
      chars += JSON.stringify(m.toolCalls).length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function trimGeminiHistoryToBudget(
  history: HistoryMessage[],
  now: Date = new Date(),
): TrimResult {
  let working = history.slice();
  const staleBefore = now.getTime() - STALE_HISTORY_MS;
  while (working.length > MIN_KEEP_MESSAGES && isStale(working[0], staleBefore)) working.shift();
  const droppedStale = working.length < history.length;

  const initialTokens = estimateTokens(working);
  if (initialTokens <= GEMINI_TRIM_TRIGGER_TOKENS) {
    return { history: working, trimmed: droppedStale, estimatedInputTokens: initialTokens };
  }

  while (
    working.length > MIN_KEEP_MESSAGES &&
    estimateTokens(working) > GEMINI_TRIM_TARGET_TOKENS
  ) {
    working.shift();
  }

  return {
    history: working,
    trimmed: true,
    estimatedInputTokens: estimateTokens(working),
  };
}

function isStale(m: HistoryMessage, staleBefore: number): boolean {
  if (!m.createdAt) return false;
  const at = new Date(m.createdAt).getTime();
  return Number.isFinite(at) && at < staleBefore;
}
