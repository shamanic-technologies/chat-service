/**
 * DISTRY-MODELS-1119 (owner 2026-11-19): every model Distry can be set to, with what it costs us,
 * how intelligent it is on the Artificial Analysis Intelligence Index, its rank, and intelligence per
 * dollar on that index's own cost basis, best ratio first. Served to the Distry editor's model panel
 * (dashboard v2 Monitoring > Distry) by `GET /internal/distry/models`; the dashboard computes nothing.
 *
 * Source: Artificial Analysis (https://artificialanalysis.ai, attribution required, served in `source`).
 * Read from their Data API (`ARTIFICIAL_ANALYSIS_API_KEY`): every model at every thinking level they
 * scored, with its Intelligence Index and the cost per task of running it. No key = nothing read
 * (`no_key`, not red). A public-page scrape was shipped and removed the same day (owner got a key).
 *
 * Layers:
 *   bronze  `intelligence_index_reads`  each read as received (the API pages), or its failure
 *   silver  `intelligence_index_scores` one row per Artificial Analysis entry (model x thinking level)
 *   gold    `buildModelPanel`           our models x the latest silver x our catalogue prices
 *
 * Scores are never typed by hand and a match is never guessed: no entry, several releases, or no variant
 * at the thinking Distry runs = `score: null` + a reason. A read that fails or finds nothing is stored
 * and served as `refresh.broken` (red on Monitoring), never a silent stale value.
 */
import { desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { db } from "../db/index.js";
import { intelligenceIndexReads, intelligenceIndexScores } from "../db/schema.js";
import { PROVIDER_MODELS, resolveModel, type CapabilityTier, type Provider } from "./anthropic.js";
import { buildLlmCostNames } from "./cost-names.js";
import { buildThinkingConfig } from "./gemini.js";
import { chatThinkingLevels, thinkingLevelRefusal } from "./thinking-levels.js";
import { modelDisplayName } from "./model-ids.js";
import { isVendorProvider, VENDORS } from "./openai-compatible.js";

type Database = typeof db;

export const ARTIFICIAL_ANALYSIS_MODELS_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
/** A successful read is good for a day; the tick re-reads after that. */
export const INDEX_REFRESH_AFTER_MS = 24 * 60 * 60_000;
/** After a failed read, wait this long before trying again. */
export const INDEX_RETRY_AFTER_MS = 60 * 60_000;
/** No successful read for this long = broken, even when the last attempt did not fail. */
export const INDEX_STALE_AFTER_MS = 48 * 60 * 60_000;
/** How often the refresh tick wakes (it reads only when the rules above say so). */
export const INDEX_TICK_MS = 60 * 60_000;
const MAX_PAGES = 20;

/** Thinking levels Artificial Analysis names in its variant labels ("High", "Max, Default Fallback"). */
const EFFORT_WORDS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface IndexEntry {
  aaId: string;
  aaSlug: string;
  aaName: string;
  releaseSlug: string;
  releaseName: string;
  variantLabel: string | null;
  effort: string | null;
  creator: string | null;
  indexVersion: string;
  score: number | null;
  indexCostPerTaskUsd: number | null;
  priceInputPer1mUsd: number | null;
  priceOutputPer1mUsd: number | null;
}

/** The thinking level a variant label names, read from Artificial Analysis's own words; null when none. */
export function effortOfLabel(label: string | null): string | null {
  if (!label) return null;
  const first = label.split(",")[0]!.trim().toLowerCase();
  return (EFFORT_WORDS as readonly string[]).includes(first) ? first : null;
}

export class IndexReadError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly bronze: { pages?: unknown[] },
  ) {
    super(message);
    this.name = "IndexReadError";
  }
}

// ---------------------------------------------------------------------------
// Bronze, path 1: the Data API (a key is set)
// ---------------------------------------------------------------------------

const AaEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    model_creator: z.object({ name: z.string() }).passthrough().nullish(),
    evaluations: z.object({ artificial_analysis_intelligence_index: z.number().nullish() }).passthrough().nullish(),
    artificial_analysis_intelligence_index_cost: z
      .object({ cost_per_task: z.object({ total_cost: z.number().nullish() }).passthrough().nullish() })
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

/** "GLM-5.3 (Max)" -> { release: "GLM-5.3", label: "Max" }. */
function splitVariant(name: string): { release: string; label: string | null } {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(name);
  return m ? { release: m[1]!.trim(), label: m[2]!.trim() } : { release: name.trim(), label: null };
}

/** One page of the API's free list, validated. Throws on a shape we do not know (never a guessed field). */
export function parseIndexPage(body: unknown): { indexVersion: string; hasMore: boolean; entries: IndexEntry[] } {
  const parsed = AaPageSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Artificial Analysis answered a shape we do not read: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const indexVersion = String(parsed.data.intelligence_index_version);
  return {
    indexVersion,
    hasMore: parsed.data.pagination.has_more,
    entries: parsed.data.data.map((e) => {
      const { release, label } = splitVariant(e.name);
      // The API slugs each thinking level apart ("claude-haiku-5-5-high"): the release slug is the slug
      // without its own label's slug, when it ends with it (their words, never a guessed suffix).
      const labelSlug = label ? `-${label.split(",")[0]!.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : null;
      const releaseSlug = labelSlug && e.slug.endsWith(labelSlug) ? e.slug.slice(0, -labelSlug.length) : e.slug;
      return {
        aaId: e.id,
        aaSlug: e.slug,
        aaName: e.name,
        releaseSlug,
        releaseName: release,
        variantLabel: label,
        effort: effortOfLabel(label),
        creator: e.model_creator?.name ?? null,
        indexVersion,
        score: e.evaluations?.artificial_analysis_intelligence_index ?? null,
        indexCostPerTaskUsd: e.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost ?? null,
        priceInputPer1mUsd: e.pricing?.price_1m_input_tokens ?? null,
        priceOutputPer1mUsd: e.pricing?.price_1m_output_tokens ?? null,
      };
    }),
  };
}

/** Every page of the API's free list. Throws `IndexReadError` carrying the pages read so far. */
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
      throw new IndexReadError(`Artificial Analysis unreachable: ${err instanceof Error ? err.message : String(err)}`, null, { pages });
    }
    const text = await res.text();
    if (!res.ok) throw new IndexReadError(`Artificial Analysis answered ${res.status}: ${text.slice(0, 300)}`, res.status, { pages });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new IndexReadError(`Artificial Analysis answered ${res.status} with a body that is not JSON`, res.status, { pages });
    }
    pages.push(body);
    let parsed: ReturnType<typeof parseIndexPage>;
    try {
      parsed = parseIndexPage(body);
    } catch (err) {
      throw new IndexReadError(err instanceof Error ? err.message : String(err), res.status, { pages });
    }
    if (indexVersion !== null && parsed.indexVersion !== indexVersion) {
      throw new IndexReadError(`Artificial Analysis changed its index version mid-read (${indexVersion} then ${parsed.indexVersion})`, res.status, { pages });
    }
    indexVersion = parsed.indexVersion;
    entries.push(...parsed.entries);
    if (!parsed.hasMore) return { indexVersion, entries, pages };
  }
  throw new IndexReadError(`Artificial Analysis listed more than ${MAX_PAGES} pages: stopped reading`, 200, { pages });
}

// ---------------------------------------------------------------------------
// Store + refresh
// ---------------------------------------------------------------------------

export type IndexSource = "api";

export interface ReadRow {
  id: string;
  fetchedAt: Date;
  /** `superseded` = an early read whose silver was dropped by migration 0042 (re-read at the next tick). */
  status: "ok" | "failed" | "superseded";
  error: string | null;
  indexVersion: string | null;
  source: IndexSource | null;
}

export interface IndexState {
  /** The newest successful read and its silver rows (null = never read). */
  latestOk: { read: ReadRow; entries: IndexEntry[] } | null;
  /** The newest attempt, whatever its outcome. */
  latestAttempt: ReadRow | null;
}

function toReadRow(r: typeof intelligenceIndexReads.$inferSelect): ReadRow {
  return { id: r.id, fetchedAt: r.fetchedAt, status: r.status, error: r.error, indexVersion: r.indexVersion, source: r.source ?? null };
}

const READ_COLUMNS = {
  id: intelligenceIndexReads.id,
  fetchedAt: intelligenceIndexReads.fetchedAt,
  status: intelligenceIndexReads.status,
  error: intelligenceIndexReads.error,
  indexVersion: intelligenceIndexReads.indexVersion,
  source: intelligenceIndexReads.source,
};

export async function readIndexState(database: Database): Promise<IndexState> {
  // The bronze payloads (raw page, API pages) are never read back here: ~1.4 MB a read.
  // A `superseded` read (dropped by a migration) is no attempt: it must not hold the next read back an hour.
  const [attempt] = await database
    .select(READ_COLUMNS)
    .from(intelligenceIndexReads)
    .where(ne(intelligenceIndexReads.status, "superseded"))
    .orderBy(desc(intelligenceIndexReads.fetchedAt))
    .limit(1);
  const [ok] = await database
    .select(READ_COLUMNS)
    .from(intelligenceIndexReads)
    .where(eq(intelligenceIndexReads.status, "ok"))
    .orderBy(desc(intelligenceIndexReads.fetchedAt))
    .limit(1);
  const asRow = (r: typeof attempt) => toReadRow(r as typeof intelligenceIndexReads.$inferSelect);
  if (!ok) return { latestOk: null, latestAttempt: attempt ? asRow(attempt) : null };
  const rows = await database.select().from(intelligenceIndexScores).where(eq(intelligenceIndexScores.readId, ok.id));
  return {
    latestOk: {
      read: asRow(ok),
      entries: rows.map((r) => {
        if (r.releaseSlug === null || r.releaseName === null) throw new Error(`intelligence_index_scores row ${r.aaId} has no release (written before migration 0042)`);
        return {
        aaId: r.aaId,
        aaSlug: r.aaSlug,
        aaName: r.aaName,
        releaseSlug: r.releaseSlug,
        releaseName: r.releaseName,
        variantLabel: r.variantLabel,
        effort: r.effort,
        creator: r.creator,
        indexVersion: r.indexVersion,
        score: r.score,
        indexCostPerTaskUsd: r.indexCostPerTaskUsd,
        priceInputPer1mUsd: r.priceInputPer1mUsd,
        priceOutputPer1mUsd: r.priceOutputPer1mUsd,
        };
      }),
    },
    latestAttempt: attempt ? asRow(attempt) : null,
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
  const source: IndexSource = "api";
  if (!apiKey) return "no_key";
  if (!shouldRefresh(await readIndexState(database), now)) return "fresh";
  try {
    const read = await fetchIndex(apiKey, args.fetchImpl);
    await database.transaction(async (tx) => {
      const [row] = await tx
        .insert(intelligenceIndexReads)
        .values({ fetchedAt: now, status: "ok", httpStatus: 200, indexVersion: read.indexVersion, source, body: read.pages })
        .returning({ id: intelligenceIndexReads.id });
      const byId = new Map(read.entries.map((e) => [e.aaId, e]));
      if (byId.size > 0) {
        await tx.insert(intelligenceIndexScores).values([...byId.values()].map((e) => ({ readId: row!.id, ...e, fetchedAt: now })));
      }
    });
    console.log(`[intelligence-index] read ${read.entries.length} entries from ${source}, index v${read.indexVersion}`);
    return "stored";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const httpStatus = err instanceof IndexReadError ? err.httpStatus : null;
    const bronze = err instanceof IndexReadError ? err.bronze : {};
    console.error(`[intelligence-index] read from ${source} FAILED (served as broken on Monitoring): ${message}`);
    await database.insert(intelligenceIndexReads).values({
      fetchedAt: now,
      status: "failed",
      httpStatus,
      error: message,
      source,
      body: bronze.pages ?? null,
    });
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Gold: the model panel
// ---------------------------------------------------------------------------

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

/** The thinking Distry would run a model at: the level (Artificial Analysis's word) and how we say it. */
export interface DistryThinking {
  level: string | null;
  words: string;
}

/**
 * The thinking a /chat turn runs this model at. `savedLevel` = the level Distry's definition saved
 * (DISTRY-THINKING-1122: any provider), passed for the model Distry runs only; null = the model's
 * default: Anthropic sends no effort; Google sends `buildThinkingConfig`'s default (raised to the
 * model's floor); a direct vendor sends the reasoning field its tool rounds carry
 * (`VENDORS[...].toolCallRequestFields`: GPT-6.1 Terra runs at `none`), else nothing.
 */
export function distryThinkingFor(choice: Pick<ModelChoice, "provider" | "modelId">, savedLevel: string | null): DistryThinking {
  if (savedLevel) {
    return savedLevel === "none"
      ? { level: "none", words: "reasoning off (Distry's definition)" }
      : { level: savedLevel, words: `${choice.provider === "anthropic" ? "effort" : "thinking"} ${savedLevel} (Distry's definition)` };
  }
  if (choice.provider === "anthropic") return { level: null, words: "the model's default effort (Distry's definition sets none)" };
  if (choice.provider === "google") {
    const config = buildThinkingConfig(choice.modelId, false) as { thinkingLevel?: string };
    return config.thinkingLevel
      ? { level: config.thinkingLevel, words: `thinking ${config.thinkingLevel} (what /chat sends)` }
      : { level: null, words: "a thinking budget, no level" };
  }
  if (isVendorProvider(choice.provider)) {
    const effort = VENDORS[choice.provider].toolCallRequestFields?.[choice.modelId]?.reasoning_effort;
    if (typeof effort === "string") {
      return effort === "none"
        ? { level: "none", words: "reasoning off (what /chat sends with tools)" }
        : { level: effort, words: `reasoning ${effort} (what /chat sends with tools)` };
    }
  }
  return { level: null, words: "reasoning on, no level" };
}

/**
 * The level a scored variant names, in the words Distry's definition saves: its effort word,
 * `none` for "Non-reasoning", null when its label names no level.
 */
export function variantLevel(v: Pick<IndexEntry, "variantLabel" | "effort">): string | null {
  if (v.effort) return v.effort;
  return isNonReasoningLabel(v.variantLabel) ? "none" : null;
}

/** Artificial Analysis's word for a reading with reasoning off ("Non-reasoning"). */
function isNonReasoningLabel(label: string | null): boolean {
  return (label ?? "").split(",")[0]!.trim().toLowerCase() === "non-reasoning";
}

/** True when this variant is the model at that thinking level (`none` = Artificial Analysis's "Non-reasoning"). */
function variantRunsAt(v: IndexEntry, level: string): boolean {
  return level === "none" ? isNonReasoningLabel(v.variantLabel) : v.effort === level;
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
  | { kind: "matched"; releaseSlug: string; variants: IndexEntry[] }
  | { kind: "none"; near: string[] }
  | { kind: "ambiguous"; releases: string[] };

/**
 * The Artificial Analysis release that IS this model, by name tokens (no hand mapping, no scores in code).
 * Precedence: its release slug carries exactly our model id's tokens, else exactly our display name's,
 * else its release name carries our display name's. Two releases at one level = no pick. None = the
 * releases carrying our tokens plus only numbers (a dated build) are named, never picked.
 */
export function matchIndexEntry(model: Pick<ModelChoice, "modelId" | "displayName">, entries: readonly IndexEntry[]): IndexMatch {
  const idTokens = nameTokens(model.modelId);
  const displayTokens = nameTokens(model.displayName);
  const levels: Array<(e: IndexEntry) => boolean> = [
    (e) => nameTokens(e.releaseSlug) === idTokens,
    (e) => nameTokens(e.releaseSlug) === displayTokens,
    (e) => nameTokens(e.releaseName) === displayTokens,
  ];
  // A release = the entries sharing a release name (every thinking level of one model).
  const releaseOf = (e: IndexEntry) => nameTokens(e.releaseName);
  for (const test of levels) {
    const hits = entries.filter(test);
    const releases = [...new Set(hits.map(releaseOf))];
    if (releases.length === 1) {
      const variants = entries.filter((e) => releaseOf(e) === releases[0]);
      return { kind: "matched", releaseSlug: hits[0]!.releaseSlug, variants };
    }
    if (releases.length > 1) return { kind: "ambiguous", releases: [...new Set(hits.map((e) => e.releaseName))] };
  }
  const ours = displayTokens.split(" ");
  const near = entries.filter((e) => {
    const theirs = nameTokens(e.releaseName).split(" ");
    const extra = [...theirs];
    for (const t of ours) {
      const i = extra.indexOf(t);
      if (i === -1) return false;
      extra.splice(i, 1);
    }
    return extra.length > 0 && extra.every((t) => /^\d+$/.test(t));
  });
  return { kind: "none", near: [...new Set(near.map((e) => e.releaseName))] };
}

export type VariantPick = { kind: "picked"; entry: IndexEntry; why: string } | { kind: "not_picked"; reason: string };

/** Which of a release's variants is the model as Distry runs it. Never the nearest level. */
export function pickVariant(displayName: string, variants: readonly IndexEntry[], thinking: DistryThinking): VariantPick {
  if (variants.length === 1) return { kind: "picked", entry: variants[0]!, why: "Artificial Analysis's only reading of this model" };
  const levels = variants.map((v) => v.variantLabel ?? "unlabelled").join(", ");
  if (thinking.level) {
    const hits = variants.filter((v) => variantRunsAt(v, thinking.level!));
    if (hits.length === 1) return { kind: "picked", entry: hits[0]!, why: `at ${thinking.words}` };
    return { kind: "not_picked", reason: `Artificial Analysis scores ${displayName} at ${levels}: none at ${thinking.words}.` };
  }
  return { kind: "not_picked", reason: `Distry runs ${displayName} at ${thinking.words}, which Artificial Analysis does not name; it scores it at ${levels}.` };
}

/** Whether "Use" on this variant runs as scored (DISTRY-THINKING-1122). */
function variantRunnable(c: Pick<ModelChoice, "provider" | "modelId" | "displayName">, v: IndexEntry, variantCount: number): PanelVariant["distry"] {
  const level = variantLevel(v);
  if (level === null) {
    return variantCount === 1
      ? { level: null, canRun: true, reason: null }
      : { level: null, canRun: false, reason: `Artificial Analysis's label "${v.variantLabel ?? "unlabelled"}" names no thinking level Distry can set.` };
  }
  const refusal = thinkingLevelRefusal(c.provider, c.modelId, c.displayName, level);
  return { level, canRun: refusal === null, reason: refusal };
}

export type RatioBasis = "index_run_cost" | "blended_price_3_to_1";

export interface PanelVariant {
  aaName: string;
  variantLabel: string | null;
  effort: string | null;
  score: number | null;
  indexCostPerTaskUsd: number | null;
  intelligencePerDollar: number | null;
  isDistrysThinking: boolean;
  /**
   * What "Use" saves for this variant (DISTRY-THINKING-1122): the level (null = the model's
   * default, a model scored once), whether Distry can run it, and why not, in words.
   */
  distry: { level: string | null; canRun: boolean; reason: string | null };
}

export interface ModelPanelRow {
  provider: Provider;
  modelId: string;
  displayName: string;
  names: string[];
  capabilityTier: CapabilityTier;
  isCurrent: boolean;
  thinking: string;
  /** Every thinking level Distry can run this model at, with tools (empty = its default only). */
  thinkingLevels: string[];
  /** Whether a Distry turn runs on this model right now; the reason when it does not (its vendor is out of credit). */
  availability: { runsNow: boolean; reason: string | null };
  price: {
    inputPer1mUsd: number | null;
    outputPer1mUsd: number | null;
    costNames: { input: string; output: string } | null;
    reason: string | null;
  };
  index: {
    aaSlug: string | null;
    aaName: string | null;
    variantLabel: string | null;
    picked: string | null;
    score: number | null;
    rank: number | null;
    rankOutOf: number;
    indexCostPerTaskUsd: number | null;
    reason: string | null;
  };
  intelligencePerDollar: {
    value: number | null;
    basis: RatioBasis | null;
    reason: string | null;
  };
  variants: PanelVariant[];
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
  current: { provider: string; model: string; modelId: string; effort: string | null };
  models: ModelPanelRow[];
}

export const PRICE_BASIS =
  "What a run is billed per 1M tokens: our stored catalogue price (costs-service platform price) under the cost names chat-service declares for this model, input and output, at the time of this read.";
export const RATIO_BASIS =
  "Intelligence Index points per US dollar of Artificial Analysis's cost per task of running its Intelligence Index on this model, at the thinking Distry runs it (their published run cost). A model without a published run cost is ranked after them on points per dollar of a blended 1M tokens (3 input : 1 output, our catalogue price), and says so.";

function refreshState(state: IndexState, now: Date, keyConfigured: boolean): ModelPanel["refresh"] {
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

function runCostRatio(score: number | null, costPerTask: number | null): number | null {
  return score !== null && costPerTask !== null && costPerTask > 0 ? roundTo(score / costPerTask, 4) : null;
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
  current: { provider: string; model: string; effort: string | null };
  now: Date;
  /** The stored out-of-credit fact per provider (vendor-credit.ts); omitted = every vendor serves. */
  outOfCredit?: (provider: Provider) => string | null;
}): ModelPanel {
  const { choices, state, keyConfigured, priceOf, pricesRead, current, now } = args;
  const outOfCredit = args.outOfCredit ?? (() => null);
  const entries = state.latestOk?.entries ?? [];
  const currentModelId = resolveModel(current.provider as Provider, current.model).apiModelId;

  const noReadingReason = !state.latestOk
    ? !keyConfigured
      ? "No Intelligence Index reading: the Artificial Analysis key is not set."
      : state.latestAttempt?.status === "failed"
      ? `No Intelligence Index reading: the Artificial Analysis read failed (${state.latestAttempt.error ?? "no error recorded"}).`
      : "No Intelligence Index reading yet: the first read has not run."
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

    const isCurrent = currentModelId === c.modelId && current.provider === c.provider;
    const levels = chatThinkingLevels(c.provider, c.modelId);
    // The saved level reads the model Distry runs, and a sibling of its provider that runs at it
    // (what a switch keeping the level would run); every other row reads at its own default.
    const savedApplies = current.effort !== null && (isCurrent || (c.provider === current.provider && levels.includes(current.effort)));
    const thinking = distryThinkingFor(c, savedApplies ? current.effort : null);

    // Index score: the release, then the variant at Distry's thinking.
    let picked: IndexEntry | null = null;
    let pickedWhy: string | null = null;
    let variants: IndexEntry[] = [];
    let indexReason: string | null = noReadingReason;
    if (state.latestOk) {
      const match = matchIndexEntry(c, entries);
      if (match.kind === "none") {
        indexReason = match.near.length > 0
          ? `Artificial Analysis lists ${c.displayName} only as ${match.near.join(", ")}: none picked.`
          : `Artificial Analysis lists no model matching ${c.displayName}.`;
      } else if (match.kind === "ambiguous") {
        indexReason = `Several Artificial Analysis models match ${c.displayName} (${match.releases.join(", ")}): none picked.`;
      } else {
        variants = match.variants;
        const pick = pickVariant(c.displayName, match.variants, thinking);
        if (pick.kind === "not_picked") {
          indexReason = pick.reason;
        } else {
          picked = pick.entry;
          pickedWhy = pick.why;
          indexReason = picked.score === null ? `Artificial Analysis has not scored ${picked.aaName} on its Intelligence Index yet.` : null;
        }
      }
    }
    const score = picked?.score ?? null;
    const indexCostPerTaskUsd = picked?.indexCostPerTaskUsd ?? null;

    // Ratio on the index's own cost basis, else a stated blended price.
    let value: number | null = null;
    let basis: RatioBasis | null = null;
    let ratioReason: string | null = null;
    if (score === null) {
      ratioReason = "No Intelligence Index score.";
    } else if (indexCostPerTaskUsd !== null && indexCostPerTaskUsd > 0) {
      value = runCostRatio(score, indexCostPerTaskUsd);
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
      isCurrent,
      thinking: thinking.words,
      thinkingLevels: [...levels],
      availability: (() => {
        const reason = outOfCredit(c.provider);
        return { runsNow: reason === null, reason };
      })(),
      price: { inputPer1mUsd, outputPer1mUsd, costNames, reason: priceReason },
      index: {
        aaSlug: picked?.aaSlug ?? null,
        aaName: picked?.aaName ?? null,
        variantLabel: picked?.variantLabel ?? null,
        picked: pickedWhy,
        score,
        rank: null,
        rankOutOf: 0,
        indexCostPerTaskUsd,
        reason: indexReason,
      },
      intelligencePerDollar: { value, basis, reason: ratioReason },
      variants: [...variants]
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        .map((v) => ({
          aaName: v.aaName,
          variantLabel: v.variantLabel,
          effort: v.effort,
          score: v.score,
          indexCostPerTaskUsd: v.indexCostPerTaskUsd,
          intelligencePerDollar: runCostRatio(v.score, v.indexCostPerTaskUsd),
          isDistrysThinking: picked?.aaId === v.aaId,
          distry: variantRunnable(c, v, variants.length),
        })),
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
    refresh: refreshState(state, now, keyConfigured),
    priceBasis: PRICE_BASIS,
    ratioBasis: RATIO_BASIS,
    current: { provider: current.provider, model: current.model, modelId: currentModelId, effort: current.effort },
    models: rows,
  };
}
