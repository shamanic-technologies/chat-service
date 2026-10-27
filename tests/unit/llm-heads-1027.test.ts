import { describe, it, expect } from "vitest";
import { vendorCostLines } from "../../src/lib/cost-names.js";
import { buildThinkingConfig, geminiCostPrefix } from "../../src/lib/gemini.js";
import { mapVendorResponse } from "../../src/lib/openai-compatible.js";
import { resolveModel } from "../../src/lib/anthropic.js";

// LLM-HEADS-1027 (owner 2026-10-27): GPT-6.1 Sol/Terra and Kimi K3.1 Pro become their
// lines' heads, Gemini 4 Argon is a new dynasty, and OpenAI cache writes + long context
// are declared at their own rates.
const AT = new Date("2026-10-27T12:00:00Z");

describe("vendorCostLines", () => {
  it("splits an OpenAI prompt into fresh input, cache hit and cache write", () => {
    expect(
      vendorCostLines({ provider: "openai", costPrefix: "openai-gpt-6.1-sol", at: AT, tokensInput: 4207, cachedInputTokens: 0, cacheWriteTokens: 4204, tokensOutput: 5 }),
    ).toEqual([
      { costName: "openai-gpt-6.1-sol-tokens-input", quantity: 3 },
      { costName: "openai-gpt-6.1-sol-tokens-cache-write", quantity: 4204 },
      { costName: "openai-gpt-6.1-sol-tokens-output", quantity: 5 },
    ]);
  });

  it("moves every dimension of an OpenAI request over 272K prompt tokens to the long-context rows", () => {
    const names = vendorCostLines({ provider: "openai", costPrefix: "openai-gpt-6.1-terra", at: AT, tokensInput: 272_001, cachedInputTokens: 1, cacheWriteTokens: 2, tokensOutput: 3 }).map((l) => l.costName);
    expect(names).toEqual([
      "openai-gpt-6.1-terra-long-context-tokens-input",
      "openai-gpt-6.1-terra-long-context-tokens-cached-input",
      "openai-gpt-6.1-terra-long-context-tokens-cache-write",
      "openai-gpt-6.1-terra-long-context-tokens-output",
    ]);
    // Exactly at the threshold is still the short-context tier.
    expect(vendorCostLines({ provider: "openai", costPrefix: "openai-gpt-6.1-terra", at: AT, tokensInput: 272_000, cachedInputTokens: 0, cacheWriteTokens: 0, tokensOutput: 1 })[0].costName).toBe("openai-gpt-6.1-terra-tokens-input");
  });

  it("keeps a Moonshot cache write in fresh input — Moonshot prices no write", () => {
    expect(
      vendorCostLines({ provider: "moonshot", costPrefix: "moonshot-kimi-k3.1-pro", at: AT, tokensInput: 4226, cachedInputTokens: 0, cacheWriteTokens: 4096, tokensOutput: 7 }),
    ).toEqual([
      { costName: "moonshot-kimi-k3.1-pro-tokens-input", quantity: 4226 },
      { costName: "moonshot-kimi-k3.1-pro-tokens-output", quantity: 7 },
    ]);
  });

  it("leaves DeepSeek's regime naming unchanged", () => {
    const names = vendorCostLines({ provider: "deepseek", costPrefix: "deepseek-v4.1-flash", at: new Date("2026-10-27T02:00:00Z"), tokensInput: 100, cachedInputTokens: 60, cacheWriteTokens: 0, tokensOutput: 4 }).map((l) => l.costName);
    expect(names).toEqual(["deepseek-v4.1-flash-peak-tokens-input", "deepseek-v4.1-flash-peak-tokens-cached-input", "deepseek-v4.1-flash-peak-tokens-output"]);
  });
});

describe("mapVendorResponse — cache writes", () => {
  const body = (usage: Record<string, unknown>, model: string) => ({ model, choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage });
  it("reads OpenAI's cache_write_tokens, disjoint from cache hits", () => {
    const r = mapVendorResponse("openai", "gpt-6.1-sol", body({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 90 } }, "gpt-6.1-sol"));
    expect(r.cachedInputTokens).toBe(30);
    expect(r.cacheWriteTokens).toBe(70);
  });
  it("reads none on a vendor that prices no write", () => {
    const r = mapVendorResponse("moonshot", "kimi-k3.1-pro", body({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: 90 } }, "kimi-k3.1-pro"));
    expect(r.cacheWriteTokens).toBe(0);
  });
});

describe("Gemini 4 Argon", () => {
  it("resolves the gemini-argon dynasty to gemini-4-argon under google-argon-4", () => {
    expect(resolveModel("google", "gemini-argon")).toMatchObject({ apiModelId: "gemini-4-argon", costPrefix: "google-argon-4" });
    expect(geminiCostPrefix("gemini-4-argon")).toBe("google-argon-4");
  });
  it("takes a thinkingLevel with a `low` floor — Google refuses MINIMAL", () => {
    expect(buildThinkingConfig("gemini-4-argon")).toEqual({ thinkingLevel: "low" });
    expect(buildThinkingConfig("gemini-4-argon", true)).toEqual({ thinkingLevel: "low" });
    expect(() => buildThinkingConfig("gemini-4-argon", false, "minimal")).toThrow(/lowest accepted level is "low"/);
  });
});
