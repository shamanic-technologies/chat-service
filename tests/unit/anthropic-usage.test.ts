import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CACHE_PRICED_PREFIXES,
  anthropicCachePriced,
  anthropicCostLines,
  anthropicPromptTokens,
  readAnthropicBilledTokens,
  sumAnthropicBilledTokens,
} from "../../src/lib/anthropic-usage.js";
import { resolveModel } from "../../src/lib/anthropic.js";

describe("readAnthropicBilledTokens", () => {
  it("reads the top-level counts when there is no compaction", () => {
    expect(readAnthropicBilledTokens({ input_tokens: 52, output_tokens: 44 })).toEqual({
      tokensInput: 52,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokensOutput: 44,
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
    ).toEqual({ tokensInput: 30, cacheReadTokens: 4_000, cacheWriteTokens: 900, tokensOutput: 7 });
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
    ).toEqual({ tokensInput: 123_000, cacheReadTokens: 6_000, cacheWriteTokens: 600, tokensOutput: 2_700 });
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
      anthropicPromptTokens({ tokensInput: 30, cacheReadTokens: 4_000, cacheWriteTokens: 900, tokensOutput: 7 }),
    ).toBe(4_930);
  });
});

describe("anthropicCostLines", () => {
  const billed = { tokensInput: 30, cacheReadTokens: 4_000, cacheWriteTokens: 900, tokensOutput: 7 };

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
      anthropicCostLines("anthropic-haiku-4.5", { tokensInput: 10, cacheReadTokens: 0, cacheWriteTokens: 0, tokensOutput: 5 }),
    ).toEqual([
      { costName: "anthropic-haiku-4.5-tokens-input", quantity: 10 },
      { costName: "anthropic-haiku-4.5-tokens-output", quantity: 5 },
    ]);
  });

  it("fails loud on cache tokens for a model with no cache-write price", () => {
    for (const prefix of ["anthropic-haiku-4.5", "anthropic-sonnet-4.6", "anthropic-opus-4.6"]) {
      expect(() => anthropicCostLines(prefix, billed)).toThrow(/cannot price/);
      expect(() =>
        anthropicCostLines(prefix, { tokensInput: 1, cacheReadTokens: 5, cacheWriteTokens: 0, tokensOutput: 1 }),
      ).toThrow(/cannot price/);
    }
  });

  it("sums turns before declaring (/chat tool loop)", () => {
    const total = sumAnthropicBilledTokens(billed, billed);
    expect(total).toEqual({ tokensInput: 60, cacheReadTokens: 8_000, cacheWriteTokens: 1_800, tokensOutput: 14 });
  });
});

describe("cache-priced models", () => {
  it("caches exactly the three models with cache-write rows, never haiku", () => {
    expect([...ANTHROPIC_CACHE_PRICED_PREFIXES].sort()).toEqual([
      "anthropic-fable-5.1",
      "anthropic-opus-5.5",
      "anthropic-sonnet-5.5",
    ]);
    expect(anthropicCachePriced(resolveModel("anthropic", "sonnet").costPrefix)).toBe(true);
    expect(anthropicCachePriced(resolveModel("anthropic", "opus").costPrefix)).toBe(true);
    expect(anthropicCachePriced(resolveModel("anthropic", "fable").costPrefix)).toBe(true);
    expect(anthropicCachePriced(resolveModel("anthropic", "haiku").costPrefix)).toBe(false);
  });
});
