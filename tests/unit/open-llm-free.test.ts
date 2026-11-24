import { describe, it, expect, afterEach } from "vitest";
import { buildVendorRequestBody, isQuotaRefusal, readRetryAfterMs, parseRetryAfterMs, VENDORS } from "../../src/lib/openai-compatible.js";
import { resolveModel } from "../../src/lib/anthropic.js";
import { servedLlmsFor } from "../../src/lib/local-llm.js";
import { fallbackOrderFor, setFallbackPrices, resetVendorCredit } from "../../src/lib/vendor-credit.js";
import { providerHasNoPlatformKey, refreshPlatformKeyPresence, setPlatformKeyProviders } from "../../src/lib/platform-key-presence.js";
import { buildLlmCostNames } from "../../src/lib/cost-names.js";
import { LIST_PRICES_2026_11_08 } from "./llm-list-prices.fixture.js";

// OPEN-LLM-FREE-1124 (owner 2026-11-24): open-weight models on Cerebras and Groq, compared by the Rating to the
// private models. A free tier's daily cap must never leave a writer without a completion, and a provider with no
// platform key must never be drawn.

afterEach(() => {
  setPlatformKeyProviders(null);
  resetVendorCredit();
});

describe("the four open-weight dynasties", () => {
  it.each([
    ["cerebras", "cerebras-gpt-oss", "gpt-oss-120b", "cerebras-gpt-oss-120b"],
    ["cerebras", "cerebras-qwen", "qwen-3.8-27b", "cerebras-qwen-3.8-27b"],
    ["groq", "groq-gpt-oss", "openai/gpt-oss-120b", "groq-gpt-oss-120b"],
    ["groq", "groq-qwen", "qwen/qwen3.8-27b", "groq-qwen3.8-27b"],
  ] as const)("%s/%s resolves to %s under the costs-service names", (provider, slug, apiModelId, costPrefix) => {
    const m = resolveModel(provider, slug);
    expect(m.apiModelId).toBe(apiModelId);
    expect(m.costPrefix).toBe(costPrefix);
    expect(m.capabilityTier).toBe("cheap");
  });

  it("Cerebras declares no cached-input row (it bills a cache hit at the input rate); Groq does", () => {
    const at = new Date("2026-11-24T12:00:00Z");
    const c = buildLlmCostNames({ ...resolveModel("cerebras", "cerebras-qwen"), at });
    expect(c.input).toBe("cerebras-qwen-3.8-27b-tokens-input");
    expect(c.output).toBe("cerebras-qwen-3.8-27b-tokens-output");
    expect(c.cachedInput).toBeNull();
    const g = buildLlmCostNames({ ...resolveModel("groq", "groq-gpt-oss"), at });
    expect(g.cachedInput).toBe("groq-gpt-oss-120b-tokens-cached-input");
  });

  it("structured output: Qwen reasoning goes OFF, GPT-OSS (which cannot stop reasoning) goes to its floor `low`", () => {
    for (const vendor of ["cerebras", "groq"] as const) {
      const qwen = vendor === "cerebras" ? "qwen-3.8-27b" : "qwen/qwen3.8-27b";
      const oss = vendor === "cerebras" ? "gpt-oss-120b" : "openai/gpt-oss-120b";
      const base = { vendor, message: "Label it.", responseSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } };
      const q = buildVendorRequestBody({ ...base, model: qwen } as Parameters<typeof buildVendorRequestBody>[0]);
      expect(q.reasoning_effort).toBe("none");
      expect(q.thinking).toBeUndefined();
      expect((q.response_format as { type: string }).type).toBe("json_schema");
      const o = buildVendorRequestBody({ ...base, model: oss } as Parameters<typeof buildVendorRequestBody>[0]);
      expect(o.reasoning_effort).toBe("low");
      expect(o.thinking).toBeUndefined();
    }
  });

  it("an empty balance is a 402 only, never a 429", () => {
    for (const v of [VENDORS.cerebras, VENDORS.groq]) {
      expect(v.isOutOfCreditRefusal({ status: 402 } as never)).toBe(true);
      expect(v.isOutOfCreditRefusal({ status: 429 } as never)).toBe(false);
    }
  });
});

describe("a cap that does not clear in the retry budget is a QUOTA refusal (generic, every vendor)", () => {
  it("Retry-After of minutes = quota; of a second = a plain rate limit (retried)", () => {
    expect(isQuotaRefusal(readRetryAfterMs("432"), "")).toBe(true);
    expect(parseRetryAfterMs("432")).toBeNull();
    expect(isQuotaRefusal(readRetryAfterMs("1"), "Rate limit reached on requests per minute (RPM)")).toBe(false);
  });

  it("a body naming a per-day / per-hour cap = quota, a per-minute one is not", () => {
    expect(isQuotaRefusal(null, "Rate limit reached for model `qwen/qwen3.8-27b` on tokens per day (TPD): Limit 200000, Used 199990")).toBe(true);
    expect(isQuotaRefusal(null, "Tokens per hour limit exceeded")).toBe(true);
    expect(isQuotaRefusal(null, "Rate limit reached on tokens per minute (TPM): Limit 8000")).toBe(false);
  });
});

describe("a provider with no platform key is never drawn (key-service's list)", () => {
  it("unknown (never read) = every provider assumed to have a key: nothing changes for a live provider", () => {
    expect(providerHasNoPlatformKey("groq")).toBe(false);
    const [row] = servedLlmsFor(["groq/groq-qwen"], false);
    expect(row.runsAsStated).toBe(true);
  });

  it("served-llms answers runsAsStated: null for a provider with no key, so workflow-service never draws its script", async () => {
    await refreshPlatformKeyPresence(async () => ["anthropic", "google", "deepseek", "zai", "moonshot", "openai"]);
    const rows = servedLlmsFor(["groq/groq-qwen", "cerebras/cerebras-gpt-oss", "deepseek/deepseek-flash"], false);
    expect(rows[0]).toMatchObject({ runsAsStated: null, error: "no platform key for groq" });
    expect(rows[1]).toMatchObject({ runsAsStated: null, error: "no platform key for cerebras" });
    expect(rows[2].runsAsStated).toBe(true);
    // A local org runs on its own Claude Code: no platform key involved.
    expect(servedLlmsFor(["groq/groq-qwen"], true)[0].runsAsStated).toBe(false);
  });

  it("a failed key-service read keeps the last answer", async () => {
    await refreshPlatformKeyPresence(async () => ["deepseek"]);
    await refreshPlatformKeyPresence(async () => {
      throw new Error("key-service down");
    });
    expect(providerHasNoPlatformKey("groq")).toBe(true);
    expect(providerHasNoPlatformKey("deepseek")).toBe(false);
  });

  it("the fallback order skips a provider with no key, and takes it once its key is registered", () => {
    const prices = [
      ...LIST_PRICES_2026_11_08,
      // Served by costs-service v0.89.0 (2026-11-24).
      { name: "groq-gpt-oss-120b-tokens-input", pricePerUnitInUsdCents: "0.0000150000" },
      { name: "groq-gpt-oss-120b-tokens-cached-input", pricePerUnitInUsdCents: "0.0000075000" },
      { name: "groq-gpt-oss-120b-tokens-output", pricePerUnitInUsdCents: "0.0000600000" },
    ];
    setFallbackPrices(prices);
    const primary = resolveModel("deepseek", "deepseek-flash");
    const at = new Date("2026-11-24T12:00:00Z");
    setPlatformKeyProviders(["anthropic", "google", "deepseek", "zai", "moonshot", "openai"]);
    expect(fallbackOrderFor(primary, () => true, at).map((m) => m.provider)).not.toContain("groq");
    setPlatformKeyProviders(["anthropic", "google", "deepseek", "zai", "moonshot", "openai", "groq"]);
    expect(fallbackOrderFor(primary, () => true, at).map((m) => m.apiModelId)).toContain("openai/gpt-oss-120b");
  });
});
