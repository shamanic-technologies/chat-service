import { describe, it, expect, afterEach } from "vitest";
import { isQuotaRefusal, readRetryAfterMs, parseRetryAfterMs } from "../../src/lib/openai-compatible.js";
import { resolveModel } from "../../src/lib/anthropic.js";
import { servedLlmsFor } from "../../src/lib/local-llm.js";
import { fallbackOrderFor, setFallbackPrices, resetVendorCredit } from "../../src/lib/vendor-credit.js";
import { providerHasNoPlatformKey, refreshPlatformKeyPresence, setPlatformKeyProviders } from "../../src/lib/platform-key-presence.js";
import { LIST_PRICES_2026_11_08 } from "./llm-list-prices.fixture.js";

// OPEN-LLM-FREE-1124 (generic, every vendor): a cap never leaves a writer without a completion, and a provider with no
// platform key is never drawn.

afterEach(() => {
  setPlatformKeyProviders(null);
  resetVendorCredit();
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
    await refreshPlatformKeyPresence(async () => ["anthropic", "google", "deepseek", "zai", "openai"]);
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
