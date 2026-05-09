// ---------------------------------------------------------------------------
// Context usage SSE event helper — emits how much of the model's context
// window the current turn consumed so the frontend can render a usage gauge.
// MAX_CONTEXT_TOKENS is fixed at 200k: it matches the Anthropic Sonnet limit
// and the upper bound enforced for Gemini via gemini-trim.ts (the service
// deliberately avoids the 1M-token Gemini tier).
// ---------------------------------------------------------------------------

export const MAX_CONTEXT_TOKENS = 200_000;

export interface ContextUsageEvent {
  type: "context_usage";
  inputTokens: number;
  outputTokens: number;
  maxTokens: number;
  percent: number;
}

export function buildContextUsageEvent(args: {
  inputTokens: number;
  outputTokens: number;
}): ContextUsageEvent {
  const inputTokens = Math.max(0, args.inputTokens);
  const outputTokens = Math.max(0, args.outputTokens);
  const ratio = inputTokens / MAX_CONTEXT_TOKENS;
  const percent = Math.min(100, Math.round(ratio * 100));
  return {
    type: "context_usage",
    inputTokens,
    outputTokens,
    maxTokens: MAX_CONTEXT_TOKENS,
    percent,
  };
}
