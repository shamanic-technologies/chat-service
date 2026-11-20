import { describe, it, expect } from "vitest";
import {
  buildModelPanel,
  distryModelChoices,
  distryThinkingFor,
  effortOfLabel,
  fetchIndex,
  fetchPublicIndex,
  IndexReadError,
  matchIndexEntry,
  nameTokens,
  parseIndexPage,
  parsePublicPage,
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
  const read = { id: "r1", fetchedAt, status: "ok" as const, error: null, indexVersion: "5.0.1", source: "public_page" as const };
  return { latestOk: { read, entries }, latestAttempt: read };
}

/** A page shaped like artificialanalysis.ai/leaderboards/models: Next.js flight chunks + the version in text. */
function publicPage(models: unknown[], withVersion = true): string {
  const payload = `21:["$","div",null,{"children":[["$","$L22",null,{"initialModels":${JSON.stringify(models)},"other":1}]]}]`;
  const half = Math.floor(payload.length / 2);
  const push = (s: string) => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`;
  return `<html><body>${withVersion ? "<p>Artificial Analysis Intelligence Index v5.0.1</p>" : ""}${push(payload.slice(0, half))}${push(payload.slice(half))}</body></html>`;
}

const HAIKU_LOW = { id: "h-low", name: "Claude Haiku 5.5 (Low)", suffix: "Low", release: { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5" }, modelCreatorName: "Anthropic", intelligenceIndex: 18.6, intelligenceIndexCostPerTask: 0.0437, price1mInputTokens: 0.1, price1mOutputTokens: 0.5 };
const HAIKU_MAX = { ...HAIKU_LOW, id: "h-max", name: "Claude Haiku 5.5 (Max)", suffix: "Max", intelligenceIndex: 36.5, intelligenceIndexCostPerTask: 0.411 };

describe("effortOfLabel", () => {
  it("reads Artificial Analysis's own thinking words, nothing else", () => {
    expect(effortOfLabel("High")).toBe("high");
    expect(effortOfLabel("Max, Default Fallback")).toBe("max");
    expect(effortOfLabel("Non-reasoning")).toBeNull();
    expect(effortOfLabel(null)).toBeNull();
  });
});

describe("parsePublicPage (no key)", () => {
  it("reads every variant from the page's Next.js payload, with the stated version", () => {
    const { indexVersion, entries } = parsePublicPage(publicPage([HAIKU_LOW, HAIKU_MAX]));
    expect(indexVersion).toBe("5.0.1");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ aaId: "h-low", releaseSlug: "claude-haiku-5-5", variantLabel: "Low", effort: "low", score: 18.6, indexCostPerTaskUsd: 0.0437, creator: "Anthropic" });
  });

  it("fails loud when nothing is found (never a stale or empty value)", () => {
    expect(() => parsePublicPage("<html></html>")).toThrow(/no Next.js data chunks/);
    expect(() => parsePublicPage(publicPage([HAIKU_LOW], false))).toThrow(/version/);
    expect(() => parsePublicPage(publicPage([{ ...HAIKU_LOW, intelligenceIndex: null }]))).toThrow(/none carries an Intelligence Index score/);
    expect(() => parsePublicPage(publicPage([{ name: "x" }]))).toThrow(/shape we do not read/);
  });

  it("fetchPublicIndex keeps the raw page on a parse failure (bronze)", async () => {
    const fake = (async () => new Response("<html>changed</html>", { status: 200 })) as unknown as typeof fetch;
    const err = await fetchPublicIndex(fake).catch((e) => e);
    expect(err).toBeInstanceOf(IndexReadError);
    expect(err.bronze.rawText).toBe("<html>changed</html>");
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
  it("Anthropic = the definition's effort; Google = what /chat sends; DeepSeek = no level", () => {
    expect(distryThinkingFor({ provider: "anthropic", modelId: "claude-haiku-5-5" }, "low").level).toBe("low");
    expect(distryThinkingFor({ provider: "anthropic", modelId: "claude-haiku-5-5" }, null).level).toBeNull();
    expect(distryThinkingFor({ provider: "google", modelId: "gemini-4-hydrogen" }, "low").level).toBe("low");
    expect(distryThinkingFor({ provider: "deepseek", modelId: "deepseek-flash" }, "low").level).toBeNull();
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
    buildModelPanel({ choices, state, priceOf: (n) => prices[n] ?? null, pricesRead: true, current: { provider: "anthropic", model: "claude-haiku", effort: "low" }, now: NOW });

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
    expect(panel.source.readFrom).toBe("public_page");
    expect(panel.refresh).toMatchObject({ state: "ok", broken: false });
  });

  it("a failed read is red, the last good reading stays served", () => {
    const ok = okState(entries, new Date("2026-11-18T12:00:00Z"));
    const failed = { id: "r2", fetchedAt: NOW, status: "failed" as const, error: "the page carries no `initialModels`", indexVersion: null, source: "public_page" as const };
    const panel = build({ latestOk: ok.latestOk, latestAttempt: failed });
    expect(panel.refresh).toMatchObject({ state: "failed", broken: true });
    expect(panel.models[0]!.index.score).toBe(18.6);
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
