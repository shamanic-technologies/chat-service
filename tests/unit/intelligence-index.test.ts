import { describe, it, expect } from "vitest";
import {
  buildModelPanel,
  distryModelChoices,
  distryThinkingFor,
  effortOfLabel,
  fetchIndex,
  IndexReadError,
  matchIndexEntry,
  nameTokens,
  parseIndexPage,
  pickVariant,
  shouldRefresh,
  type IndexEntry,
  type IndexState,
  type ModelChoice,
} from "../../src/lib/intelligence-index.js";
import { CHAT_CONFIG_PROVIDERS } from "../../src/schemas.js";

// DISTRY-MODELS-1119: the Distry model panel (price, Intelligence Index, rank, intelligence per dollar).

const NOW = new Date("2026-11-19T12:00:00Z");

function entry(over: Partial<IndexEntry> & { releaseSlug: string; releaseName: string }): IndexEntry {
  const label = over.variantLabel ?? null;
  return {
    aaId: `id-${over.releaseSlug}-${label ?? "only"}`,
    aaSlug: over.releaseSlug,
    aaName: label ? `${over.releaseName} (${label})` : over.releaseName,
    variantLabel: label,
    effort: effortOfLabel(label),
    creator: null,
    indexVersion: "5.0.1",
    score: null,
    indexCostPerTaskUsd: null,
    priceInputPer1mUsd: null,
    priceOutputPer1mUsd: null,
    ...over,
  };
}

function okState(entries: IndexEntry[], fetchedAt = NOW): IndexState {
  const read = { id: "r1", fetchedAt, status: "ok" as const, error: null, indexVersion: "5.0.1", source: "api" as const };
  return { latestOk: { read, entries }, latestAttempt: read };
}

describe("effortOfLabel", () => {
  it("reads Artificial Analysis's own thinking words, nothing else", () => {
    expect(effortOfLabel("High")).toBe("high");
    expect(effortOfLabel("Max, Default Fallback")).toBe("max");
    expect(effortOfLabel("Non-reasoning")).toBeNull();
    expect(effortOfLabel(null)).toBeNull();
  });
});

describe("parseIndexPage + fetchIndex (key set)", () => {
  it("reads the documented free-tier shape, cost per task", () => {
    const page = parseIndexPage({
      intelligence_index_version: 5,
      pagination: { has_more: false },
      data: [{
        id: "cd68", name: "GLM-5.3 (Max)", slug: "glm-5-3", model_creator: { name: "Z AI" },
        evaluations: { artificial_analysis_intelligence_index: 31.7 },
        artificial_analysis_intelligence_index_cost: { total_cost: 3495.62, cost_per_task: { total_cost: 5.0093 } },
      }],
    });
    expect(page.entries[0]).toMatchObject({ releaseSlug: "glm-5-3", releaseName: "GLM-5.3", variantLabel: "Max", effort: "max", score: 31.7, indexCostPerTaskUsd: 5.0093 });
  });

  it("groups the API's per-level slugs into one release (prod 2026-11-20: claude-haiku-5-5-high ...)", () => {
    const mk = (slug: string, label: string, score: number) => ({ id: slug, name: `Claude Haiku 5.5 (${label})`, slug, evaluations: { artificial_analysis_intelligence_index: score }, artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.1 } } });
    const { entries } = parseIndexPage({ intelligence_index_version: 5, pagination: { has_more: false }, data: [mk("claude-haiku-5-5", "Max", 36.5), mk("claude-haiku-5-5-low", "Low", 18.6), mk("claude-haiku-5-5-high", "High", 29.9)] });
    expect(entries.map((e) => e.releaseSlug)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-haiku-5-5"]);
    const m = matchIndexEntry({ modelId: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" }, entries);
    expect(m.kind === "matched" && m.variants.length).toBe(3);
    if (m.kind === "matched") expect(pickVariant("Claude Haiku 5.5", m.variants, { level: "low", words: "effort low" })).toMatchObject({ kind: "picked", entry: { score: 18.6 } });
  });

  it("a refusal throws IndexReadError with the status", async () => {
    const fake = (async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof fetch;
    const err = await fetchIndex("k", fake).catch((e) => e);
    expect(err).toBeInstanceOf(IndexReadError);
    expect(err.httpStatus).toBe(401);
  });
});

describe("matching (no hand mapping, never guessed)", () => {
  it("token order does not matter", () => {
    expect(nameTokens("Claude Haiku 5.5")).toBe(nameTokens("claude-5-5-haiku"));
    expect(nameTokens("gemini-3.1-pro-preview")).toBe(nameTokens("gemini-3-1-pro-preview"));
  });

  it("matches a release and returns all its variants", () => {
    const entries = [entry({ releaseSlug: "claude-haiku-5-5", releaseName: "Claude Haiku 5.5", variantLabel: "Low" }), entry({ releaseSlug: "claude-haiku-5-5", releaseName: "Claude Haiku 5.5", variantLabel: "Max" })];
    const m = matchIndexEntry({ modelId: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" }, entries);
    expect(m).toMatchObject({ kind: "matched", releaseSlug: "claude-haiku-5-5" });
    if (m.kind === "matched") expect(m.variants).toHaveLength(2);
  });

  it("a dated build is named, never picked", () => {
    const entries = [entry({ releaseSlug: "deepseek-v4-1-flash-1017", releaseName: "DeepSeek V4.1 Flash 1017", variantLabel: "Max" })];
    expect(matchIndexEntry({ modelId: "deepseek-flash", displayName: "DeepSeek V4.1 Flash" }, entries)).toEqual({ kind: "none", near: ["DeepSeek V4.1 Flash 1017"] });
  });

  it("picks the variant at Distry's thinking, never the nearest level", () => {
    const variants = [entry({ releaseSlug: "g", releaseName: "Gemini 4 Argon", variantLabel: "Medium" }), entry({ releaseSlug: "g", releaseName: "Gemini 4 Argon", variantLabel: "High" })];
    expect(pickVariant("Gemini 4 Argon", variants, { level: "medium", words: "thinking medium" })).toMatchObject({ kind: "picked", entry: { variantLabel: "Medium" } });
    const low = pickVariant("Gemini 4 Argon", variants, { level: "low", words: "thinking low (what /chat sends)" });
    expect(low.kind).toBe("not_picked");
    if (low.kind === "not_picked") expect(low.reason).toBe("Artificial Analysis scores Gemini 4 Argon at Medium, High: none at thinking low (what /chat sends).");
    const noLevel = pickVariant("DeepSeek", variants, { level: null, words: "reasoning on, no level" });
    expect(noLevel.kind).toBe("not_picked");
    expect(pickVariant("Flash-Lite", [variants[0]!], { level: "low", words: "x" })).toMatchObject({ kind: "picked" });
  });
});

describe("distryThinkingFor", () => {
  it("the saved level, any provider (DISTRY-THINKING-1122); else Anthropic's default, what /chat sends to Google, DeepSeek no level", () => {
    expect(distryThinkingFor({ provider: "anthropic", modelId: "claude-haiku-5-5" }, "low").level).toBe("low");
    expect(distryThinkingFor({ provider: "anthropic", modelId: "claude-haiku-5-5" }, null).level).toBeNull();
    expect(distryThinkingFor({ provider: "google", modelId: "gemini-4-hydrogen" }, null).level).toBe("low");
    expect(distryThinkingFor({ provider: "openai", modelId: "gpt-6.1-terra" }, "medium")).toEqual({ level: "medium", words: "thinking medium (Distry's definition)" });
    expect(distryThinkingFor({ provider: "deepseek", modelId: "deepseek-flash" }, null).level).toBeNull();
  });

  // DISTRY-ALL-MODELS-1122: a direct vendor reads at the reasoning its tool rounds carry (vendor data).
  it("GPT-6.1 Terra = reasoning off, read on Artificial Analysis's Non-reasoning entry; GLM = its default", () => {
    const terra = distryThinkingFor({ provider: "openai", modelId: "gpt-6.1-terra" }, null);
    expect(terra.level).toBe("none");
    expect(distryThinkingFor({ provider: "zai", modelId: "glm-5.3" }, null).level).toBeNull();
    const variants = [
      entry({ releaseSlug: "gpt-6-1-terra", releaseName: "GPT-6.1 Terra", variantLabel: "Max", score: 51.3 }),
      entry({ releaseSlug: "gpt-6-1-terra", releaseName: "GPT-6.1 Terra", variantLabel: "Non-reasoning", score: 30.5 }),
    ];
    expect(pickVariant("GPT-6.1 Terra", variants, terra)).toMatchObject({ kind: "picked", entry: { score: 30.5 } });
  });
});

describe("buildModelPanel", () => {
  const choices: ModelChoice[] = [
    { provider: "anthropic", modelId: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", names: ["claude-haiku"], capabilityTier: "cheap", costPrefix: "anthropic-haiku-5.5" },
    { provider: "anthropic", modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", names: ["opus"], capabilityTier: "frontier", costPrefix: "anthropic-opus-5.5" },
    { provider: "google", modelId: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite", names: ["flash-lite"], capabilityTier: "cheap", costPrefix: "google-flash-lite" },
    { provider: "deepseek", modelId: "deepseek-flash", displayName: "DeepSeek V4.1 Flash", names: ["deepseek-flash"], capabilityTier: "cheap", costPrefix: "deepseek-v4.1-flash" },
  ];
  const prices: Record<string, number> = {
    "anthropic-haiku-5.5-tokens-input": 0.00001,
    "anthropic-haiku-5.5-tokens-output": 0.00005,
    "anthropic-opus-5.5-tokens-input": 0.0004,
    "anthropic-opus-5.5-tokens-output": 0.002,
  };
  const entries = [
    entry({ releaseSlug: "claude-haiku-5-5", releaseName: "Claude Haiku 5.5", variantLabel: "Low", score: 18.6, indexCostPerTaskUsd: 0.04 }),
    entry({ releaseSlug: "claude-haiku-5-5", releaseName: "Claude Haiku 5.5", variantLabel: "Max", score: 36.5, indexCostPerTaskUsd: 0.41 }),
    entry({ releaseSlug: "claude-opus-5-5", releaseName: "Claude Opus 5.5", variantLabel: "Low, Default Fallback", score: 34.8, indexCostPerTaskUsd: 0.98 }),
    entry({ releaseSlug: "gemini-3-5-flash-lite", releaseName: "Gemini 3.5 Flash-Lite", score: 11.7, indexCostPerTaskUsd: 0.69 }),
    entry({ releaseSlug: "deepseek-v4-1-flash-1017", releaseName: "DeepSeek V4.1 Flash 1017", variantLabel: "Max", score: 32.6, indexCostPerTaskUsd: 0.6 }),
  ];
  const build = (state: IndexState) =>
    buildModelPanel({ choices, state, keyConfigured: true, priceOf: (n) => prices[n] ?? null, pricesRead: true, current: { provider: "anthropic", model: "claude-haiku", effort: "low" }, now: NOW });

  it("reads each model at Distry's thinking, sorted by intelligence per dollar, unmatched last with a reason", () => {
    const panel = build(okState(entries));
    expect(panel.models.map((m) => m.modelId)).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "gemini-3.5-flash-lite", "deepseek-flash"]);
    const [haiku, opus, lite, deepseek] = panel.models;
    expect(haiku!.index).toMatchObject({ aaName: "Claude Haiku 5.5 (Low)", score: 18.6, rank: 2, rankOutOf: 3 });
    expect(haiku!.intelligencePerDollar).toMatchObject({ value: 465, basis: "index_run_cost" });
    expect(haiku!.variants.map((v) => [v.variantLabel, v.isDistrysThinking])).toEqual([["Max", false], ["Low", true]]);
    expect(opus!.index).toMatchObject({ score: 34.8, rank: 1 });
    expect(lite!.index.picked).toMatch(/only reading/);
    expect(deepseek!.index.score).toBeNull();
    expect(deepseek!.index.reason).toBe("Artificial Analysis lists DeepSeek V4.1 Flash only as DeepSeek V4.1 Flash 1017: none picked.");
    expect(panel.current).toMatchObject({ modelId: "claude-haiku-5-5", effort: "low" });
    expect(panel.refresh).toMatchObject({ state: "ok", broken: false });
  });

  it("says when a model's vendor is out of credit, every other row runs now", () => {
    const panel = buildModelPanel({ choices, state: okState(entries), keyConfigured: true, priceOf: (n) => prices[n] ?? null, pricesRead: true, current: { provider: "anthropic", model: "claude-haiku", effort: "low" }, now: NOW, outOfCredit: (p) => (p === "deepseek" ? "DeepSeek is out of credit." : null) });
    const deepseek = panel.models.find((m) => m.provider === "deepseek")!;
    expect(deepseek.availability).toEqual({ runsNow: false, reason: "DeepSeek is out of credit." });
    expect(panel.models.filter((m) => m.provider !== "deepseek").every((m) => m.availability.runsNow)).toBe(true);
  });

  it("a failed read is red, the last good reading stays served", () => {
    const ok = okState(entries, new Date("2026-11-18T12:00:00Z"));
    const failed = { id: "r2", fetchedAt: NOW, status: "failed" as const, error: "Artificial Analysis answered 500", indexVersion: null, source: "api" as const };
    const panel = build({ latestOk: ok.latestOk, latestAttempt: failed });
    expect(panel.refresh).toMatchObject({ state: "failed", broken: true });
    expect(panel.models[0]!.index.score).toBe(18.6);
  });

  it("no key = every score null with the reason, not red", () => {
    const panel = buildModelPanel({ choices, state: { latestOk: null, latestAttempt: null }, keyConfigured: false, priceOf: () => null, pricesRead: true, current: { provider: "anthropic", model: "claude-haiku", effort: "low" }, now: NOW });
    expect(panel.refresh).toMatchObject({ state: "no_key", broken: false });
    expect(panel.models.every((m) => /key is not set/.test(m.index.reason!))).toBe(true);
  });

  it("never read = every score null with the reason; 48 h without success = red", () => {
    const never = build({ latestOk: null, latestAttempt: null });
    expect(never.refresh).toMatchObject({ state: "never_read", broken: false });
    expect(never.models.every((m) => m.index.score === null && /first read has not run/.test(m.index.reason!))).toBe(true);
    expect(build(okState(entries, new Date("2026-11-16T12:00:00Z"))).refresh).toMatchObject({ state: "stale", broken: true });
  });
});

describe("shouldRefresh", () => {
  it("reads once a day, retries a failure after an hour", () => {
    expect(shouldRefresh({ latestOk: null, latestAttempt: null }, NOW)).toBe(true);
    expect(shouldRefresh(okState([], new Date("2026-11-19T00:00:00Z")), NOW)).toBe(false);
    expect(shouldRefresh(okState([], new Date("2026-11-18T11:00:00Z")), NOW)).toBe(true);
    const failedRecently = { id: "f", fetchedAt: new Date("2026-11-19T11:30:00Z"), status: "failed" as const, error: "x", indexVersion: null, source: null };
    expect(shouldRefresh({ latestOk: null, latestAttempt: failedRecently }, NOW)).toBe(false);
  });
});

describe("distryModelChoices", () => {
  it("lists every concrete model of Distry's providers once, with every name it answers to", () => {
    const choices = distryModelChoices(CHAT_CONFIG_PROVIDERS);
    const ids = choices.map((c) => `${c.provider}:${c.modelId}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(choices.some((c) => c.modelId === "claude-haiku-5-5")).toBe(true);
  });
});
