// SOPHIE-HAIKU-BACKUP-1112 (prod 2026-11-11): the DeepSeek balance ran out and every Sophie turn
// failed overnight. DISTRY-THINKING-1122 (owner 2026-11-22): the backup is no longer fixed to DeepSeek,
// it is the best model x thinking by intelligence per dollar among what can serve now, tried in order.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DISTRY_ATTEMPTS, distryOutageSentence, nextDistryAttempt, sophieTurnModel } from "../../src/agent/sophie-backup.js";
import { SOPHIE_CONFIG_KEY, SOPHIE_MODEL } from "../../src/agent/sophie.js";
import { markProviderServing, recordOutOfCredit, resetVendorCredit } from "../../src/lib/vendor-credit.js";
import { resolveModel } from "../../src/lib/anthropic.js";
import type { FallbackCandidate } from "../../src/lib/intelligence-index.js";

const primary = { provider: SOPHIE_MODEL.provider, modelAlias: SOPHIE_MODEL.model, modelId: "claude-haiku-5-5" };
const terraMedium: FallbackCandidate = { provider: "openai", model: "gpt-terra", modelId: "gpt-6.1-terra", displayName: "GPT-6.1 Terra", level: "medium", score: 38.2, intelligencePerDollar: 226, availability: { runsNow: true, reason: null } };
const glmLow: FallbackCandidate = { provider: "zai", model: "glm-pro", modelId: "glm-5.3", displayName: "GLM-5.3", level: "low", score: 23.1, intelligencePerDollar: 120, availability: { runsNow: true, reason: null } };
const order = vi.fn(async (exclude: ReadonlySet<string>) => [terraMedium, glmLow].filter((c) => !exclude.has(`${c.provider}:${c.modelId}`)));

afterEach(() => {
  resetVendorCredit();
  order.mockClear();
});

describe("Sophie's model", () => {
  it("is Claude Haiku 5.5 (never Haiku 4.5, owner rule) at effort low", () => {
    expect(resolveModel(SOPHIE_MODEL.provider, SOPHIE_MODEL.model)).toMatchObject({ apiModelId: "claude-haiku-5-5", costPrefix: "anthropic-haiku-5.5" });
    expect(SOPHIE_MODEL.effort).toBe("low");
  });
});

describe("before the turn: the configured vendor is out of credit", () => {
  it("runs on its own model while its vendor has credit, without reading the order", async () => {
    expect(await sophieTurnModel(SOPHIE_CONFIG_KEY, primary, order)).toEqual({ provider: "anthropic", modelAlias: "claude-haiku", backupFor: null, backupLevel: null });
    expect(order).not.toHaveBeenCalled();
  });

  it("runs the whole turn on the first of the fallback order, at its level, and returns once the vendor serves", async () => {
    recordOutOfCredit({ provider: "anthropic", model: "claude-haiku-5-5", status: 400, message: "Your credit balance is too low to access the Anthropic API." });
    expect(await sophieTurnModel(SOPHIE_CONFIG_KEY, primary, order)).toEqual({ provider: "openai", modelAlias: "gpt-terra", backupFor: "anthropic", backupLevel: "medium" });
    expect([...order.mock.calls[0]![0]]).toEqual(["anthropic:claude-haiku-5-5"]);
    markProviderServing("anthropic");
    expect((await sophieTurnModel(SOPHIE_CONFIG_KEY, primary, order)).backupFor).toBeNull();
  });

  // FALLBACK-REFUSED-1124: an empty balance moves EVERY chat config down the same order.
  it("every other chat config runs on the first of the fallback order too while its vendor is out of credit", async () => {
    expect((await sophieTurnModel("workflow", primary, order)).backupFor).toBeNull();
    recordOutOfCredit({ provider: "anthropic", model: "claude-haiku-5-5", status: 400, message: "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC." });
    expect(await sophieTurnModel("workflow", primary, order)).toEqual({ provider: "openai", modelAlias: "gpt-terra", backupFor: "anthropic", backupLevel: "medium" });
  });

  it("no candidate serves: stays on the configured model (the turn fails loud)", async () => {
    recordOutOfCredit({ provider: "anthropic", model: "claude-haiku-5-5", status: 400, message: "Your credit balance is too low to access the Anthropic API." });
    expect((await sophieTurnModel(SOPHIE_CONFIG_KEY, primary, async () => [])).backupFor).toBeNull();
  });

  it("says in words where turns go while a vendor is out", () => {
    recordOutOfCredit({ provider: "moonshot", model: "kimi-k3.1-pro", status: 429, message: "suspended due to insufficient balance" });
    expect(distryOutageSentence("moonshot")).toContain("next model of the fallback order");
    expect(distryOutageSentence("zai")).toBeNull();
  });
});

describe("during the turn: the model failed before any tool or word", () => {
  const base = {
    configKey: SOPHIE_CONFIG_KEY, platformKey: true, billingRefusal: false, sessionId: "s1", userMessageId: "m1",
    toolCount: 0, textSent: false, failed: { provider: "anthropic" as const, modelId: "claude-haiku-5-5" }, order,
  };

  it("runs again on the next candidate, then the one after, skipping every model already tried", async () => {
    const first = await nextDistryAttempt(base);
    expect(first).toEqual({ tried: ["anthropic:claude-haiku-5-5"], primaryProvider: "anthropic", next: terraMedium, sessionId: "s1", userMessageId: "m1" });
    const second = await nextDistryAttempt({ ...base, failed: { provider: "openai", modelId: "gpt-6.1-terra" }, previous: first! });
    expect(second).toMatchObject({ tried: ["anthropic:claude-haiku-5-5", "openai:gpt-6.1-terra"], primaryProvider: "anthropic", next: glmLow });
    expect(await nextDistryAttempt({ ...base, failed: { provider: "zai", modelId: "glm-5.3" }, previous: second! })).toBeNull();
  });

  // FALLBACK-REFUSED-1124: a vendor refusing for credit mid-turn is retried on any config.
  it("another config's turn refused for an empty balance runs again on the next candidate", async () => {
    const first = await nextDistryAttempt({ ...base, configKey: "workflow", outOfCredit: true });
    expect(first).toMatchObject({ tried: ["anthropic:claude-haiku-5-5"], next: terraMedium });
    const second = await nextDistryAttempt({ ...base, configKey: "workflow", outOfCredit: true, failed: { provider: "openai", modelId: "gpt-6.1-terra" }, previous: first! });
    expect(second).toMatchObject({ next: glmLow });
  });

  it("never re-runs a turn that already did something, a billing refusal, another config or an org's own key", async () => {
    expect(await nextDistryAttempt({ ...base, toolCount: 1 })).toBeNull();
    expect(await nextDistryAttempt({ ...base, textSent: true })).toBeNull();
    expect(await nextDistryAttempt({ ...base, billingRefusal: true })).toBeNull();
    expect(await nextDistryAttempt({ ...base, configKey: "workflow" })).toBeNull();
    expect(await nextDistryAttempt({ ...base, configKey: "workflow", outOfCredit: true, platformKey: false })).toBeNull();
    expect(await nextDistryAttempt({ ...base, configKey: "workflow", outOfCredit: true, toolCount: 1 })).toBeNull();
    expect(await nextDistryAttempt({ ...base, platformKey: false })).toBeNull();
    expect(order).not.toHaveBeenCalled();
  });

  it(`stops after ${MAX_DISTRY_ATTEMPTS} models`, async () => {
    const tried = Array.from({ length: MAX_DISTRY_ATTEMPTS - 1 }, (_, i) => `x:${i}`);
    expect(await nextDistryAttempt({ ...base, previous: { tried, primaryProvider: "anthropic", next: terraMedium, sessionId: "s1", userMessageId: "m1" } })).toBeNull();
  });
});
