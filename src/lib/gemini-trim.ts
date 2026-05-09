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

export const GEMINI_TRIM_TRIGGER_TOKENS = 100_000;
export const GEMINI_TRIM_TARGET_TOKENS = 60_000;
const CHARS_PER_TOKEN = 4;
const MIN_KEEP_MESSAGES = 2;

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TrimResult {
  history: HistoryMessage[];
  trimmed: boolean;
  estimatedInputTokens: number;
}

function estimateTokens(messages: HistoryMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function trimGeminiHistoryToBudget(
  history: HistoryMessage[],
): TrimResult {
  const initialTokens = estimateTokens(history);
  if (initialTokens <= GEMINI_TRIM_TRIGGER_TOKENS) {
    return { history, trimmed: false, estimatedInputTokens: initialTokens };
  }

  // Drop oldest messages until under target, but never fewer than MIN_KEEP_MESSAGES.
  let working = history.slice();
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
