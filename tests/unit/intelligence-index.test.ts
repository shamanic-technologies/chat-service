import { describe, it, expect } from "vitest";
import {
  buildModelPanel,
  distryModelChoices,
  fetchIndex,
  IndexReadError,
  matchIndexEntry,
  nameTokens,
  parseIndexPage,
  shouldRefresh,
  type IndexEntry,
  type IndexState,
  type ModelChoice,
} from "../../src/lib/intelligence-index.js";
import { CHAT_CONFIG_PROVIDERS } from "../../src/schemas.js";

// DISTRY-MODELS-1119: the Distry model panel (price, Intelligence Index, rank, intelligence per dollar).

const NOW = new Date("2026-11-19T12:00:00Z");

function entry(over: Partial<IndexEntry> & { aaSlug: string; aaName: string }): IndexEntry {
  return {
    aaId: `id-${over.aaSlug}`,
    creator: null,
    indexVersion: "5",
    score: null,
    indexCostUsd: null,
    priceInputPer1mUsd: null,
    priceOutputPer1mUsd: null,
    ...over,
  };
}

function okState(entries: IndexEntry[], fetchedAt = NOW): IndexState {
  const read = { id: "r1", fetchedAt, status: "ok" as const, error: null, indexVersion: "5" };
  return { latestOk: { read, entries }, latestAttempt: read };
}

describe("parseIndexPage", () => {
  it("reads the documented free-tier shape", () => {
    const page = parseIndexPage({
      tier: "free",
      intelligence_index_version: 5,
      pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
      data: [
        {
          id: "cd68",
          name: "GLM-5.3 (Max)",
          slug: "glm-5-3",
          model_creator: { id: "x", name: "Z AI" },
          evaluations: { artificial_analysis_intelligence_index: 31.7 },
          artificial_analysis_intelligence_index_cost: { total_cost: 3495.62, cost_per_task: { total_cost: 5.0 } },
          pricing: { price_1m_input_tokens: 1.4, price_1m_output_tokens: 4.4 },
        },
        { id: "n", name: "Unscored", slug: "unscored", evaluations: { artificial_analysis_intelligence_index: null } },
      ],
    });
    expect(page.indexVersion).toBe("5");
    expect(page.hasMore).toBe(false);
    expect(page.entries[0]).toMatchObject({ aaSlug: "glm-5-3", score: 31.7, indexCostUsd: 3495.62, creator: "Z AI", priceInputPer1mUsd: 1.4 });
    expect(page.entries[1]).toMatchObject({ score: null, indexCostUsd: null });
  });

  it("throws on a shape it does not know (never a guessed field)", () => {
    expect(() => parseIndexPage({ data: [] })).toThrow(/shape we do not read/);
  });
});

describe("fetchIndex", () => {
  const page = (n: number, hasMore: boolean) => ({
    intelligence_index_version: 5,
    pagination: { has_more: hasMore },
    data: [{ id: `m${n}`, name: `Model ${n}`, slug: `model-${n}`, evaluations: { artificial_analysis_intelligence_index: n } }],
  });

  it("reads every page with the key header", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push(`${url} ${(init?.headers as Record<string, string>)["x-api-key"]}`);
      const n = Number(new URL(url).searchParams.get("page"));
      return new Response(JSON.stringify(page(n, n < 2)), { status: 200 });
    }) as typeof fetch;
    const read = await fetchIndex("k", fake);
    expect(read.entries.map((e) => e.aaSlug)).toEqual(["model-1", "model-2"]);
    expect(read.pages).toHaveLength(2);
    expect(calls[0]).toMatch(/\/api\/v2\/language\/models\/free\?page=1 k$/);
  });

  it("a refusal throws IndexReadError with the status and the vendor's words", async () => {
    const fake = (async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof fetch;
    const err = await fetchIndex("k", fake).catch((e) => e);
    expect(err).toBeInstanceOf(IndexReadError);
    expect(err.httpStatus).toBe(401);
    expect(err.message).toMatch(/401.*bad key/);
  });
});

describe("matching our models to Artificial Analysis entries (no hand mapping)", () => {
  it("token order does not matter", () => {
    expect(nameTokens("Claude Haiku 5.5")).toBe(nameTokens("claude-5-5-haiku"));
    expect(nameTokens("gemini-3.1-pro-preview")).toBe(nameTokens("gemini-3-1-pro"));
    expect(nameTokens("GLM-5.3 (Max)")).toBe(nameTokens("glm-5-3"));
  });

  it("matches by id, then display name, then the AA name", () => {
    const entries = [entry({ aaSlug: "deepseek-v4-1-flash", aaName: "DeepSeek V4.1 Flash" }), entry({ aaSlug: "claude-5-5-haiku", aaName: "Claude 5.5 Haiku" })];
    expect(matchIndexEntry({ modelId: "deepseek-flash", displayName: "DeepSeek V4.1 Flash" }, entries)).toMatchObject({ kind: "matched", entry: { aaSlug: "deepseek-v4-1-flash" } });
    expect(matchIndexEntry({ modelId: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" }, entries)).toMatchObject({ kind: "matched", entry: { aaSlug: "claude-5-5-haiku" } });
    expect(matchIndexEntry({ modelId: "gpt-x", displayName: "GPT X" }, entries)).toEqual({ kind: "none" });
  });

  it("two variants at one level = no pick", () => {
    const entries = [entry({ aaSlug: "claude-haiku-5-5-reasoning", aaName: "Claude Haiku 5.5 (Reasoning)" }), entry({ aaSlug: "claude-haiku-5-5-non", aaName: "Claude Haiku 5.5 (Non-reasoning)" })];
    const m = matchIndexEntry({ modelId: "claude-haiku-5-5-x", displayName: "Claude Haiku 5.5" }, entries);
    expect(m.kind).toBe("ambiguous");
  });
});

describe("buildModelPanel", () => {
  const choices: ModelChoice[] = [
    { provider: "anthropic", modelId: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", names: ["claude-haiku"], capabilityTier: "cheap", costPrefix: "anthropic-haiku-5.5" },
    { provider: "anthropic", modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", names: ["opus"], capabilityTier: "frontier", costPrefix: "anthropic-opus-5.5" },
    { provider: "google", modelId: "gemini-4-hydrogen", displayName: "Gemini 4 Hydrogen", names: ["flash-pro"], capabilityTier: "strong", costPrefix: "google-gemini-4-hydrogen" },
    { provider: "google", modelId: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite", names: ["flash-lite"], capabilityTier: "cheap", costPrefix: "google-flash-lite" },
  ];
  const prices: Record<string, number> = {
    "anthropic-haiku-5.5-tokens-input": 0.0001, // $1 / 1M
    "anthropic-haiku-5.5-tokens-output": 0.0005,
    "anthropic-opus-5.5-tokens-input": 0.0005,
    "anthropic-opus-5.5-tokens-output": 0.0025,
    "google-gemini-4-hydrogen-tokens-input": 0.00003,
    "google-gemini-4-hydrogen-tokens-output": 0.00025,
  };
  const entries = [
    entry({ aaSlug: "claude-haiku-5-5", aaName: "Claude Haiku 5.5", score: 40, indexCostUsd: 100 }),
    entry({ aaSlug: "claude-opus-5-5", aaName: "Claude Opus 5.5", score: 60, indexCostUsd: 1000 }),
    entry({ aaSlug: "gemini-4-hydrogen", aaName: "Gemini 4 Hydrogen", score: 50, indexCostUsd: null }),
  ];
  const build = (state: IndexState, keyConfigured = true) =>
    buildModelPanel({
      choices,
      state,
      keyConfigured,
      priceOf: (n) => prices[n] ?? null,
      pricesRead: true,
      current: { provider: "anthropic", model: "claude-haiku" },
      now: NOW,
    });

  it("sorted by intelligence per dollar, run-cost basis first, unscored last with a reason", () => {
    const panel = build(okState(entries));
    expect(panel.models.map((m) => m.modelId)).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "gemini-4-hydrogen", "gemini-3.5-flash-lite"]);
    const [haiku, opus, gemini, lite] = panel.models;
    expect(haiku!.intelligencePerDollar).toMatchObject({ value: 0.4, basis: "index_run_cost" });
    expect(opus!.intelligencePerDollar).toMatchObject({ value: 0.06, basis: "index_run_cost" });
    expect(gemini!.intelligencePerDollar.basis).toBe("blended_price_3_to_1");
    expect(gemini!.intelligencePerDollar.reason).toMatch(/no run cost/);
    expect(lite!.index.score).toBeNull();
    expect(lite!.index.reason).toMatch(/lists no model matching Gemini 3.5 Flash-Lite/);
    expect(lite!.price.reason).toMatch(/Not priced/);
  });

  it("ranks by score among the listed models and prices per 1M tokens", () => {
    const panel = build(okState(entries));
    const by = Object.fromEntries(panel.models.map((m) => [m.modelId, m]));
    expect(by["claude-opus-5-5"]!.index).toMatchObject({ rank: 1, rankOutOf: 3 });
    expect(by["gemini-4-hydrogen"]!.index.rank).toBe(2);
    expect(by["claude-haiku-5-5"]!.index.rank).toBe(3);
    expect(by["claude-haiku-5-5"]!.price).toMatchObject({ inputPer1mUsd: 1, outputPer1mUsd: 5 });
    expect(by["claude-haiku-5-5"]!.isCurrent).toBe(true);
    expect(panel.current.modelId).toBe("claude-haiku-5-5");
    expect(panel.refresh).toMatchObject({ state: "ok", broken: false });
  });

  it("no key = every score null with the reason, not red", () => {
    const panel = build({ latestOk: null, latestAttempt: null }, false);
    expect(panel.refresh).toMatchObject({ state: "no_key", broken: false });
    expect(panel.models.every((m) => m.index.score === null && /key is not set/.test(m.index.reason!))).toBe(true);
  });

  it("a failed read is red, the last good reading stays served", () => {
    const ok = okState(entries, new Date("2026-11-18T12:00:00Z"));
    const failed = { id: "r2", fetchedAt: NOW, status: "failed" as const, error: "Artificial Analysis answered 500", indexVersion: null };
    const panel = build({ latestOk: ok.latestOk, latestAttempt: failed });
    expect(panel.refresh).toMatchObject({ state: "failed", broken: true });
    expect(panel.refresh.sentence).toMatch(/answered 500/);
    expect(panel.models[0]!.index.score).toBe(40);
  });

  it("no success for 48 h is red", () => {
    const panel = build(okState(entries, new Date("2026-11-16T12:00:00Z")));
    expect(panel.refresh).toMatchObject({ state: "stale", broken: true });
  });
});

describe("shouldRefresh", () => {
  it("reads once a day, retries a failure after an hour", () => {
    expect(shouldRefresh({ latestOk: null, latestAttempt: null }, NOW)).toBe(true);
    expect(shouldRefresh(okState([], new Date("2026-11-19T00:00:00Z")), NOW)).toBe(false);
    expect(shouldRefresh(okState([], new Date("2026-11-18T11:00:00Z")), NOW)).toBe(true);
    const failedRecently = { id: "f", fetchedAt: new Date("2026-11-19T11:30:00Z"), status: "failed" as const, error: "x", indexVersion: null };
    expect(shouldRefresh({ latestOk: null, latestAttempt: failedRecently }, NOW)).toBe(false);
  });
});

describe("distryModelChoices", () => {
  it("lists every concrete model of Distry's providers once, with every name it answers to", () => {
    const choices = distryModelChoices(CHAT_CONFIG_PROVIDERS);
    const ids = choices.map((c) => `${c.provider}:${c.modelId}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(choices.some((c) => c.modelId === "claude-haiku-5-5")).toBe(true);
    expect(choices.every((c) => c.names.length > 0 && c.displayName.length > 0)).toBe(true);
  });
});
