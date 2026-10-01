import { describe, expect, it } from "vitest";
import { readAnthropicBilledTokens } from "../../src/lib/anthropic-usage.js";

describe("readAnthropicBilledTokens (/chat stream)", () => {
  it("reads the top-level counts when there is no compaction", () => {
    expect(readAnthropicBilledTokens({ input_tokens: 52, output_tokens: 44 })).toEqual({ tokensInput: 52, tokensOutput: 44 });
  });

  it("sums every iteration when compaction ran (top-level covers the last sampling only)", () => {
    expect(
      readAnthropicBilledTokens({
        input_tokens: 3_000,
        output_tokens: 200,
        iterations: [
          { type: "compaction", input_tokens: 120_000, output_tokens: 2_500 },
          { type: "message", input_tokens: 3_000, output_tokens: 200 },
        ],
      }),
    ).toEqual({ tokensInput: 123_000, tokensOutput: 2_700 });
  });

  it("fails loud on cache tokens the catalog cannot price", () => {
    expect(() =>
      readAnthropicBilledTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4_000 }),
    ).toThrow(/cache tokens/);
    expect(() =>
      readAnthropicBilledTokens({
        input_tokens: 10,
        output_tokens: 5,
        iterations: [{ type: "message", input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 900 }],
      }),
    ).toThrow(/cache tokens/);
  });
});
