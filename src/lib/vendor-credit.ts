// ---------------------------------------------------------------------------
// Vendor out of credit: a stored FACT, a staff read, and an automatic detour
// (VENDOR-CREDIT-1030)
//
// Each LLM vendor holds its own prepaid balance. When one runs dry the vendor
// refuses every call, and the whole model behind it stops answering. On
// 2026-10-29 ~16:00 UTC DeepSeek ran dry: instantly-service's reply judge
// (`deepseek-flash`, a platform call with no org) got a 402 on every reply, so
// positive replies were never flagged and opt-outs never recorded, while the
// only notice was a log line ("this log is the only notice").
//
// Three things replace that log line (and the staff EMAIL that used to ride
// beside it: owner rule, a monitoring alert is red on dashboard v2 Monitoring,
// never an email):
//
//  1. FACT. Every refusal in the vendor's own out-of-credit words, from ANY
//     caller (org-scoped `/complete` or platform `/internal/platform-complete`),
//     is stored: one open outage row per provider (first seen, last seen,
//     refused calls, rerouted calls) plus a per-UTC-day counter row. The outage
//     closes the moment a call on that provider succeeds.
//
//  2. READ. `GET /internal/vendor-credit` serves every provider's verdict and a
//     daily series, so Monitoring shows the vendor red until a call succeeds.
//
//  3. DETOUR (machine-fixable fact = auto-heal). While a provider is out of
//     credit, a call on ANY of its models goes to the cheapest model we already
//     serve in the same capability tier, on a vendor with credit, that takes the
//     same request (`fallbackModelFor`: one rule, no per-model list). The run declares the model that ACTUALLY
//     ran under ITS cost names (the route resolves cost names from the model it
//     calls), so the fallback is visible in the ledger at its true price. Once
//     per `PROBE_INTERVAL_MS` one call goes to the primary first (and falls
//     back inline if refused again), so traffic returns to the primary as soon
//     as the balance is topped up.
//
// Only refusals on OUR platform key are recorded or detoured: an org that
// brings its own key and empties it is that org's account, not the fleet's.
// ---------------------------------------------------------------------------

import { modelCatalogue, resolveModel, type Provider } from "./anthropic.js";
import { buildLlmCostNames } from "./cost-names.js";
import { MODEL_DISPLAY_NAMES } from "./model-ids.js";

type ResolvedModel = ReturnType<typeof resolveModel>;

/** Every provider chat-service calls, in the order the staff read lists them. */
export const CREDIT_PROVIDERS: readonly Provider[] = ["deepseek", "zai", "moonshot", "openai", "anthropic", "google"];

/** The vendor's own name, as the staff read prints it. */
export const PROVIDER_LABELS: Record<Provider, string> = {
  deepseek: "DeepSeek",
  zai: "Z.ai",
  moonshot: "Moonshot (Kimi)",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
};

/**
 * ONE rule for every model (LLM-CREDIT-GENERIC-1108, owner 2026-11-08: Gemini ran dry on 2026-11-07 23:05 UTC and
 * ~520 calls on Gemini 3.5 Flash-Lite were refused in 17 h, none rerouted, because the only detour was a hand-declared
 * `deepseek-flash` -> GLM-5.3 Flash entry). While a model's vendor is out of credit, its calls go to the CHEAPEST
 * model we already serve that:
 *   - sits in the same capability tier (cheap / strong / frontier, MODEL_MAP's recorded decision),
 *   - belongs to a vendor that is not out of credit itself,
 *   - takes the request as sent (the route judges that: image input, web search, JSON without a schema, sampling,
 *     effort), and
 *   - has a list price in costs-service (`GET /v1/platform-prices`), the same catalogue the run is billed from.
 * "Cheapest" = list price of a typical call (10k tokens in, 1k out). No vendor, model or caller is named here; a
 * new model joins the candidates the day MODEL_MAP serves it and costs-service prices it. Never Claude Haiku 4.5.
 */
export type AcceptsRequest = (candidate: ResolvedModel) => boolean;

const ACCEPTS_ANY: AcceptsRequest = () => true;
const NEVER_A_FALLBACK = "claude-haiku-4-5";
const TYPICAL_INPUT_TOKENS = 10_000;
const TYPICAL_OUTPUT_TOKENS = 1_000;
/** How often the price list is re-read from costs-service. */
export const PRICE_REFRESH_MS = 60 * 60_000;

/** Cost name -> list price in USD cents per unit (token). Null until costs-service was read once. */
let prices: Map<string, number> | null = null;

/** Install the list prices (the costs-service read, or a test fixture). */
export function setFallbackPrices(list: ReadonlyArray<{ name: string; pricePerUnitInUsdCents: string | number | null }>): void {
  const next = new Map<string, number>();
  for (const row of list) {
    const value = row.pricePerUnitInUsdCents === null ? NaN : Number(row.pricePerUnitInUsdCents);
    if (Number.isFinite(value)) next.set(row.name, value);
  }
  prices = next;
}

/**
 * Read the list prices from costs-service. Fail-soft and loud: an unreadable list keeps the last one read (prices
 * barely move); never read at all = no detour, calls on a dry vendor fail as they did before this rule.
 */
export async function refreshFallbackPrices(): Promise<void> {
  const base = process.env.COSTS_SERVICE_URL;
  if (!base) {
    console.error("[chat-service] [vendor-credit] COSTS_SERVICE_URL is not set: no list prices, so no detour for a vendor out of credit");
    return;
  }
  try {
    const res = await fetch(`${base}/v1/platform-prices`);
    if (!res.ok) throw new Error(`costs-service /v1/platform-prices ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error("costs-service /v1/platform-prices: not an array");
    setFallbackPrices(body as Array<{ name: string; pricePerUnitInUsdCents: string | number | null }>);
  } catch (err) {
    console.error(
      `[chat-service] [vendor-credit] list prices unreadable${prices ? " (keeping the last read)" : ": no detour until they are read"}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** List price of a typical call on `model` at `at`, or null when costs-service prices it not. */
function typicalCallCents(model: ResolvedModel, at: Date): number | null {
  if (!prices) return null;
  let names: { input: string; output: string };
  try {
    names = buildLlmCostNames({ provider: model.provider, costPrefix: model.costPrefix, at });
  } catch {
    return null;
  }
  const input = prices.get(names.input);
  const output = prices.get(names.output);
  if (input === undefined || output === undefined) return null;
  return input * TYPICAL_INPUT_TOKENS + output * TYPICAL_OUTPUT_TOKENS;
}

/** Every model served today, once each (the heads every callable name resolves to). */
function servedModels(): ResolvedModel[] {
  const byId = new Map<string, ResolvedModel>();
  for (const entry of modelCatalogue()) {
    const m = resolveModel(entry.provider, entry.model);
    if (!byId.has(m.apiModelId)) byId.set(m.apiModelId, m);
  }
  return [...byId.values()];
}

/** Where a call on `primary` goes while its vendor is out of credit, or null when no model qualifies. */
export function fallbackModelFor(primary: ResolvedModel, accepts: AcceptsRequest = ACCEPTS_ANY, at: Date = new Date()): ResolvedModel | null {
  let best: { model: ResolvedModel; cents: number } | null = null;
  for (const model of servedModels()) {
    if (model.provider === primary.provider) continue;
    if (model.capabilityTier !== primary.capabilityTier) continue;
    if (model.apiModelId === NEVER_A_FALLBACK) continue;
    if (outOfCredit.has(model.provider)) continue;
    if (!accepts(model)) continue;
    const cents = typicalCallCents(model, at);
    if (cents === null) continue;
    if (!best || cents < best.cents || (cents === best.cents && model.apiModelId < best.model.apiModelId)) best = { model, cents };
  }
  return best?.model ?? null;
}

/** How often, while a provider is out of credit, one call tries it first. */
export const PROBE_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Out-of-credit wording for the two native SDK paths. The direct vendors
// classify their own refusals in `VENDORS[...].isOutOfCreditRefusal` and throw
// `VendorOutOfCreditError`; Anthropic and Google surface a plain error, so the
// classification reads the vendor's documented words. Deliberately NARROW: a
// rate limit or an auth failure must not read as an empty balance.
// ---------------------------------------------------------------------------

/**
 * Anthropic: 400 "Your credit balance is too low to access the Anthropic API.", or the
 * Console spend limit: 400 "You have reached your specified API usage limits. You will
 * regain access on <date>." Both refuse every call until money or a setting changes, so
 * both are the same stored fact (prod 2026-11-12: the limit refused every Anthropic call,
 * Sophie's Haiku backup included, and nothing on Monitoring said so).
 */
const ANTHROPIC_EMPTY_BALANCE = /credit balance is too low|reached your specified API usage limits/i;
/** Google AI Studio prepay: "Your prepayment credits are depleted." */
const GOOGLE_EMPTY_BALANCE = /prepayment credits? (?:are|is) depleted/i;

/** True when `err` is the provider refusing because the account has no credit. */
export function isOutOfCreditError(provider: Provider, err: unknown): boolean {
  if (err && typeof err === "object" && (err as { name?: string }).name === "VendorOutOfCreditError") return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (provider === "anthropic") return ANTHROPIC_EMPTY_BALANCE.test(message);
  if (provider === "google") return GOOGLE_EMPTY_BALANCE.test(message);
  return false;
}

// ---------------------------------------------------------------------------
// Store: where the fact lives. Injected at boot (db-backed, see
// vendor-credit-store.ts); unit tests run on the in-memory state alone.
// ---------------------------------------------------------------------------

export interface OpenOutage {
  provider: Provider;
  firstSeenAt: Date;
}

export interface VendorCreditStore {
  /** A refused call: open the provider's outage (or extend the open one) and count it on its UTC day. */
  recordRefusal(input: { provider: Provider; model: string; at: Date; message: string }): Promise<void>;
  /** A call served by the fallback because the provider is out of credit. */
  recordReroute(input: { provider: Provider; at: Date }): Promise<void>;
  /** A call on the provider succeeded: close its open outage. */
  closeOutage(input: { provider: Provider; at: Date }): Promise<void>;
  /** Outages still open (boot: a restart mid-outage keeps the detour and the red). */
  loadOpen(): Promise<OpenOutage[]>;
}

let store: VendorCreditStore | null = null;

interface ProviderState {
  firstSeenAt: Date;
  /** Last time a call was sent to the out-of-credit provider to check it. */
  lastProbeAt: number;
}

const outOfCredit = new Map<Provider, ProviderState>();

function persist(what: string, write: Promise<void> | undefined): void {
  if (!write) return;
  // Fire-and-forget: the request never waits on the fact being written. A
  // failed write is logged loudly; the in-memory state still drives routing.
  write.catch((err: unknown) => {
    console.error(
      `[chat-service] [vendor-credit] failed to store ${what}:`,
      err instanceof Error ? err.message : String(err),
    );
  });
}

/** Boot: install the store and reload the outages a restart would otherwise forget. */
export async function initVendorCredit(s: VendorCreditStore): Promise<void> {
  store = s;
  const open = await s.loadOpen();
  for (const o of open) outOfCredit.set(o.provider, { firstSeenAt: o.firstSeenAt, lastProbeAt: 0 });
  if (open.length > 0) {
    console.error(
      `[chat-service] [vendor-credit] still out of credit at boot: ${open.map((o) => o.provider).join(", ")}`,
    );
  }
}

/** A platform-key call was refused in the provider's out-of-credit words. */
export function recordOutOfCredit(input: { provider: Provider; model: string; status?: number; message: string; at?: Date }): void {
  const at = input.at ?? new Date();
  const state = outOfCredit.get(input.provider);
  if (!state) {
    outOfCredit.set(input.provider, { firstSeenAt: at, lastProbeAt: at.getTime() });
    console.error(
      `[chat-service] [vendor-credit] ${PROVIDER_LABELS[input.provider]} is out of credit ` +
        `(model="${input.model}"${input.status ? `, status=${input.status}` : ""}). Red on Monitoring; ` +
        `calls go to the cheapest same-tier model on a vendor with credit until a call succeeds.`,
    );
  } else {
    state.lastProbeAt = at.getTime();
  }
  persist("a refusal", store?.recordRefusal({ provider: input.provider, model: input.model, at, message: input.message.slice(0, 500) }));
}

/** A call on the provider succeeded: the balance is fine, close the outage. */
export function markProviderServing(provider: Provider, at: Date = new Date()): void {
  if (!outOfCredit.has(provider)) return;
  outOfCredit.delete(provider);
  console.log(`[chat-service] [vendor-credit] ${PROVIDER_LABELS[provider]} serves again; calls return to it.`);
  persist("a recovery", store?.closeOutage({ provider, at }));
}

/** A call was served by the fallback because `provider` is out of credit. */
export function recordReroute(provider: Provider, at: Date = new Date()): void {
  persist("a reroute", store?.recordReroute({ provider, at }));
}

export function isProviderOutOfCredit(provider: Provider): boolean {
  return outOfCredit.has(provider);
}

export interface ServingChoice {
  /** The model this attempt calls. */
  resolved: ResolvedModel;
  /** Set when `resolved` is a fallback: the model the caller asked for. */
  fallbackFrom: ResolvedModel | null;
}

/**
 * Which model this request calls. The primary, unless its provider is out of
 * credit and another model qualifies (`fallbackModelFor`). Once per
 * `PROBE_INTERVAL_MS` the primary is tried anyway: that call is the probe, and
 * the route falls back inline if it is refused again.
 */
export function pickServingModel(primary: ResolvedModel, now: number = Date.now(), accepts: AcceptsRequest = ACCEPTS_ANY): ServingChoice {
  const state = outOfCredit.get(primary.provider);
  if (!state) return { resolved: primary, fallbackFrom: null };
  const fallback = fallbackModelFor(primary, accepts, new Date(now));
  if (!fallback) return { resolved: primary, fallbackFrom: null };
  if (now - state.lastProbeAt >= PROBE_INTERVAL_MS) {
    state.lastProbeAt = now;
    return { resolved: primary, fallbackFrom: null };
  }
  return { resolved: fallback, fallbackFrom: primary };
}

/** Test seam: forget every outage and the store. */
export function resetVendorCredit(): void {
  outOfCredit.clear();
  store = null;
  prices = null;
}

// ---------------------------------------------------------------------------
// The staff read
// ---------------------------------------------------------------------------

export interface OutageRow {
  provider: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  recoveredAt: Date | null;
  refusedCalls: number;
  reroutedCalls: number;
}

export interface DayCountRow {
  day: string;
  provider: string;
  refusedCalls: number;
  reroutedCalls: number;
}

export interface VendorCreditVendor {
  provider: Provider;
  label: string;
  outOfCredit: boolean;
  since: string | null;
  lastSeenAt: string | null;
  recoveredAt: string | null;
  fallbackModel: string | null;
  fallbackLabel: string | null;
  refusedCalls: number;
  reroutedCalls: number;
  sentence: string;
}

export interface VendorCreditDay {
  day: string;
  provider: Provider;
  outOfCredit: boolean;
  refusedCalls: number;
  reroutedCalls: number;
}

/**
 * The model a provider's calls go to while it is out of credit, as the staff read prints it: the fallback of its
 * cheapest served model for a plain text call (a call another model cannot take, e.g. an image, may go elsewhere).
 */
function providerFallback(provider: Provider, at: Date): ResolvedModel | null {
  const own = servedModels()
    .filter((m) => m.provider === provider)
    .map((m) => ({ m, cents: typicalCallCents(m, at) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.cents - b.cents);
  return own.length > 0 ? fallbackModelFor(own[0].m, ACCEPTS_ANY, at) : null;
}

function when(d: Date): string {
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

function sentenceFor(label: string, latest: OutageRow | undefined, fallbackLabel: string | null): string {
  if (latest && !latest.recoveredAt) {
    const head = `${label} has no credit since ${when(latest.firstSeenAt)}.`;
    return fallbackLabel
      ? `${head} Calls go to the cheapest model of the same tier on a vendor with credit (${fallbackLabel} for a plain call) until a ${label} call succeeds.`
      : `${head} ${label} calls fail until the account is topped up.`;
  }
  if (latest?.recoveredAt) return `${label} serves calls. The last empty balance ended ${when(latest.recoveredAt)}.`;
  return `${label} serves calls. No empty balance seen.`;
}

/**
 * Build the staff read from stored rows. Pure: the route passes the outages
 * that touch the window (plus the latest per provider) and the day counters.
 */
export function buildVendorCreditRead(input: {
  outages: OutageRow[];
  dayCounts: DayCountRow[];
  days: number;
  now?: Date;
}): { vendors: VendorCreditVendor[]; days: VendorCreditDay[] } {
  const now = input.now ?? new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = today - (input.days - 1) * 86_400_000;

  const vendors: VendorCreditVendor[] = CREDIT_PROVIDERS.map((provider) => {
    const label = PROVIDER_LABELS[provider];
    const mine = input.outages
      .filter((o) => o.provider === provider)
      .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime());
    const latest = mine[0];
    const fallback = providerFallback(provider, now);
    const fallbackLabel = fallback ? MODEL_DISPLAY_NAMES[fallback.apiModelId] ?? fallback.apiModelId : null;
    return {
      provider,
      label,
      outOfCredit: Boolean(latest && !latest.recoveredAt),
      since: latest && !latest.recoveredAt ? latest.firstSeenAt.toISOString() : null,
      lastSeenAt: latest ? latest.lastSeenAt.toISOString() : null,
      recoveredAt: latest?.recoveredAt ? latest.recoveredAt.toISOString() : null,
      fallbackModel: fallback ? fallback.apiModelId : null,
      fallbackLabel,
      refusedCalls: latest?.refusedCalls ?? 0,
      reroutedCalls: latest?.reroutedCalls ?? 0,
      sentence: sentenceFor(label, latest, fallbackLabel),
    };
  });
  // Broken first: a red vendor is the first thing the reader sees.
  vendors.sort((a, b) => Number(b.outOfCredit) - Number(a.outOfCredit));

  const counts = new Map(input.dayCounts.map((c) => [`${c.day}|${c.provider}`, c]));
  const days: VendorCreditDay[] = [];
  for (let i = 0; i < input.days; i++) {
    const start = from + i * 86_400_000;
    const end = start + 86_400_000;
    const day = new Date(start).toISOString().slice(0, 10);
    for (const provider of CREDIT_PROVIDERS) {
      const out = input.outages.some(
        (o) =>
          o.provider === provider &&
          o.firstSeenAt.getTime() < end &&
          (o.recoveredAt ?? now).getTime() >= start,
      );
      const c = counts.get(`${day}|${provider}`);
      days.push({
        day,
        provider,
        outOfCredit: out,
        refusedCalls: c?.refusedCalls ?? 0,
        reroutedCalls: c?.reroutedCalls ?? 0,
      });
    }
  }
  return { vendors, days };
}
