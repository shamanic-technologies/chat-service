/**
 * Anthropic `usage` → the tokens Anthropic BILLS for one /chat stream.
 *
 * With server-side compaction on, the top-level `input_tokens` / `output_tokens`
 * cover only the final sampling: each compaction pass is a separate sampling
 * listed in `usage.iterations`, and Anthropic bills every iteration. So when
 * `iterations` is present the billed counts are its SUMS.
 *
 * Cache reads and writes are billed outside `input_tokens` (writes at 1.25x,
 * reads at 0.1x) and the catalog prices neither for Anthropic, so /chat sends
 * no `cache_control`. A non-zero cache count means something started caching:
 * throw rather than drop tokens Anthropic billed.
 */
export interface AnthropicUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  iterations?: Array<{
    type?: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  }> | null;
}

export function readAnthropicBilledTokens(usage: AnthropicUsageLike): { tokensInput: number; tokensOutput: number } {
  const parts = usage.iterations && usage.iterations.length > 0 ? usage.iterations : [usage];
  const cached = parts.reduce(
    (sum, p) => sum + (p.cache_creation_input_tokens ?? 0) + (p.cache_read_input_tokens ?? 0),
    (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
  );
  if (cached > 0) {
    throw new Error(
      `[anthropic] usage reports cache tokens the catalog cannot price | usage=${JSON.stringify(usage)}`,
    );
  }
  return {
    tokensInput: parts.reduce((sum, p) => sum + p.input_tokens, 0),
    tokensOutput: parts.reduce((sum, p) => sum + p.output_tokens, 0),
  };
}
