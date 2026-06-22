/**
 * Right-sized cost-provision estimates for synchronous completions.
 *
 * The provision step reserves an affordability HOLD against the org balance
 * BEFORE the LLM call (provision → authorize → execute → reconcile). The hold
 * is later reconciled to the real cost. It must NOT be confused with the
 * provider's hard output cap (`max_tokens` / `maxOutputTokens`), which exists
 * to prevent truncation and stays at the model's full budget unless the caller
 * explicitly declares a smaller one.
 *
 * Why this exists: previously every completion held the flat MODEL MAX
 * (64k output tokens) regardless of its realistic output. Under a high-fan-out
 * caller (e.g. human-service /orgs/audiences/suggest fans out into ~12-25
 * concurrent /complete calls), dozens of 64k holds stacked against the same org
 * balance in the same instant — billing-service counts provisioned cost as
 * already-spent for affordability — and drove a solvent $5 org transiently
 * NEGATIVE, falsely 402-ing the later siblings. Real spend per call was ~0.15c
 * (the 64k hold was ~768x the real cost). Right-sizing the hold to a realistic
 * per-call estimate keeps concurrent holds from blowing past a real balance,
 * while reconcile-to-actual keeps billing exact.
 */

/** Model output ceiling — the provider hard cap (truncation protection). */
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 64_000;

/**
 * Floor for the right-sized hold when the caller declares no maxTokens. Keeps
 * a small but non-trivial reservation so the affordability check is meaningful.
 */
export const MIN_OUTPUT_ESTIMATE_TOKENS = 1_000;

/**
 * Ceiling for the right-sized hold when the caller declares no maxTokens. A
 * generous upper bound for a typical service-to-service completion (JSON
 * generation, query/score/suggest lists) that is still ~8x below the model max,
 * so a burst of concurrent holds cannot falsely exhaust a solvent balance. The
 * reconcile step records the TRUE cost regardless, so an occasional larger
 * output is billed correctly — this bound only governs the pre-call hold.
 */
export const DEFAULT_OUTPUT_ESTIMATE_CEILING_TOKENS = 8_000;

/** Output-to-input scaling factor for the no-maxTokens estimate. */
const OUTPUT_PER_INPUT_RATIO = 2;

/**
 * Estimate input tokens from the prompt length (~4 chars/token), with a small
 * floor so a tiny prompt still reserves a sane minimum. Mirrors the historical
 * inline formula in /complete.
 */
export function estimateInputTokens(message: string): number {
  return Math.max(Math.ceil(message.length / 4), 500);
}

/**
 * Estimate realistic output tokens for the HOLD when the caller declares no
 * maxTokens. Scales modestly with prompt size (bigger prompts tend to yield
 * bigger answers) but is clamped to [MIN, CEILING] so it never approaches the
 * 64k model max — the whole point of right-sizing.
 */
export function estimateOutputTokens(inputTokens: number): number {
  const scaled = inputTokens * OUTPUT_PER_INPUT_RATIO;
  return Math.min(
    Math.max(scaled, MIN_OUTPUT_ESTIMATE_TOKENS),
    DEFAULT_OUTPUT_ESTIMATE_CEILING_TOKENS,
  );
}

export interface OutputBudget {
  /** Estimated input tokens (for the input-tokens hold). */
  inputTokens: number;
  /** Output-tokens quantity to PROVISION (the affordability hold). */
  holdOutputTokens: number;
  /** Output cap to send the provider (truncation protection / caller budget). */
  providerMaxOutputTokens: number;
}

/**
 * Resolve the provision hold + the provider output cap for one completion.
 *
 * - When the caller declares `maxTokens`, it is the exact output budget: it caps
 *   BOTH the hold AND the provider call (bounded to the model max). The hold is
 *   then precise, not a guess.
 * - When omitted, the hold is a right-sized estimate (well below 64k) and the
 *   provider keeps the full model max so long outputs are never truncated.
 */
export function resolveOutputBudget(opts: { message: string; maxTokens?: number }): OutputBudget {
  const inputTokens = estimateInputTokens(opts.message);

  if (opts.maxTokens != null) {
    const cap = Math.min(opts.maxTokens, DEFAULT_MODEL_MAX_OUTPUT_TOKENS);
    return { inputTokens, holdOutputTokens: cap, providerMaxOutputTokens: cap };
  }

  return {
    inputTokens,
    holdOutputTokens: estimateOutputTokens(inputTokens),
    providerMaxOutputTokens: DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  };
}
