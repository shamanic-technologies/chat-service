import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CACHE_PRICED_PREFIXES,
  anthropicCachePriced,
  anthropicCostLines,
  anthropicPromptTokens,
  readAnthropicBilledTokens,
  mergeCostLines,
} from "../../src/lib/anthropic-usage.js";
import { resolveModel } from "../../src/lib/anthropic.js";

describe("readAnthropicBilledTokens", () => {
  it("reads the top-level counts when there is no compaction", () => {
    expect(readAnthropicBilledTokens({ input_tokens: 52, output_tokens: 44 })).toEqual({
      tokensInput: 52,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokensOutput: 44,
      requestPromptTokens: 52,
    });
  });

  it("splits cache reads and writes out of the uncached input", () => {
    expect(
      readAnthropicBilledTokens({
        input_tokens: 30,
        output_tokens: 7,
        cache_read_input_tokens: 4_000,
        cache_creation_input_tokens: 900,
        cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 },
      }),
    ).toEqual({ tokensInput: 30, cacheReadTokens: 4_000, cacheWriteTokens: 900, tokensOutput: 7, requestPromptTokens: 4_930 });
  });

  it("sums every iteration, cache fields included, when compaction ran", () => {
    expect(
      readAnthropicBilledTokens({
        input_tokens: 3_000,
        output_tokens: 200,
        cache_read_input_tokens: 1_000,
        iterations: [
          { type: "compaction", input_tokens: 120_000, output_tokens: 2_500, cache_read_input_tokens: 5_000 },
          {
            type: "message",
            input_tokens: 3_000,
            output_tokens: 200,
            cache_read_input_tokens: 1_000,
            cache_creation_input_tokens: 600,
          },
        ],
      }),
    ).toEqual({
      tokensInput: 123_000,
      cacheReadTokens: 6_000,
      cacheWriteTokens: 600,
      tokensOutput: 2_700,
      // The largest single sampling's prompt picks the tier, never the sum.
      requestPromptTokens: 125_000,
    });
  });

  it("fails loud on a 1-hour cache write (never requested, not priced)", () => {
    expect(() =>
      readAnthropicBilledTokens({
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 900,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 },
      }),
    ).toThrow(/1-hour/);
  });

  it("counts every prompt token in anthropicPromptTokens", () => {
    expect(
      anthropicPromptTokens({ tokensInput: 30, cacheReadTokens: 4_000, cacheWriteTokens: 900, tokensOutput: 7, requestPromptTokens: 4_930 }),
    ).toBe(4_930);
  });
});

describe("anthropicCostLines", () => {
  const billed = { tokensInput: 30, cacheReadTokens: 4_000, cacheWriteTokens: 900, tokensOutput: 7, requestPromptTokens: 4_930 };

  it("declares the four billed dimensions under their catalog names", () => {
    const lines = anthropicCostLines("anthropic-sonnet-5.5", billed);
    expect(lines).toEqual([
      { costName: "anthropic-sonnet-5.5-tokens-input", quantity: 30 },
      { costName: "anthropic-sonnet-5.5-tokens-cached-input", quantity: 4_000 },
      { costName: "anthropic-sonnet-5.5-tokens-cache-write-5m", quantity: 900 },
      { costName: "anthropic-sonnet-5.5-tokens-output", quantity: 7 },
    ]);
    // Sum of declared prompt quantities = what Anthropic reported.
    const declaredPrompt = lines.filter((l) => !l.costName.endsWith("-output")).reduce((s, l) => s + l.quantity, 0);
    expect(declaredPrompt).toBe(anthropicPromptTokens(billed));
  });

  it("omits zero lines (no cache rows on an uncached call)", () => {
    expect(
      anthropicCostLines("anthropic-haiku-4.5", { tokensInput: 10, cacheReadTokens: 0, cacheWriteTokens: 0, tokensOutput: 5, requestPromptTokens: 10 }),
    ).toEqual([
      { costName: "anthropic-haiku-4.5-tokens-input", quantity: 10 },
      { costName: "anthropic-haiku-4.5-tokens-output", quantity: 5 },
    ]);
  });

  it("fails loud on cache tokens for a model with no cache-write price", () => {
    for (const prefix of ["anthropic-haiku-4.5", "anthropic-sonnet-4.6", "anthropic-opus-4.6"]) {
      expect(() => anthropicCostLines(prefix, billed)).toThrow(/cannot price/);
      expect(() =>
        anthropicCostLines(prefix, { tokensInput: 1, cacheReadTokens: 5, cacheWriteTokens: 0, tokensOutput: 1, requestPromptTokens: 6 }),
      ).toThrow(/cannot price/);
    }
  });

  it("merges per-request lines by name (/chat tool loop)", () => {
    const one = anthropicCostLines("anthropic-sonnet-5.5", billed);
    expect(mergeCostLines(one, one)).toEqual([
      { costName: "anthropic-sonnet-5.5-tokens-input", quantity: 60 },
      { costName: "anthropic-sonnet-5.5-tokens-cached-input", quantity: 8_000 },
      { costName: "anthropic-sonnet-5.5-tokens-cache-write-5m", quantity: 1_800 },
      { costName: "anthropic-sonnet-5.5-tokens-output", quantity: 14 },
    ]);
  });
});

describe("Haiku 5.5 prompt-length tier (100k)", () => {
  const P = "anthropic-haiku-5.5";

  it("declares a prompt of exactly 100,000 tokens at the standard rate", () => {
    const b = { tokensInput: 40_000, cacheReadTokens: 50_000, cacheWriteTokens: 10_000, tokensOutput: 9, requestPromptTokens: 100_000 };
    expect(anthropicCostLines(P, b).map((l) => l.costName)).toEqual([
      "anthropic-haiku-5.5-tokens-input",
      "anthropic-haiku-5.5-tokens-cached-input",
      "anthropic-haiku-5.5-tokens-cache-write-5m",
      "anthropic-haiku-5.5-tokens-output",
    ]);
  });

  it("declares EVERY dimension at the long-context rate once the prompt (cache included) passes 100k", () => {
    // 1k uncached + 99.5k cache read = 100.5k: over the line although input alone is tiny.
    const b = readAnthropicBilledTokens({ input_tokens: 1_000, output_tokens: 20, cache_read_input_tokens: 99_500 });
    expect(anthropicCostLines(P, b)).toEqual([
      { costName: "anthropic-haiku-5.5-long-context-tokens-input", quantity: 1_000 },
      { costName: "anthropic-haiku-5.5-long-context-tokens-cached-input", quantity: 99_500 },
      { costName: "anthropic-haiku-5.5-long-context-tokens-output", quantity: 20 },
    ]);
  });

  it("prices each /chat request on its own: one long turn never re-prices the short ones", () => {
    const short = readAnthropicBilledTokens({ input_tokens: 5_000, output_tokens: 100 });
    const long = readAnthropicBilledTokens({ input_tokens: 120_000, output_tokens: 50 });
    expect(mergeCostLines(anthropicCostLines(P, short), anthropicCostLines(P, long))).toEqual([
      { costName: "anthropic-haiku-5.5-tokens-input", quantity: 5_000 },
      { costName: "anthropic-haiku-5.5-tokens-output", quantity: 100 },
      { costName: "anthropic-haiku-5.5-long-context-tokens-input", quantity: 120_000 },
      { costName: "anthropic-haiku-5.5-long-context-tokens-output", quantity: 50 },
    ]);
  });

  it("never applies a long-context tier to a model Anthropic prices flat", () => {
    const b = readAnthropicBilledTokens({ input_tokens: 500_000, output_tokens: 1 });
    expect(anthropicCostLines("anthropic-sonnet-5.5", b)[0].costName).toBe("anthropic-sonnet-5.5-tokens-input");
  });
});

describe("cache-priced models", () => {
  it("caches exactly the four models with cache-write rows, never a legacy prefix", () => {
    expect([...ANTHROPIC_CACHE_PRICED_PREFIXES].sort()).toEqual([
      "anthropic-fable-5.1",
      "anthropic-haiku-5.5",
      "anthropic-opus-5.5",
      "anthropic-sonnet-5.5",
    ]);
    expect(anthropicCachePriced(resolveModel("anthropic", "sonnet").costPrefix)).toBe(true);
    expect(anthropicCachePriced(resolveModel("anthropic", "opus").costPrefix)).toBe(true);
    expect(anthropicCachePriced(resolveModel("anthropic", "fable").costPrefix)).toBe(true);
    expect(anthropicCachePriced(resolveModel("anthropic", "haiku").costPrefix)).toBe(true);
    expect(anthropicCachePriced("anthropic-haiku-4.5")).toBe(false);
  });
});
