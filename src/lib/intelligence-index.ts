/**
 * DISTRY-MODELS-1119 (owner 2026-11-19): every model Distry can be set to, with what it costs us,
 * how intelligent it is on the Artificial Analysis Intelligence Index, its rank, and intelligence per
 * dollar on that index's own cost basis, best ratio first. Served to the Distry editor's model panel
 * (dashboard v2 Monitoring > Distry) by `GET /internal/distry/models`; the dashboard computes nothing.
 *
 * Layers:
 *   bronze  `intelligence_index_reads`  each read of Artificial Analysis as received (or its failure)
 *   silver  `intelligence_index_scores` one row per Artificial Analysis model per successful read
 *   gold    `buildModelPanel`           our models x the latest silver x our catalogue prices
 *
 * Scores are never typed by hand: a model with no reading is served with `score: null` and a reason.
 * A read that fails is stored and served as `refresh.broken` (red on Monitoring), never a silent stale
 * value. Source: https://artificialanalysis.ai (attribution required on every tier, served in `source`).
 */
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { db } from "../db/index.js";
import { intelligenceIndexReads, intelligenceIndexScores } from "../db/schema.js";
import { PROVIDER_MODELS, resolveModel, type CapabilityTier, type Provider } from "./anthropic.js";
import { buildLlmCostNames } from "./cost-names.js";
import { modelDisplayName } from "./model-ids.js";

type Database = typeof db;

export const ARTIFICIAL_ANALYSIS_MODELS_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
/** A successful read is good for a day; the tick re-reads after that. */
export const INDEX_REFRESH_AFTER_MS = 24 * 60 * 60_000;
/** After a failed read, wait this long before trying again (the free tier allows 100 requests a day). */
export const INDEX_RETRY_AFTER_MS = 60 * 60_000;
/** No successful read for this long = broken, even when the last attempt did not fail. */
export const INDEX_STALE_AFTER_MS = 48 * 60 * 60_000;
/** How often the refresh tick wakes (it reads only when the rules above say so). */
export const INDEX_TICK_MS = 60 * 60_000;
const MAX_PAGES = 20;

// ---------------------------------------------------------------------------
// Bronze: read Artificial Analysis
// ---------------------------------------------------------------------------

const AaEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    model_creator: z.object({ name: z.string() }).passthrough().nullish(),
    evaluations: z
      .object({ artificial_analysis_intelligence_index: z.number().nullish() })
      .passthrough()
      .nullish(),
    artificial_analysis_intelligence_index_cost: z
      .object({ total_cost: z.number().nullish() })
      .passthrough()
      .nullish(),
    pricing: z
      .object({ price_1m_input_tokens: z.number().nullish(), price_1m_output_tokens: z.number().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const AaPageSchema = z
  .object({
    intelligence_index_version: z.union([z.number(), z.string()]),
    pagination: z.object({ has_more: z.boolean() }).passthrough(),
    data: z.array(AaEntrySchema),
  })
  .passthrough();

export interface IndexEntry {
  aaId: string;
  aaSlug: string;
  aaName: string;
  creator: string | null;
  indexVersion: string;
  score: number | null;
  indexCostUsd: number | null;
  priceInputPer1mUsd: number | null;
  priceOutputPer1mUsd: number | null;
}

export class IndexReadError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly pages: unknown[],
  ) {
    super(message);
    this.name = "IndexReadError";
  }
}

/** One page of the free list, validated. Throws on a shape we do not know (never a guessed field). */
export function parseIndexPage(body: unknown): { indexVersion: string; hasMore: boolean; entries: IndexEntry[] } {
  const parsed = AaPageSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Artificial Analysis answered a shape we do not read: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const indexVersion = String(parsed.data.intelligence_index_version);
  return {
    indexVersion,
    hasMore: parsed.data.pagination.has_more,
    entries: parsed.data.data.map((e) => ({
      aaId: e.id,
      aaSlug: e.slug,
      aaName: e.name,
      creator: e.model_creator?.name ?? null,
      indexVersion,
      score: e.evaluations?.artificial_analysis_intelligence_index ?? null,
      indexCostUsd: e.artificial_analysis_intelligence_index_cost?.total_cost ?? null,
      priceInputPer1mUsd: e.pricing?.price_1m_input_tokens ?? null,
      priceOutputPer1mUsd: e.pricing?.price_1m_output_tokens ?? null,
    })),
  };
}

/** Every page of the free list. Throws `IndexReadError` carrying the pages read so far (stored as bronze). */
export async function fetchIndex(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ indexVersion: string; entries: IndexEntry[]; pages: unknown[] }> {
  const pages: unknown[] = [];
  const entries: IndexEntry[] = [];
  let indexVersion: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchImpl(`${ARTIFICIAL_ANALYSIS_MODELS_URL}?page=${page}`, { headers: { "x-api-key": apiKey } });
    } catch (err) {
      throw new IndexReadError(`Artificial Analysis unreachable: ${err instanceof Error ? err.message : String(err)}`, null, pages);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new IndexReadError(`Artificial Analysis answered ${res.status}: ${text.slice(0, 300)}`, res.status, pages);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new IndexReadError(`Artificial Analysis answered ${res.status} with a body that is not JSON`, res.status, pages);
    }
    pages.push(body);
    let parsed: ReturnType<typeof parseIndexPage>;
    try {
      parsed = parseIndexPage(body);
    } catch (err) {
      throw new IndexReadError(err instanceof Error ? err.message : String(err), res.status, pages);
    }
    if (indexVersion !== null && parsed.indexVersion !== indexVersion) {
      throw new IndexReadError(`Artificial Analysis changed its index version mid-read (${indexVersion} then ${parsed.indexVersion})`, res.status, pages);
    }
    indexVersion = parsed.indexVersion;
    entries.push(...parsed.entries);
    if (!parsed.hasMore) return { indexVersion, entries, pages };
  }
  throw new IndexReadError(`Artificial Analysis listed more than ${MAX_PAGES} pages: stopped reading`, 200, pages);
}

// ---------------------------------------------------------------------------
// Store + refresh
// ---------------------------------------------------------------------------

export interface ReadRow {
  id: string;
  fetchedAt: Date;
  status: "ok" | "failed";
  error: string | null;
  indexVersion: string | null;
}

export interface IndexState {
  /** The newest successful read and its silver rows (null = never read). */
  latestOk: { read: ReadRow; entries: IndexEntry[] } | null;
  /** The newest attempt, whatever its outcome. */
  latestAttempt: ReadRow | null;
}

function toReadRow(r: typeof intelligenceIndexReads.$inferSelect): ReadRow {
  return { id: r.id, fetchedAt: r.fetchedAt, status: r.status, error: r.error, indexVersion: r.indexVersion };
}

export async function readIndexState(database: Database): Promise<IndexState> {
  const [attempt] = await database.select().from(intelligenceIndexReads).orderBy(desc(intelligenceIndexReads.fetchedAt)).limit(1);
  const [ok] = await database
    .select()
    .from(intelligenceIndexReads)
    .where(eq(intelligenceIndexReads.status, "ok"))
    .orderBy(desc(intelligenceIndexReads.fetchedAt))
    .limit(1);
  if (!ok) return { latestOk: null, latestAttempt: attempt ? toReadRow(attempt) : null };
  const rows = await database.select().from(intelligenceIndexScores).where(eq(intelligenceIndexScores.readId, ok.id));
  return {
    latestOk: {
      read: toReadRow(ok),
      entries: rows.map((r) => ({
        aaId: r.aaId,
        aaSlug: r.aaSlug,
        aaName: r.aaName,
        creator: r.creator,
        indexVersion: r.indexVersion,
        score: r.score,
        indexCostUsd: r.indexCostUsd,
        priceInputPer1mUsd: r.priceInputPer1mUsd,
        priceOutputPer1mUsd: r.priceOutputPer1mUsd,
      })),
    },
    latestAttempt: attempt ? toReadRow(attempt) : null,
  };
}

/** Whether the tick should read now: no fresh success, and no attempt in the last hour. */
export function shouldRefresh(state: IndexState, now: Date): boolean {
  if (state.latestOk && now.getTime() - state.latestOk.read.fetchedAt.getTime() < INDEX_REFRESH_AFTER_MS) return false;
  if (state.latestAttempt && now.getTime() - state.latestAttempt.fetchedAt.getTime() < INDEX_RETRY_AFTER_MS) return false;
  return true;
}

export type RefreshOutcome = "no_key" | "fresh" | "stored" | "failed";

/**
 * One refresh tick. No key = nothing read, nothing stored (served as `no_key`). A failure is stored as a
 * bronze row (status `failed`, the error, the pages read) and logged: the panel serves it as broken.
 */
export async function refreshIntelligenceIndex(args: {
  database: Database;
  apiKey: string | undefined;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<RefreshOutcome> {
  const { database, apiKey } = args;
  const now = args.now ?? new Date();
  if (!apiKey) return "no_key";
  if (!shouldRefresh(await readIndexState(database), now)) return "fresh";
  try {
    const read = await fetchIndex(apiKey, args.fetchImpl);
    await database.transaction(async (tx) => {
      const [row] = await tx
        .insert(intelligenceIndexReads)
        .values({ fetchedAt: now, status: "ok", httpStatus: 200, indexVersion: read.indexVersion, body: read.pages })
        .returning({ id: intelligenceIndexReads.id });
      const bySlug = new Map(read.entries.map((e) => [e.aaSlug, e]));
      if (bySlug.size > 0) {
        await tx.insert(intelligenceIndexScores).values(
          [...bySlug.values()].map((e) => ({ readId: row!.id, ...e, fetchedAt: now })),
        );
      }
    });
    console.log(`[intelligence-index] read ${read.entries.length} models, index v${read.indexVersion}`);
    return "stored";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const httpStatus = err instanceof IndexReadError ? err.httpStatus : null;
    const pages = err instanceof IndexReadError ? err.pages : [];
    console.error(`[intelligence-index] read FAILED (served as broken on Monitoring): ${message}`);
    await database.insert(intelligenceIndexReads).values({ fetchedAt: now, status: "failed", httpStatus, error: message, body: pages });
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Gold: the model panel
// ---------------------------------------------------------------------------

/** The providers Distry's definition accepts (same list as the editor's `models`). */
export interface ModelChoice {
  provider: Provider;
  modelId: string;
  displayName: string;
  /** Every name Distry's definition may use for this model (dynasty slug, head id, legacy aliases). */
  names: string[];
  capabilityTier: CapabilityTier;
  costPrefix: string;
}

/** Every concrete model the given providers' names resolve to, once each, in PROVIDER_MODELS order. */
export function distryModelChoices(providers: readonly Provider[]): ModelChoice[] {
  const byId = new Map<string, ModelChoice>();
  for (const provider of providers) {
    for (const name of PROVIDER_MODELS[provider]) {
      const m = resolveModel(provider, name);
      const key = `${provider}:${m.apiModelId}`;
      const existing = byId.get(key);
      if (existing) {
        existing.names.push(name);
        continue;
      }
      byId.set(key, {
        provider,
        modelId: m.apiModelId,
        displayName: modelDisplayName(m.apiModelId),
        names: [name],
        capabilityTier: m.capabilityTier,
        costPrefix: m.costPrefix,
      });
    }
  }
  return [...byId.values()];
}

const IGNORED_TOKENS = new Set(["preview", "latest"]);

/** Order-free token bag of a model name or slug: "Claude Haiku 5.5" and "claude-5-5-haiku" give the same bag. */
export function nameTokens(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !IGNORED_TOKENS.has(t) && !/^\d{8}$/.test(t))
    .sort()
    .join(" ");
}

export type IndexMatch =
  | { kind: "matched"; entry: IndexEntry }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: IndexEntry[] };

/**
 * The Artificial Analysis entry that IS this model, by name tokens (no hand mapping, no scores in code).
 * Precedence: its slug carries exactly our model id's tokens, else exactly our display name's, else its
 * name (variant in parentheses dropped) carries our display name's. Two candidates at one level = no pick.
 */
export function matchIndexEntry(model: Pick<ModelChoice, "modelId" | "displayName">, entries: readonly IndexEntry[]): IndexMatch {
  const idTokens = nameTokens(model.modelId);
  const displayTokens = nameTokens(model.displayName);
  const levels: Array<(e: IndexEntry) => boolean> = [
    (e) => nameTokens(e.aaSlug) === idTokens,
    (e) => nameTokens(e.aaSlug) === displayTokens,
    (e) => nameTokens(e.aaName) === displayTokens,
  ];
  for (const test of levels) {
    const hits = entries.filter(test);
    if (hits.length === 1) return { kind: "matched", entry: hits[0]! };
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
  }
  return { kind: "none" };
}

export type RatioBasis = "index_run_cost" | "blended_price_3_to_1";

export interface ModelPanelRow {
  provider: Provider;
  modelId: string;
  displayName: string;
  names: string[];
  capabilityTier: CapabilityTier;
  isCurrent: boolean;
  price: {
    inputPer1mUsd: number | null;
    outputPer1mUsd: number | null;
    costNames: { input: string; output: string } | null;
    reason: string | null;
  };
  index: {
    aaSlug: string | null;
    aaName: string | null;
    score: number | null;
    rank: number | null;
    rankOutOf: number;
    indexCostUsd: number | null;
    reason: string | null;
  };
  intelligencePerDollar: {
    value: number | null;
    basis: RatioBasis | null;
    reason: string | null;
  };
}

export interface ModelPanel {
  indexName: string;
  indexVersion: string | null;
  readAt: string | null;
  source: { name: string; url: string; attribution: string };
  refresh: {
    state: "no_key" | "never_read" | "ok" | "failed" | "stale";
    broken: boolean;
    sentence: string;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
  };
  priceBasis: string;
  ratioBasis: string;
  current: { provider: string; model: string; modelId: string };
  models: ModelPanelRow[];
}

export const PRICE_BASIS =
  "What a run is billed per 1M tokens: our stored catalogue price (costs-service platform price) under the cost names chat-service declares for this model, input and output, at the time of this read.";
export const RATIO_BASIS =
  "Intelligence Index points per US dollar Artificial Analysis spent running its Intelligence Index on this model (their published run cost). A model without a published run cost is ranked after them on points per dollar of a blended 1M tokens (3 input : 1 output, our catalogue price), and says so.";

function refreshState(args: { keyConfigured: boolean; state: IndexState; now: Date }): ModelPanel["refresh"] {
  const { keyConfigured, state, now } = args;
  const lastAttemptAt = state.latestAttempt?.fetchedAt.toISOString() ?? null;
  const lastSuccessAt = state.latestOk?.read.fetchedAt.toISOString() ?? null;
  if (!keyConfigured) {
    return {
      state: "no_key",
      broken: false,
      sentence: state.latestOk
        ? `No Artificial Analysis key set: showing the reading of ${lastSuccessAt!.slice(0, 10)}, not refreshed.`
        : "No Artificial Analysis key set yet: no Intelligence Index reading.",
      lastAttemptAt,
      lastSuccessAt,
    };
  }
  if (state.latestAttempt?.status === "failed") {
    return {
      state: "failed",
      broken: true,
      sentence: `The last Artificial Analysis read failed: ${state.latestAttempt.error ?? "no error recorded"}${lastSuccessAt ? ` (showing the reading of ${lastSuccessAt.slice(0, 10)})` : ""}.`,
      lastAttemptAt,
      lastSuccessAt,
    };
  }
  if (!state.latestOk) {
    return { state: "never_read", broken: false, sentence: "The first Artificial Analysis read has not run yet.", lastAttemptAt, lastSuccessAt };
  }
  if (now.getTime() - state.latestOk.read.fetchedAt.getTime() > INDEX_STALE_AFTER_MS) {
    return {
      state: "stale",
      broken: true,
      sentence: `No Artificial Analysis read since ${lastSuccessAt!.slice(0, 10)}: the daily refresh is not running.`,
      lastAttemptAt,
      lastSuccessAt,
    };
  }
  return { state: "ok", broken: false, sentence: `Read on ${lastSuccessAt!.slice(0, 10)}.`, lastAttemptAt, lastSuccessAt };
}

function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * The panel. `priceOf` = our catalogue price of a cost name in USD cents per token (null = unpriced),
 * `pricesRead` = false when the catalogue was never read.
 */
export function buildModelPanel(args: {
  choices: readonly ModelChoice[];
  state: IndexState;
  keyConfigured: boolean;
  priceOf: (costName: string) => number | null;
  pricesRead: boolean;
  current: { provider: string; model: string };
  now: Date;
}): ModelPanel {
  const { choices, state, keyConfigured, priceOf, pricesRead, current, now } = args;
  const entries = state.latestOk?.entries ?? [];
  const currentModelId = resolveModel(current.provider as Provider, current.model).apiModelId;

  const noReadingReason = !state.latestOk
    ? keyConfigured
      ? state.latestAttempt?.status === "failed"
        ? `No Intelligence Index reading: the Artificial Analysis read failed (${state.latestAttempt.error ?? "no error recorded"}).`
        : "No Intelligence Index reading yet: the first read has not run."
      : "No Intelligence Index reading: the Artificial Analysis key is not set."
    : null;

  const rows: ModelPanelRow[] = choices.map((c) => {
    // Price: our catalogue, the names this model is billed under.
    let costNames: { input: string; output: string } | null = null;
    let priceReason: string | null = null;
    let inputPer1mUsd: number | null = null;
    let outputPer1mUsd: number | null = null;
    try {
      const names = buildLlmCostNames({ provider: c.provider, costPrefix: c.costPrefix, at: now });
      costNames = { input: names.input, output: names.output };
    } catch (err) {
      priceReason = `No cost names for this model: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (costNames) {
      if (!pricesRead) {
        priceReason = "Our price catalogue (costs-service) has not been read yet.";
      } else {
        const inCents = priceOf(costNames.input);
        const outCents = priceOf(costNames.output);
        if (inCents === null || outCents === null) {
          priceReason = `Not priced in our catalogue: ${[inCents === null ? costNames.input : null, outCents === null ? costNames.output : null].filter(Boolean).join(", ")}.`;
        } else {
          inputPer1mUsd = roundTo((inCents * 1_000_000) / 100, 4);
          outputPer1mUsd = roundTo((outCents * 1_000_000) / 100, 4);
        }
      }
    }

    // Index score.
    let aaSlug: string | null = null;
    let aaName: string | null = null;
    let score: number | null = null;
    let indexCostUsd: number | null = null;
    let indexReason: string | null = noReadingReason;
    if (state.latestOk) {
      const match = matchIndexEntry(c, entries);
      if (match.kind === "none") {
        indexReason = `Artificial Analysis lists no model matching ${c.displayName}.`;
      } else if (match.kind === "ambiguous") {
        indexReason = `Several Artificial Analysis entries match ${c.displayName} (${match.candidates.map((e) => e.aaName).join(", ")}): none picked.`;
      } else {
        aaSlug = match.entry.aaSlug;
        aaName = match.entry.aaName;
        score = match.entry.score;
        indexCostUsd = match.entry.indexCostUsd;
        indexReason = score === null ? `Artificial Analysis has not scored ${match.entry.aaName} on its Intelligence Index yet.` : null;
      }
    }

    // Ratio on the index's own cost basis, else a stated blended price.
    let value: number | null = null;
    let basis: RatioBasis | null = null;
    let ratioReason: string | null = null;
    if (score === null) {
      ratioReason = "No Intelligence Index score.";
    } else if (indexCostUsd !== null && indexCostUsd > 0) {
      value = roundTo(score / indexCostUsd, 6);
      basis = "index_run_cost";
    } else if (inputPer1mUsd !== null && outputPer1mUsd !== null && 3 * inputPer1mUsd + outputPer1mUsd > 0) {
      value = roundTo(score / ((3 * inputPer1mUsd + outputPer1mUsd) / 4), 4);
      basis = "blended_price_3_to_1";
      ratioReason = "Artificial Analysis published no run cost for this model: points per dollar of a blended 1M tokens (3 input : 1 output) at our catalogue price.";
    } else {
      ratioReason = "Artificial Analysis published no run cost for this model, and our catalogue does not price it.";
    }

    return {
      provider: c.provider,
      modelId: c.modelId,
      displayName: c.displayName,
      names: c.names,
      capabilityTier: c.capabilityTier,
      isCurrent: currentModelId === c.modelId && current.provider === c.provider,
      price: { inputPer1mUsd, outputPer1mUsd, costNames, reason: priceReason },
      index: { aaSlug, aaName, score, rank: null, rankOutOf: 0, indexCostUsd, reason: indexReason },
      intelligencePerDollar: { value, basis, reason: ratioReason },
    };
  });

  // Rank by score among the listed models (1 = most intelligent; ties share a rank).
  const scored = rows.filter((r) => r.index.score !== null);
  for (const r of rows) {
    r.index.rankOutOf = scored.length;
    if (r.index.score !== null) r.index.rank = 1 + scored.filter((o) => o.index.score! > r.index.score!).length;
  }

  // Sort: index-run-cost ratio desc, then blended ratio desc, then scored without a ratio, then unscored.
  const group = (r: ModelPanelRow): number =>
    r.intelligencePerDollar.basis === "index_run_cost" ? 0 : r.intelligencePerDollar.basis === "blended_price_3_to_1" ? 1 : r.index.score !== null ? 2 : 3;
  rows.sort((a, b) => {
    const g = group(a) - group(b);
    if (g !== 0) return g;
    const av = a.intelligencePerDollar.value ?? a.index.score ?? 0;
    const bv = b.intelligencePerDollar.value ?? b.index.score ?? 0;
    if (bv !== av) return bv - av;
    return a.displayName.localeCompare(b.displayName);
  });

  return {
    indexName: "Artificial Analysis Intelligence Index",
    indexVersion: state.latestOk?.read.indexVersion ?? null,
    readAt: state.latestOk?.read.fetchedAt.toISOString() ?? null,
    source: {
      name: "Artificial Analysis",
      url: "https://artificialanalysis.ai",
      attribution: "Intelligence Index and run cost: Artificial Analysis (artificialanalysis.ai)",
    },
    refresh: refreshState({ keyConfigured, state, now }),
    priceBasis: PRICE_BASIS,
    ratioBasis: RATIO_BASIS,
    current: { provider: current.provider, model: current.model, modelId: currentModelId },
    models: rows,
  };
}
