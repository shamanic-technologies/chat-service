import type { ApiCallParams } from "./api-client.js";
import { assertFunnelNotMixed } from "./funnel-mix.js";

// ---------------------------------------------------------------------------
// Sales funnel CAMPAIGNS + their CAPS (owner 2026-10-10, "chat first").
// A campaign is brand x offer x sales funnel (features-service funnel id).
//   campaign-service  /sales-funnel-campaigns   (v0.75.15, PR #606/#609)
//   billing-service   /v1/brands/:b/offers/:o/sales-funnels/:f/caps (v0.83.6, PR #692)
// Neither is proxied by the gateway yet, so chat-service calls both DIRECTLY
// with its service keys and the chat's identity (x-org-id, x-user-id, x-run-id).
//
// Money rules the owners enforce and we mirror in the agent:
//   - a funnel campaign with NO max budget is held unfunded (a volume cap
//     alone never funds) — the agent states BOTH caps, asked from the user;
//   - a create from the chat is ALWAYS `stopped`; starting goes through the
//     switch-on gate (propose_switch_on start_funnel_campaign → the user's yes
//     → confirm_switch_on), which refuses while no max budget is stated.
// Bodies are returned verbatim: the owners own the shapes and the figures.
// ---------------------------------------------------------------------------

export class FunnelCampaignError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly reason: string | null,
    public readonly body: string,
  ) {
    super(`[funnel-campaigns] ${operation} refused (${status}${reason ? ` ${reason}` : ""}): ${body}`);
    this.name = "FunnelCampaignError";
  }
}

const enc = encodeURIComponent;

type Owner = "campaign" | "billing";

function owner(o: Owner): { url: string; key: string } {
  const prefix = o === "campaign" ? "CAMPAIGN_SERVICE" : "BILLING_SERVICE";
  const url = process.env[`${prefix}_URL`];
  const key = process.env[`${prefix}_API_KEY`];
  if (!url || !key) throw new Error(`${prefix}_URL / ${prefix}_API_KEY not configured`);
  return { url, key };
}

async function call(o: Owner, operation: string, method: string, path: string, p: ApiCallParams, body?: unknown): Promise<unknown> {
  const { url, key } = owner(o);
  const headers: Record<string, string> = {
    "x-api-key": key,
    "x-org-id": p.orgId,
    "x-user-id": p.userId,
    "x-run-id": p.runId,
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
  };
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    let reason: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { reason?: unknown };
      if (typeof parsed.reason === "string") reason = parsed.reason;
    } catch {
      // not JSON: carried raw in the error
    }
    throw new FunnelCampaignError(operation, res.status, reason, raw || "no body");
  }
  return raw ? (JSON.parse(raw) as unknown) : {};
}

function req(name: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`[funnel-campaigns] ${name} is required`);
  return v.trim();
}

function opt(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export const CAP_PERIODS = ["one_off", "daily", "weekly", "monthly"] as const;

function period(name: string, v: unknown): (typeof CAP_PERIODS)[number] {
  if (!(CAP_PERIODS as readonly unknown[]).includes(v)) throw new Error(`[funnel-campaigns] ${name}.period must be one of ${CAP_PERIODS.join(", ")}`);
  return v as (typeof CAP_PERIODS)[number];
}

function positiveInt(name: string, v: unknown): number {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isInteger(n) || n < 1) throw new Error(`[funnel-campaigns] ${name} must be a positive whole number`);
  return n;
}

const capsPath = (a: Record<string, unknown>) =>
  `/v1/brands/${enc(req("brandId", a.brandId))}/offers/${enc(req("offerId", a.offerId))}/sales-funnels/${enc(req("salesFunnelId", a.salesFunnelId))}/caps`;

// --- Reads (free) -------------------------------------------------------------

/** GET /sales-funnel-campaigns?brandId&offerId&salesFunnelId&status — each with its units. */
export async function listFunnelCampaigns(a: Record<string, unknown>, p: ApiCallParams) {
  const q = Object.entries({ brandId: opt(a.brandId), offerId: opt(a.offerId), salesFunnelId: opt(a.salesFunnelId), status: opt(a.status) })
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${enc(v as string)}`)
    .join("&");
  return call("campaign", "list_funnel_campaigns", "GET", `/sales-funnel-campaigns${q ? `?${q}` : ""}`, p);
}

/** GET billing caps: max budget / max volume and what this period consumed (`reached` = the stop verdict). */
export async function getFunnelCaps(a: Record<string, unknown>, p: ApiCallParams) {
  assertFunnelId(a.salesFunnelId);
  return call("billing", "get_funnel_caps", "GET", capsPath(a), p);
}

// --- Writes (data: start nothing) ----------------------------------------------

/**
 * PUT billing caps. Both keys are REQUIRED by the owner (object = state, null
 * = clear). We additionally require a max budget: a funnel without one is held
 * unfunded, so stating only a volume cannot be what the user meant.
 */
export async function setFunnelCaps(a: Record<string, unknown>, p: ApiCallParams) {
  const mb = a.maxBudget as Record<string, unknown> | null | undefined;
  if (!mb || typeof mb !== "object") {
    throw new Error("[funnel-campaigns] maxBudget is required ({amountCents, period}): a funnel with no max budget is held unfunded. Ask the user for it.");
  }
  if (!("maxVolume" in a)) {
    throw new Error("[funnel-campaigns] maxVolume is required: ask the user ({count, period}), or send null if they want no volume cap.");
  }
  const mv = a.maxVolume as Record<string, unknown> | null;
  const body = {
    maxBudget: { amountCents: positiveInt("maxBudget.amountCents", mb.amountCents), period: period("maxBudget", mb.period) },
    maxVolume: mv === null ? null : { count: positiveInt("maxVolume.count", mv?.count), period: period("maxVolume", mv?.period) },
  };
  return call("billing", "set_funnel_caps", "PUT", capsPath(a), p, body);
}

/** POST /sales-funnel-campaigns, always STOPPED from the chat (starting is the switch-on gate). */
/**
 * How to ask the caps, by the funnel's served type (owner 2026-10-10): a
 * proactive funnel is capped as "Max budget" / "Max volume" (first contacts);
 * a reactive one only spends when its trigger fires, so it is asked as
 * "Up to $X" / "Up to N prospects handled". Returned with the created campaign
 * so the very next question uses the right words.
 */
export function capsAskFor(type: "proactive" | "reactive"): string {
  return type === "reactive"
    ? "Reactive funnel: ask with present_choices 'Up to $X' (per one-off, day, week or month) and 'Up to N prospects handled' (per period). Never say 'max budget' or 'first contacts' for it. Then set_funnel_caps."
    : "Proactive funnel: ask with present_choices a 'Max budget' (per one-off, day, week or month) and a 'Max volume' in first contacts (per period). Then set_funnel_caps.";
}

export async function createFunnelCampaign(a: Record<string, unknown>, p: ApiCallParams) {
  const type = await assertFunnelNotMixed(req("salesFunnelId", a.salesFunnelId));
  const created = (await call("campaign", "create_funnel_campaign", "POST", "/sales-funnel-campaigns", p, {
    brandId: req("brandId", a.brandId),
    offerId: req("offerId", a.offerId),
    salesFunnelId: req("salesFunnelId", a.salesFunnelId),
    status: "stopped",
  })) as Record<string, unknown>;
  return { ...created, funnelType: type, askCapsAs: capsAskFor(type) };
}

/** PATCH stop: no new first touches (follow-ups of contacted leads still go out). Safe, no confirmation. */
export async function stopFunnelCampaign(a: Record<string, unknown>, p: ApiCallParams) {
  return call("campaign", "stop_funnel_campaign", "PATCH", `/sales-funnel-campaigns/${enc(req("salesFunnelCampaignId", a.salesFunnelCampaignId))}`, p, {
    status: "stop",
  });
}

// --- Start (only from confirm_switch_on) ----------------------------------------

interface CapsRead {
  maxBudget?: { amountCents?: number; period?: string } | null;
  maxVolume?: { count?: number; period?: string } | null;
}

/** propose_switch_on guard: the funnel's caps as stated now; refuses while no max budget is stated. */
export async function requireStatedMaxBudget(target: { brandId: string; offerId: string; salesFunnelId: string }, p: ApiCallParams) {
  // A mixed funnel is never started either (its budget would starve the proactive part).
  await assertFunnelNotMixed(target.salesFunnelId);
  const caps = (await getFunnelCaps(target, p)) as CapsRead;
  if (!caps.maxBudget) {
    throw new Error(
      "[funnel-campaigns] this funnel has no max budget: it would be held unfunded and start nothing. Ask the user for a max budget and a max volume, set them with set_funnel_caps, then propose again.",
    );
  }
  return { maxBudget: caps.maxBudget, maxVolume: caps.maxVolume ?? null };
}

/** POST status "ongoing": creates and starts, or starts the existing stopped one (`started`). */
export async function startFunnelCampaign(t: { brandId: string; offerId: string; salesFunnelId: string }, p: ApiCallParams) {
  return call("campaign", "confirm_switch_on:start_funnel_campaign", "POST", "/sales-funnel-campaigns", p, {
    brandId: t.brandId,
    offerId: t.offerId,
    salesFunnelId: t.salesFunnelId,
    status: "ongoing",
  });
}

// --- Campaign rows (every campaign, pre-funnel and funnel units) ------------------

/** Rows per page: 15 compact rows stay under ~2k tokens (owner rule: no tool result above it). */
export const CAMPAIGN_PAGE_MAX = 15;
const CAMPAIGN_PAGE_DEFAULT = 10;
const CAMPAIGN_STATUSES = ["ongoing", "stopped"] as const;

/** The fields the agent acts on; the full row (~1.5k chars, 40 fields) is what made one read 340k characters. */
const CAMPAIGN_FIELDS = ["id", "name", "status", "stopReason", "offerId", "featureSlug", "legKey", "salesFunnelCampaignId", "createdAt"] as const;

/**
 * list_campaigns: GET campaign-service /campaigns with filters and a limit
 * (newest first), each row cut to CAMPAIGN_FIELDS. `hasMore` says the page is
 * not the whole list: narrow with a filter rather than page through.
 */
export async function listCampaignsCompact(a: Record<string, unknown>, p: ApiCallParams) {
  const status = opt(a.status);
  if (status !== null && !(CAMPAIGN_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`[funnel-campaigns] status must be one of ${CAMPAIGN_STATUSES.join(", ")} (omit it for both)`);
  }
  let limit = CAMPAIGN_PAGE_DEFAULT;
  if (a.limit !== undefined && a.limit !== null) {
    limit = Number(a.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > CAMPAIGN_PAGE_MAX) {
      throw new Error(`[funnel-campaigns] limit must be a whole number from 1 to ${CAMPAIGN_PAGE_MAX}`);
    }
  }
  const filters: Record<string, string | null> = {
    brandId: opt(a.brandId),
    status,
    offerId: opt(a.offerId),
    featureSlug: opt(a.featureSlug),
    legKey: opt(a.legKey),
    salesFunnelCampaignId: opt(a.salesFunnelCampaignId),
  };
  const q = [
    ...Object.entries(filters)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}=${enc(v as string)}`),
    `limit=${limit}`,
  ].join("&");
  const body = (await call("campaign", "list_campaigns", "GET", `/campaigns?${q}`, p)) as {
    campaigns?: Array<Record<string, unknown>>;
    hasMore?: boolean;
  };
  if (!Array.isArray(body.campaigns)) throw new Error("[funnel-campaigns] list_campaigns: campaign-service answered without a campaigns array");
  const campaigns = body.campaigns.map((c) => Object.fromEntries(CAMPAIGN_FIELDS.map((f) => [f, c[f] ?? null])));
  return {
    campaigns,
    shown: campaigns.length,
    hasMore: body.hasMore === true,
    ...(body.hasMore ? { note: "More campaigns exist (newest shown first). Narrow with status, offerId, featureSlug or salesFunnelCampaignId." } : {}),
  };
}

// --- The account's campaigns, as the customer sees them -------------------------

/**
 * A campaign IS a sales funnel campaign (owner rule). Its units (one per step:
 * a source, cold email, AI booking) are nested as `steps` and are never
 * counted or named as campaigns (prod 2026-10-10: the Copilot told NOVEMIQ
 * "6 campaigns" where the Campaigns page shows 3). Each campaign carries its
 * caps from billing in the owner's words: proactive "Max $10/day", reactive
 * "Up to $1/day", none "Not funded (no max budget)", and what this period
 * spent. Pure formatting of served figures, nothing computed.
 */
interface FunnelCampaignRow {
  id: string;
  offerId: string;
  salesFunnelId: string;
  salesFunnelName?: string | null;
  status: string;
  stopReason?: string | null;
  units?: Array<{ featureSlug?: string; legKey?: string; status?: string; pipeId?: string }>;
}

interface CapsBody {
  salesFunnelType?: "proactive" | "reactive" | null;
  volumeUnit?: string | null;
  maxBudget?: { amountCents: string | number; period: string; consumedCents?: string | number | null; reached?: boolean; consumedUnavailableReason?: string | null } | null;
  maxVolume?: { count: string | number; period: string; consumed?: string | number | null; reached?: boolean } | null;
}

const PER: Record<string, string> = { daily: "/day", weekly: "/week", monthly: "/month", one_off: " one-off" };
const SPENT_WHEN: Record<string, string> = { daily: "today", weekly: "this week", monthly: "this month", one_off: "so far" };

const usd = (cents: string | number): string => {
  const v = Number(cents) / 100;
  return `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
};

/** "Max $10/day" (proactive), "Up to $1/day" (reactive), or not funded. */
export function budgetWords(type: "proactive" | "reactive" | null | undefined, maxBudget: CapsBody["maxBudget"]): string {
  if (!maxBudget) return "Not funded (no max budget)";
  return `${type === "reactive" ? "Up to" : "Max"} ${usd(maxBudget.amountCents)}${PER[maxBudget.period] ?? ` per ${maxBudget.period}`}`;
}

export function volumeWords(type: "proactive" | "reactive" | null | undefined, maxVolume: CapsBody["maxVolume"], unit: string | null | undefined): string | null {
  if (!maxVolume) return null;
  const what = unit === "prospects_handled" ? "prospects handled" : "first contacts";
  return `${type === "reactive" ? "Up to" : "Max"} ${Number(maxVolume.count)} ${what}${PER[maxVolume.period] ?? ` per ${maxVolume.period}`}`;
}

export function spentWords(maxBudget: CapsBody["maxBudget"]): string | null {
  if (!maxBudget) return null;
  if (maxBudget.consumedCents === null || maxBudget.consumedCents === undefined) {
    return `spend not measurable right now (${maxBudget.consumedUnavailableReason ?? "unknown reason"})`;
  }
  return `${usd(maxBudget.consumedCents)} spent ${SPENT_WHEN[maxBudget.period] ?? "this period"}${maxBudget.reached ? " (cap reached: no new first touches until the next period)" : ""}`;
}

/** features-service's per funnel campaign results (owner 2026-10-11): one row per campaign, money since inception. */
interface CampaignResults {
  id: string;
  description?: string | null;
  investedUsd?: number | null;
  roiMultiple?: number | null;
  moneyUnavailableReason?: string | null;
  maturity?: { isMature?: boolean } | null;
}

async function campaignResults(brandId: string, p: ApiCallParams): Promise<Map<string, CampaignResults>> {
  const url = process.env.FEATURES_SERVICE_URL;
  const key = process.env.FEATURES_SERVICE_API_KEY;
  if (!url || !key) throw new Error("FEATURES_SERVICE_URL / FEATURES_SERVICE_API_KEY not configured");
  const res = await fetch(`${url}/brands/${enc(brandId)}/sales-funnel-campaigns?pricing=net`, {
    headers: { "x-api-key": key, "x-org-id": p.orgId, "x-user-id": p.userId, "x-run-id": p.runId },
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new FunnelCampaignError("list_campaigns:results", res.status, null, raw || "no body");
  const body = JSON.parse(raw) as { salesFunnelCampaigns?: CampaignResults[] };
  if (!Array.isArray(body.salesFunnelCampaigns)) throw new Error("[funnel-campaigns] features-service answered without salesFunnelCampaigns");
  return new Map(body.salesFunnelCampaigns.map((r) => [r.id, r]));
}

/** "$67.46 invested since start" (net, what the customer pays), or why it is not known. */
export function investedWords(r: CampaignResults | undefined): string {
  if (!r) return "not known yet (no results served for this campaign)";
  if (typeof r.investedUsd !== "number") return `not known (${r.moneyUnavailableReason ?? "unavailable"})`;
  return `$${r.investedUsd} invested since start`;
}

/** The campaign's return as served, with its maturity: never presented as final while learning. */
export function returnWords(r: CampaignResults | undefined): string {
  if (!r || typeof r.roiMultiple !== "number") return "no return measured yet";
  return r.maturity?.isMature === true ? `${r.roiMultiple}x` : `${r.roiMultiple}x so far (still learning, not mature)`;
}

export async function listAccountCampaigns(a: Record<string, unknown>, p: ApiCallParams) {
  const status = opt(a.status);
  if (status !== null && !(CAMPAIGN_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`[funnel-campaigns] status must be one of ${CAMPAIGN_STATUSES.join(", ")} (omit it for both)`);
  }
  const q = Object.entries({ brandId: opt(a.brandId), offerId: opt(a.offerId), status })
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${enc(v as string)}`)
    .join("&");
  const body = (await call("campaign", "list_campaigns", "GET", `/sales-funnel-campaigns${q ? `?${q}` : ""}`, p)) as {
    salesFunnelCampaigns?: FunnelCampaignRow[];
  };
  if (!Array.isArray(body.salesFunnelCampaigns)) throw new Error("[funnel-campaigns] campaign-service answered without salesFunnelCampaigns");
  const brandIds = [...new Set(body.salesFunnelCampaigns.map((c) => opt(a.brandId) ?? (c as unknown as { brandId?: string }).brandId ?? ""))].filter(Boolean);
  const resultsByBrand = new Map(await Promise.all(brandIds.map(async (b) => [b, await campaignResults(b, p)] as const)));
  const campaigns = await Promise.all(
    body.salesFunnelCampaigns.map(async (c) => {
      const brandId = opt(a.brandId) ?? (c as unknown as { brandId?: string }).brandId ?? "";
      const caps = (await getFunnelCaps({ brandId, offerId: c.offerId, salesFunnelId: c.salesFunnelId }, p)) as CapsBody;
      const results = resultsByBrand.get(brandId)?.get(c.id);
      return {
        id: c.id,
        name: c.salesFunnelName ?? c.salesFunnelId,
        description: results?.description ?? null,
        type: caps.salesFunnelType ?? null,
        status: c.status,
        stopReason: c.stopReason ?? null,
        budget: budgetWords(caps.salesFunnelType, caps.maxBudget ?? null),
        volume: volumeWords(caps.salesFunnelType, caps.maxVolume ?? null, caps.volumeUnit),
        spent: spentWords(caps.maxBudget ?? null),
        invested: investedWords(results),
        return: returnWords(results),
        offerId: c.offerId,
        salesFunnelId: c.salesFunnelId,
        // The funnel's steps: parts of THIS campaign, never campaigns of their own.
        steps: (c.units ?? []).map((u) => ({ channel: u.featureSlug ?? null, leg: u.legKey ?? null, status: u.status ?? null })),
      };
    }),
  );
  return {
    campaignCount: campaigns.length,
    campaigns,
    note: "A campaign is a sales funnel campaign: this is the full list. Its steps (sources, cold email, AI booking...) are parts of it, never campaigns: never count or name them as campaigns.",
  };
}

/** STAFF ONLY detail: every unit (one per step) of every campaign, compact. */
export async function listCampaignUnits(a: Record<string, unknown>, p: ApiCallParams, reader: CampaignReader) {
  if (!(await reader.isStaff())) {
    throw new Error("[funnel-campaigns] the unit detail is staff only: a customer's campaigns are list_campaigns (funnel campaigns).");
  }
  return listCampaignsCompact(a, p);
}

export interface CampaignReader {
  isStaff: () => Promise<boolean>;
}

/** get_funnel_caps takes the FUNNEL id, never a campaign id (prod: the model passed one and read "no caps"). */
function assertFunnelId(v: unknown): void {
  if (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())) {
    throw new Error("[funnel-campaigns] salesFunnelId is the funnel's id (e.g. lead_found_to_conversation@...), not a campaign id: read it from list_campaigns (salesFunnelId).");
  }
}

export const FUNNEL_CAMPAIGN_TOOLS: Record<string, (a: Record<string, unknown>, p: ApiCallParams, reader: CampaignReader) => Promise<unknown>> = {
  list_campaigns: (a, p, reader) => (a.staffUnits === true ? listCampaignUnits(a, p, reader) : listAccountCampaigns(a, p)),
  list_funnel_campaigns: (a, p) => listAccountCampaigns(a, p),
  get_funnel_caps: getFunnelCaps,
  set_funnel_caps: setFunnelCaps,
  create_funnel_campaign: createFunnelCampaign,
  stop_funnel_campaign: stopFunnelCampaign,
};
