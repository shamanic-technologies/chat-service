import { describe, it, expect, afterEach } from "vitest";
import { buildVendorRequestBody, fromPinnedHost, isQuotaRefusal, readRetryAfterMs, parseRetryAfterMs, VENDORS, withHostPin } from "../../src/lib/openai-compatible.js";
import { resolveModel } from "../../src/lib/anthropic.js";
import { LLM_DYNASTIES, isOnTrial } from "../../src/lib/llm-dynasties.js";
import { servedLlmsFor } from "../../src/lib/local-llm.js";
import { fallbackOrderFor, setFallbackPrices, resetVendorCredit } from "../../src/lib/vendor-credit.js";
import { providerHasNoPlatformKey, refreshPlatformKeyPresence, setPlatformKeyProviders } from "../../src/lib/platform-key-presence.js";
import { vendorCostLines } from "../../src/lib/cost-names.js";
import { LIST_PRICES_2026_11_08 } from "./llm-list-prices.fixture.js";

// OPENROUTER-CHEAP-LLM-1124 (owner 2026-11-24): the cheapest open models through ONE router account, each pinned
// to one host (the price is that host's). A cap never leaves a writer without a completion (OPEN-LLM-FREE-1124,
// generic), and a provider with no platform key is never drawn.

afterEach(() => {
  setPlatformKeyProviders(null);
  resetVendorCredit();
});

const EIGHT = [
  ["openrouter-ling-tiny", "inclusionai/ling-3.0-tiny@antdigital", "openrouter-antdigital-ling-3.0-tiny", "inclusionai/ling-3.0-tiny", "antdigital/fp8"],
  ["openrouter-nex-mini", "nex-agi/nex-n2.5-mini@nex-agi", "openrouter-nexagi-nex-n2.5-mini", "nex-agi/nex-n2.5-mini", "nex-agi/bf16"],
  ["openrouter-hy-flash", "tencent/hy4-flash@tencent", "openrouter-tencent-hy4-flash", "tencent/hy4-flash", "tencent/fp8"],
  ["openrouter-deepseek-flash", "deepseek/deepseek-v4.1-flash-1017@alibaba", "openrouter-alibaba-deepseek-v4.1-flash-1017", "deepseek/deepseek-v4.1-flash-1017", "alibaba"],
  ["openrouter-qwen-flash", "qwen/qwen3.7-flash@alibaba", "openrouter-alibaba-qwen3.7-flash", "qwen/qwen3.7-flash", "alibaba"],
  ["openrouter-llama-8b", "meta-llama/llama-3.1-8b-instruct@deepinfra", "openrouter-deepinfra-llama-3.1-8b-instruct", "meta-llama/llama-3.1-8b-instruct", "deepinfra/fp8"],
  ["openrouter-gpt-oss-20b", "openai/gpt-oss-20b@deepinfra", "openrouter-deepinfra-gpt-oss-20b", "openai/gpt-oss-20b", "deepinfra/bf16"],
  ["openrouter-gpt-oss-120b", "openai/gpt-oss-120b@deepinfra", "openrouter-deepinfra-gpt-oss-120b", "openai/gpt-oss-120b", "deepinfra/bf16"],
] as const;

const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
const body = (model: string) =>
  buildVendorRequestBody({ vendor: "openrouter", apiKey: "k", model, message: "Label it.", responseSchema: SCHEMA } as Parameters<typeof buildVendorRequestBody>[0]);

describe("the eight OpenRouter dynasties", () => {
  it.each(EIGHT)("%s resolves to %s under %s, pinned to %s at host %s", (slug, modelId, costPrefix, wireModel, hostSlug) => {
    const m = resolveModel("openrouter", slug);
    expect(m.apiModelId).toBe(modelId);
    expect(m.costPrefix).toBe(costPrefix);
    expect(m.capabilityTier).toBe("cheap");
    const pin = VENDORS.openrouter.hostPins![modelId];
    expect(pin.wireModel).toBe(wireModel);
    expect(pin.slug).toBe(hostSlug);
    // Never a free variant, never a router-picked host.
    expect(wireModel).not.toMatch(/:/);
    expect(withHostPin({ model: modelId }, pin)).toEqual({
      model: wireModel,
      provider: { order: [hostSlug], only: [hostSlug], allow_fallbacks: false },
    });
  });

  it("every model with a pin is a served model and every served model has a pin", () => {
    expect(Object.keys(VENDORS.openrouter.hostPins!).sort()).toEqual(EIGHT.map((e) => e[1]).sort());
  });

  it("every model carries input, cache hit, cache write and output rows; only Qwen 3.7 Flash goes long-context past 32K", () => {
    const at = new Date("2026-11-24T12:00:00Z");
    for (const [slug, , costPrefix] of EIGHT) {
      const m = resolveModel("openrouter", slug);
      const lines = vendorCostLines({ provider: "openrouter", costPrefix: m.costPrefix, at, tokensInput: 1000, cachedInputTokens: 200, cacheWriteTokens: 100, tokensOutput: 50 });
      expect(lines).toEqual([
        { costName: `${costPrefix}-tokens-input`, quantity: 700 },
        { costName: `${costPrefix}-tokens-cached-input`, quantity: 200 },
        { costName: `${costPrefix}-tokens-cache-write`, quantity: 100 },
        { costName: `${costPrefix}-tokens-output`, quantity: 50 },
      ]);
      const long = vendorCostLines({ provider: "openrouter", costPrefix, at, tokensInput: 40_000, cachedInputTokens: 0, cacheWriteTokens: 0, tokensOutput: 10 });
      const tier = costPrefix === "openrouter-alibaba-qwen3.7-flash" ? `${costPrefix}-long-context` : costPrefix;
      expect(long[0].costName).toBe(`${tier}-tokens-input`);
    }
  });

  it("structured output: the schema form where the pinned host honours it, JSON mode where it does not", () => {
    for (const [, modelId] of EIGHT) {
      const form = (body(modelId).response_format as { type: string }).type;
      const jsonModeOnly = ["deepseek/deepseek-v4.1-flash-1017@alibaba", "qwen/qwen3.7-flash@alibaba", "meta-llama/llama-3.1-8b-instruct@deepinfra"];
      expect(form, modelId).toBe(jsonModeOnly.includes(modelId) ? "json_object" : "json_schema");
    }
  });

  it("reasoning OFF in the router's field; GPT-OSS (cannot stop) at its floor `low`; Llama (no reasoning) gets nothing", () => {
    expect(body("qwen/qwen3.7-flash@alibaba").reasoning).toEqual({ enabled: false });
    expect(body("inclusionai/ling-3.0-tiny@antdigital").reasoning).toEqual({ enabled: false });
    expect(body("openai/gpt-oss-20b@deepinfra").reasoning).toEqual({ effort: "low" });
    expect(body("openai/gpt-oss-120b@deepinfra").reasoning).toEqual({ effort: "low" });
    expect(body("meta-llama/llama-3.1-8b-instruct@deepinfra").reasoning).toBeUndefined();
    for (const [, modelId] of EIGHT) {
      expect(body(modelId).reasoning_effort).toBeUndefined();
      expect(body(modelId).thinking).toBeUndefined();
    }
  });

  it("the answer must come from the pinned host and model; it is named back as our model id", () => {
    const pin = VENDORS.openrouter.hostPins!["deepseek/deepseek-v4.1-flash-1017@alibaba"];
    const ok = fromPinnedHost("openrouter", "deepseek/deepseek-v4.1-flash-1017@alibaba", pin, { model: "deepseek/deepseek-v4.1-flash-20261017", provider: "Alibaba" });
    expect(ok.model).toBe("deepseek/deepseek-v4.1-flash-1017@alibaba");
    expect(fromPinnedHost("openrouter", "deepseek/deepseek-v4.1-flash-1017@alibaba", pin, { model: "deepseek/deepseek-v4.1-flash-1017" }).model)
      .toBe("deepseek/deepseek-v4.1-flash-1017@alibaba");
    expect(() => fromPinnedHost("openrouter", "deepseek/deepseek-v4.1-flash-1017@alibaba", pin, { model: "deepseek/deepseek-v4.1-flash-1017", provider: "Novita" }))
      .toThrow(/Host mismatch/);
    expect(() => fromPinnedHost("openrouter", "deepseek/deepseek-v4.1-flash-1017@alibaba", pin, { model: "qwen/qwen3.7-flash", provider: "Alibaba" }))
      .toThrow(/Model mismatch/);
  });

  it("an empty balance is a 402 only, never a 429", () => {
    expect(VENDORS.openrouter.isOutOfCreditRefusal({ status: 402 } as never)).toBe(true);
    expect(VENDORS.openrouter.isOutOfCreditRefusal({ status: 429 } as never)).toBe(false);
  });

  it("ON TRIAL until the owner's go: callable by name, never drawn for a real send (served-llms null), never a fallback", () => {
    setPlatformKeyProviders(["anthropic", "google", "deepseek", "zai", "moonshot", "openai", "openrouter"]);
    for (const [slug, modelId] of EIGHT) {
      expect(isOnTrial(modelId), slug).toBe(true);
      expect(resolveModel("openrouter", slug).apiModelId).toBe(modelId);
      const [row] = servedLlmsFor([`openrouter/${slug}`], false);
      expect(row, slug).toMatchObject({ runsAsStated: null });
      expect(row.error).toMatch(/on trial/);
    }
    const prices = [...LIST_PRICES_2026_11_08, ...EIGHT.flatMap(([, , prefix]) =>
      ["tokens-input", "tokens-cached-input", "tokens-cache-write", "tokens-output"].map((d) => ({ name: `${prefix}-${d}`, pricePerUnitInUsdCents: "0.0000001000" })))];
    setFallbackPrices(prices);
    const at = new Date("2026-11-25T12:00:00Z");
    for (const primary of [resolveModel("deepseek", "deepseek-flash"), resolveModel("google", "gemini-flash-lite")]) {
      const order = fallbackOrderFor(primary, () => true, at).map((m) => m.provider);
      expect(order.length).toBeGreaterThan(0);
      expect(order).not.toContain("openrouter");
    }
  });

  it("no live line is on trial (the gate is keyed on the line, never on a vendor)", () => {
    for (const d of LLM_DYNASTIES) expect(d.onTrial === true, d.slug).toBe(d.provider === "openrouter");
  });
});

describe("a cap that does not clear in the retry budget is a QUOTA refusal (generic, every vendor)", () => {
  it("Retry-After of minutes = quota; of a second = a plain rate limit (retried)", () => {
    expect(isQuotaRefusal(readRetryAfterMs("432"), "")).toBe(true);
    expect(parseRetryAfterMs("432")).toBeNull();
    expect(isQuotaRefusal(readRetryAfterMs("1"), "Rate limit reached on requests per minute (RPM)")).toBe(false);
  });

  it("a body naming a per-day / per-hour cap = quota, a per-minute one is not", () => {
    expect(isQuotaRefusal(null, "Rate limit reached for model `qwen/qwen3.7-flash` on tokens per day (TPD): Limit 200000, Used 199990")).toBe(true);
    expect(isQuotaRefusal(null, "Tokens per hour limit exceeded")).toBe(true);
    expect(isQuotaRefusal(null, "Rate limit reached on tokens per minute (TPM): Limit 8000")).toBe(false);
  });
});

describe("a provider with no platform key is never drawn (key-service's list)", () => {
  it("unknown (never read) = every provider assumed to have a key: nothing changes for a live provider", () => {
    expect(providerHasNoPlatformKey("moonshot")).toBe(false);
    const [row] = servedLlmsFor(["moonshot/kimi-k2"], false);
    expect(row.runsAsStated).toBe(true);
  });

  it("served-llms answers runsAsStated: null for a provider with no key, so workflow-service never draws its script", async () => {
    await refreshPlatformKeyPresence(async () => ["anthropic", "google", "deepseek", "zai", "openai", "openrouter"]);
    const rows = servedLlmsFor(["moonshot/kimi-k2", "deepseek/deepseek-flash"], false);
    expect(rows[0]).toMatchObject({ runsAsStated: null, error: "no platform key for moonshot" });
    expect(rows[1].runsAsStated).toBe(true);
    // A local org runs on its own Claude Code: no platform key involved.
    expect(servedLlmsFor(["moonshot/kimi-k2"], true)[0].runsAsStated).toBe(false);
  });

  it("a failed key-service read keeps the last answer", async () => {
    await refreshPlatformKeyPresence(async () => ["deepseek"]);
    await refreshPlatformKeyPresence(async () => {
      throw new Error("key-service down");
    });
    expect(providerHasNoPlatformKey("moonshot")).toBe(true);
    expect(providerHasNoPlatformKey("deepseek")).toBe(false);
  });

  it("the fallback order skips a provider with no key, and takes it once its key is registered", () => {
    setFallbackPrices(LIST_PRICES_2026_11_08);
    const primary = resolveModel("deepseek", "deepseek-flash");
    const at = new Date("2026-11-24T12:00:00Z");
    setPlatformKeyProviders(["anthropic", "google", "deepseek", "moonshot", "openai"]);
    expect(fallbackOrderFor(primary, () => true, at).map((m) => m.provider)).not.toContain("zai");
    setPlatformKeyProviders(["anthropic", "google", "deepseek", "moonshot", "openai", "zai"]);
    expect(fallbackOrderFor(primary, () => true, at).map((m) => m.provider)).toContain("zai");
  });
});
