import type { ApiCallParams } from "./api-client.js";
import { DeclarationRefusedError, features } from "./declarations-client.js";
import { assertFunnelNotMixed } from "./funnel-mix.js";

// ---------------------------------------------------------------------------
// Sales funnel CAMPAIGNS + their CAPS (owner 2026-10-10, "chat first").
// A campaign is brand x offer x sales funnel (features-service funnel id).
//   campaign-service  /sales-funnel-campaigns   (v0.75.15, PR #606/#609)
//   billing-service   /v1/brands/:b/offers/:o/sales-funnels/:f/caps (v0.83.6, PR #692)
// Neither is proxied by the gateway yet, so chat-service calls both DIRECTLY
// with its service keys and the chat's identity (x-org-id, x-user-id, x-run-id).
//
// Money rules (owner 2026-10-11, "il FAUT une contrainte qui doit être SOIT un
// max $ ET/OU un max volume"):
//   - a funnel campaign needs AT LEAST ONE cap stated by the user: a max budget,
//     a max volume, or both. Either alone is valid; none is refused. The agent
//     never invents a cap nor asks again for one the user declined;
//   - whether billing FUNDS the funnel (spends on it) is billing's verdict, read
//     from what it serves (`fundingOf`), never assumed from the caps;
//   - a create from the chat is ALWAYS `stopped`; starting goes through the
//     switch-on gate (propose_switch_on start_funnel_campaign → the user's yes
//     → confirm_switch_on), which refuses while no cap is stated.
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
 * One cap argument: an object, or "no such cap". The model sometimes writes
 * "no cap" as the STRING "null" (prod 2026-10-11, Doc Dinners replay: refused,
 * then it invented a 100,000 volume), so the spellings of "none" are read as
 * null; anything else that is not an object is refused naming the two forms.
 */
const NO_CAP = new Set(["null", "none", ""]);
function capArg(name: string, v: unknown, shape: string): Record<string, unknown> | null {
  if (v === null || (typeof v === "string" && NO_CAP.has(v.trim().toLowerCase()))) return null;
  if (typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new Error(`[funnel-campaigns] ${name} must be ${shape} when the user stated it, or null when they want no such cap.`);
}

/**
 * PUT billing caps. Both keys are REQUIRED by the owner (object = state, null
 * = no cap), so a call that changes one cap never silently clears the other.
 * At least one must be stated: a funnel with neither cap is refused.
 */
export async function setFunnelCaps(a: Record<string, unknown>, p: ApiCallParams) {
  if (!("maxBudget" in a) || !("maxVolume" in a)) {
    throw new Error(
      "[funnel-campaigns] send both maxBudget and maxVolume: each is {…} when the user stated it, or null when the user wants no such cap.",
    );
  }
  const mb = capArg("maxBudget", a.maxBudget, "{amountCents, period}");
  const mv = capArg("maxVolume", a.maxVolume, "{count, period}");
  if (mb === null && mv === null) {
    throw new Error(
      "[funnel-campaigns] a campaign needs at least one cap: a max budget, a max volume, or both. Ask the user for the one they want.",
    );
  }
  const body = {
    maxBudget: mb === null ? null : { amountCents: positiveInt("maxBudget.amountCents", mb?.amountCents), period: period("maxBudget", mb?.period) },
    maxVolume: mv === null ? null : { count: positiveInt("maxVolume.count", mv?.count), period: period("maxVolume", mv?.period) },
  };
  const view = (await call("billing", "set_funnel_caps", "PUT", capsPath(a), p, body)) as CapsBody;
  return { ...view, funding: fundingWords(view) };
}

/**
 * Whether billing FUNDS this funnel (will spend on it), read from what billing
 * serves. Billing is adding `funded` to its caps view (volume-only funnels,
 * billing-service 2026-10-11); until it serves it, billing's rule is that only a
 * max budget funds, so a volume-only funnel is held. Never claim it runs on our
 * own reading of the caps.
 */
export function fundingOf(caps: CapsBody): boolean {
  if (typeof caps.funded === "boolean") return caps.funded;
  return caps.maxBudget != null;
}

/** What to tell the user about funding, in words. */
export function fundingWords(caps: CapsBody): string {
  if (fundingOf(caps)) return "Funded: once started, it spends within these caps.";
  if (!caps.maxBudget && !caps.maxVolume) return "No cap stated: it cannot start. Ask the user for a max budget or a max volume.";
  return "Held by billing: a campaign with no max budget is not funded yet, so it spends nothing even once started. Say so plainly; never say it runs.";
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
  const rule = "It needs at least one cap: budget, volume, or both. Skip any cap the user already stated or declined; never invent one. Then set_funnel_caps.";
  return type === "reactive"
    ? `Reactive funnel: the caps read 'Up to $X' (per one-off, day, week or month) and 'Up to N prospects handled' (per period). Never say 'max budget' or 'first contacts' for it. ${rule}`
    : `Proactive funnel: the caps read 'Max budget' (per one-off, day, week or month) and 'Max volume' in first contacts (per period). ${rule}`;
}

/**
 * What the campaign does is the funnel's own served line (who works each leg),
 * said to the user in plain words. Homogeneous for every funnel: a funnel whose
 * line holds no channel that writes to a lead (a source, then the customer's
 * own team) only FINDS leads, and the user is told no email goes out.
 */
export const FUNNEL_LINE_RULE =
  "Say what this campaign does from funnelLine, in plain words. When no step on it writes to a lead (only a lead source, then the user's own team), say plainly: we find the leads and hand them to your team, no email goes out.";

export async function createFunnelCampaign(a: Record<string, unknown>, p: ApiCallParams) {
  const { type, line } = await assertFunnelNotMixed(req("salesFunnelId", a.salesFunnelId));
  const created = (await call("campaign", "create_funnel_campaign", "POST", "/sales-funnel-campaigns", p, {
    brandId: req("brandId", a.brandId),
    offerId: req("offerId", a.offerId),
    salesFunnelId: req("salesFunnelId", a.salesFunnelId),
    status: "stopped",
  })) as Record<string, unknown>;
  return { ...created, funnelType: type, funnelLine: line, askCapsAs: capsAskFor(type), tellUser: FUNNEL_LINE_RULE };
}

/** PATCH stop: no new first touches (follow-ups of contacted leads still go out). Safe, no confirmation. */
export async function stopFunnelCampaign(a: Record<string, unknown>, p: ApiCallParams) {
  return call("campaign", "stop_funnel_campaign", "PATCH", `/sales-funnel-campaigns/${enc(req("salesFunnelCampaignId", a.salesFunnelCampaignId))}`, p, {
    status: "stop",
  });
}

// --- Start (only from confirm_switch_on) ----------------------------------------

/** propose_switch_on guard: the funnel's caps as stated now; refuses while NEITHER cap is stated. */
export async function requireStatedCap(target: { brandId: string; offerId: string; salesFunnelId: string }, p: ApiCallParams) {
  // A mixed funnel is never started either (its budget would starve the proactive part).
  await assertFunnelNotMixed(target.salesFunnelId);
  const caps = (await getFunnelCaps(target, p)) as CapsBody;
  if (!caps.maxBudget && !caps.maxVolume) {
    throw new Error(
      "[funnel-campaigns] this funnel has no cap: a campaign needs a max budget, a max volume, or both. Ask the user, set it with set_funnel_caps, then propose again.",
    );
  }
  return { maxBudget: caps.maxBudget ?? null, maxVolume: caps.maxVolume ?? null, funded: fundingOf(caps), funding: fundingWords(caps) };
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
  /** Billing's funding verdict, once served (see fundingOf). */
  funded?: boolean;
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

/** "Max $10/day" (proactive), "Up to $1/day" (reactive), or no max budget (held or not, as billing says). */
export function budgetWords(type: "proactive" | "reactive" | null | undefined, maxBudget: CapsBody["maxBudget"], funded: boolean): string {
  if (!maxBudget) return funded ? "No max budget (capped by volume)" : "Not funded (no max budget)";
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
  /** The campaign's path, in order (owner 2026-10-11: the path IS the description). */
  path?: { items?: Array<{ kind?: string; label?: string; name?: string }> } | null;
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

/** "Lead found → Sales Cold Email Outreach → Positive reply → Paid client": the served path items, in order. */
export function pathWords(r: CampaignResults | undefined): string | null {
  const items = r?.path?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  // A step carries its label; a channel and a reactive funnel's trigger carry their name (prod 2026-10-14: the trigger read "?").
  return items.map((i) => (i.kind === "step" ? i.label : i.name) ?? "?").join(" → ");
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

/** "Each time: Email Pushed Via API" for a reactive funnel; a proactive one runs on its own caps. */
export function triggerWords(triggerName: string | null): string {
  return triggerName ? `Each time: ${triggerName}` : "On its own, within its caps (no trigger)";
}

/** What a campaign whose sales funnel features-service retired says it runs on (campaign-service#764). */
export const RETIRED_FUNNEL_WORDS = "Not known: its sales funnel was retired from the catalogue (the campaign is kept, stopped, with its history)";

/**
 * The funnel as features-service serves it. A RETIRED funnel (catalogue retire, features v2026-10-16) answers
 * 404 `sales_funnel_not_found` while campaigns still point at it: that campaign is listed and flagged, never
 * dropped, and one orphan never fails the whole list (prod 2026-10-18, org f0420eb5: "Signup Follow-up Deals"
 * made every stopped / unfiltered list fail). Any other refusal stays loud.
 */
async function servedFunnel(salesFunnelId: string): Promise<{ retired: boolean; trigger?: { name?: string } | null }> {
  try {
    const body = (await features("list_campaigns:funnel", "GET", `/internal/catalogue/sales-funnels/${enc(salesFunnelId)}`)) as {
      trigger?: { name?: string } | null;
    };
    return { retired: false, trigger: body.trigger ?? null };
  } catch (err) {
    if (err instanceof DeclarationRefusedError && err.status === 404 && err.reason === "sales_funnel_not_found") {
      console.error(`[funnel-campaigns] list_campaigns: sales funnel ${salesFunnelId} is retired from the catalogue, campaign flagged funnelRetired`);
      return { retired: true };
    }
    throw err;
  }
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
      const served = await servedFunnel(c.salesFunnelId);
      return {
        id: c.id,
        name: c.salesFunnelName ?? c.salesFunnelId,
        path: pathWords(results),
        // What starts it (owner 2026-10-14: read what a running campaign already does before calling anything missing).
        runsWhen: served.retired ? RETIRED_FUNNEL_WORDS : triggerWords(served.trigger?.name ?? null),
        ...(served.retired ? { funnelRetired: true } : {}),
        type: caps.salesFunnelType ?? null,
        status: c.status,
        stopReason: c.stopReason ?? null,
        budget: budgetWords(caps.salesFunnelType, caps.maxBudget ?? null, fundingOf(caps)),
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

// --- The campaign that asked for a proactive turn --------------------------------

/**
 * The campaign whose step asked the Copilot to speak first (x-campaign-id), as
 * the team sees it. The header carries the STEP (one unit of a funnel
 * campaign), while list_campaigns shows funnel campaigns by their own id and
 * name, so the model could not tie the two (prod 2026-10-19: the hot-lead turn
 * proposed "Lead Proposal Deals", the very campaign notifying the team).
 * Resolved from campaign-service: the unit, then its funnel campaign. An id that
 * is already a funnel campaign is read as one. Unknown to both = loud.
 */
export interface AskingCampaign {
  /** Every id that names it: the unit and its funnel campaign. */
  ids: string[];
  name: string | null;
  salesFunnelId: string | null;
  /** The channel of the asking step (its feature slug), when the id was a unit. */
  channel: string | null;
}

export async function resolveAskingCampaign(campaignId: string, p: ApiCallParams): Promise<AskingCampaign> {
  const readFunnelCampaign = async (id: string) =>
    ((await call("campaign", "proactive:asking_funnel_campaign", "GET", `/sales-funnel-campaigns/${enc(id)}`, p)) as {
      salesFunnelCampaign?: { id: string; salesFunnelId?: string | null; salesFunnelName?: string | null };
    }).salesFunnelCampaign;
  let unit: { id: string; name?: string | null; featureSlug?: string | null; salesFunnelCampaignId?: string | null } | undefined;
  try {
    unit = ((await call("campaign", "proactive:asking_campaign", "GET", `/campaigns/${enc(campaignId)}`, p)) as { campaign?: typeof unit }).campaign;
  } catch (err) {
    if (!(err instanceof FunnelCampaignError && err.status === 404)) throw err;
  }
  if (!unit) {
    const funnel = await readFunnelCampaign(campaignId);
    if (!funnel) throw new Error(`[funnel-campaigns] the asking campaign ${campaignId} is unknown to campaign-service`);
    return { ids: [funnel.id], name: funnel.salesFunnelName ?? funnel.salesFunnelId ?? null, salesFunnelId: funnel.salesFunnelId ?? null, channel: null };
  }
  if (!unit.salesFunnelCampaignId) {
    return { ids: [unit.id], name: unit.name ?? null, salesFunnelId: null, channel: unit.featureSlug ?? null };
  }
  const funnel = await readFunnelCampaign(unit.salesFunnelCampaignId);
  if (!funnel) throw new Error(`[funnel-campaigns] campaign-service answered without the funnel campaign of ${campaignId}`);
  return {
    ids: [unit.id, funnel.id],
    name: funnel.salesFunnelName ?? funnel.salesFunnelId ?? null,
    salesFunnelId: funnel.salesFunnelId ?? null,
    channel: unit.featureSlug ?? null,
  };
}
