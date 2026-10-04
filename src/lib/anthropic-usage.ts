/**
 * Anthropic `usage` → the tokens Anthropic BILLS, and the catalog lines that
 * declare them.
 *
 * Anthropic bills one request along FOUR token dimensions, each its own
 * costs-service catalog name:
 *   • `input_tokens`                → `<prefix>-tokens-input` (only the tokens
 *     AFTER the last cache breakpoint — it excludes both cache counts)
 *   • `cache_read_input_tokens`     → `<prefix>-tokens-cached-input` (0.1x input;
 *     0.05x on Opus 5.5, 0.025x on Fable 5.1 — the catalog row carries the rate)
 *   • `cache_creation_input_tokens` → `<prefix>-tokens-cache-write-5m` (1.25x
 *     input, 5-minute TTL — the only TTL this service ever requests)
 *   • `output_tokens`               → `<prefix>-tokens-output` (includes thinking)
 *
 * With server-side compaction on, the top-level counts cover only the final
 * sampling: each compaction pass is a separate sampling listed in
 * `usage.iterations`, and Anthropic bills every iteration. So when
 * `iterations` is present the billed counts are its SUMS, for all four fields.
 *
 * Prompt caching is turned on ONLY for a model whose cache-write AND cache-read
 * rows are live in the catalog (`ANTHROPIC_CACHE_PRICED_PREFIXES`). Any cache
 * count on another model — or any 1-hour cache write, which we never request
 * and do not price — THROWS rather than drop tokens Anthropic billed.
 */
export interface AnthropicUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  iterations?: Array<{
    type?: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  }> | null;
}

export interface AnthropicBilledTokens {
  /** Uncached input — billed at the full input rate. */
  tokensInput: number;
  /** Prompt tokens served from the cache. */
  cacheReadTokens: number;
  /** Prompt tokens written to the 5-minute cache. */
  cacheWriteTokens: number;
  tokensOutput: number;
}

export interface AnthropicCostLine {
  costName: string;
  quantity: number;
}

/**
 * Cost prefixes whose `-tokens-cached-input` AND `-tokens-cache-write-5m` rows
 * are live in costs-service PRODUCTION. Only these models get `cache_control`.
 * The legacy prefixes (haiku-4.5, sonnet-4.6, opus-4.6) have no cache-write
 * row, so they never cache. Adding a prefix here requires both rows in prod
 * first (`GET /v1/platform-prices/{name}` → 200), or runs-service 422s.
 */
export const ANTHROPIC_CACHE_PRICED_PREFIXES: ReadonlySet<string> = new Set([
  "anthropic-fable-5.1",
  "anthropic-sonnet-5.5",
  "anthropic-opus-5.5",
]);

export function anthropicCachePriced(costPrefix: string): boolean {
  return ANTHROPIC_CACHE_PRICED_PREFIXES.has(costPrefix);
}

export function readAnthropicBilledTokens(usage: AnthropicUsageLike): AnthropicBilledTokens {
  const parts = usage.iterations && usage.iterations.length > 0 ? usage.iterations : [usage];
  const sum = (pick: (p: (typeof parts)[number]) => number | null | undefined) =>
    parts.reduce((total, p) => total + (pick(p) ?? 0), 0);
  const oneHourWrites = sum((p) => p.cache_creation?.ephemeral_1h_input_tokens);
  if (oneHourWrites > 0) {
    throw new Error(
      `[anthropic] usage reports 1-hour cache writes the catalog cannot price | usage=${JSON.stringify(usage)}`,
    );
  }
  return {
    tokensInput: sum((p) => p.input_tokens),
    cacheReadTokens: sum((p) => p.cache_read_input_tokens),
    cacheWriteTokens: sum((p) => p.cache_creation_input_tokens),
    tokensOutput: sum((p) => p.output_tokens),
  };
}

export function sumAnthropicBilledTokens(a: AnthropicBilledTokens, b: AnthropicBilledTokens): AnthropicBilledTokens {
  return {
    tokensInput: a.tokensInput + b.tokensInput,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    tokensOutput: a.tokensOutput + b.tokensOutput,
  };
}

export const EMPTY_ANTHROPIC_BILLED_TOKENS: AnthropicBilledTokens = {
  tokensInput: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  tokensOutput: 0,
};

/** Every prompt token Anthropic processed, cached or not. */
export function anthropicPromptTokens(billed: AnthropicBilledTokens): number {
  return billed.tokensInput + billed.cacheReadTokens + billed.cacheWriteTokens;
}

/**
 * The catalog lines for one billed total. Zero-quantity lines are omitted.
 * Throws on a cache count for a model whose cache rows are not priced.
 */
export function anthropicCostLines(costPrefix: string, billed: AnthropicBilledTokens): AnthropicCostLine[] {
  if ((billed.cacheReadTokens > 0 || billed.cacheWriteTokens > 0) && !anthropicCachePriced(costPrefix)) {
    throw new Error(
      `[anthropic] "${costPrefix}" reports cache tokens the catalog cannot price ` +
        `| read=${billed.cacheReadTokens} write=${billed.cacheWriteTokens}`,
    );
  }
  const lines: AnthropicCostLine[] = [
    { costName: `${costPrefix}-tokens-input`, quantity: billed.tokensInput },
    { costName: `${costPrefix}-tokens-cached-input`, quantity: billed.cacheReadTokens },
    { costName: `${costPrefix}-tokens-cache-write-5m`, quantity: billed.cacheWriteTokens },
    { costName: `${costPrefix}-tokens-output`, quantity: billed.tokensOutput },
  ];
  return lines.filter((l) => l.quantity > 0);
}
