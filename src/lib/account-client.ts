import { apiServiceFetch, type ApiCallParams } from "./api-client.js";
import { FunnelError } from "./funnel-client.js";

// ---------------------------------------------------------------------------
// Account-awareness READS — what a chat needs to ground its first suggestions
// in the org's real state: offers, money, replies waiting, recent work.
//
// Every figure comes from the service that serves it, through the api-service
// gateway with the caller's forwarded identity, read with the SAME query the
// dashboard v2 uses for that figure (so the chat and the page never state two
// numbers for one thing). Responses are returned verbatim: the model quotes
// served figures and never computes a stat. All GET, no writes, no spend.
//
// Brands, campaigns, daily budget and pause state are already served by the
// funnel tools (list_brands, list_campaigns, get_daily_budget, get_brand_pause).
// ---------------------------------------------------------------------------

async function getJson(operation: string, path: string, params: ApiCallParams): Promise<unknown> {
  const res = await apiServiceFetch(path, "GET", params);
  const raw = await res.text();
  if (!res.ok) throw new FunnelError(operation, res.status, raw || "unknown error");
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

export type AccountWindow = "today" | "last_7_days" | "last_30_days";

export const ACCOUNT_WINDOWS: readonly AccountWindow[] = ["today", "last_7_days", "last_30_days"];

const WINDOW_DAYS: Record<AccountWindow, number> = { today: 0, last_7_days: 6, last_30_days: 29 };

/**
 * The window's start instant: UTC midnight `days` days back (today = today's
 * UTC midnight). Only a date bound sent to the producer, never a figure.
 */
export function windowStart(window: AccountWindow, now: Date = new Date()): string {
  if (!(window in WINDOW_DAYS)) {
    throw new Error(`[account-client] unknown window "${window}" — use one of ${ACCOUNT_WINDOWS.join(", ")}`);
  }
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - WINDOW_DAYS[window]));
  return d.toISOString();
}

function requireId(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[account-client] ${name} is required`);
  }
  return value.trim();
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`[account-client] limit must be an integer between 1 and ${max}`);
  }
  return n;
}

/** GET /v1/brands/{brandId}/offers — the brand's offers (what it sells), with status. */
export function listOffers(brandId: unknown, params: ApiCallParams): Promise<unknown> {
  const id = requireId("brandId", brandId);
  return getJson("list_offers", `/v1/brands/${encodeURIComponent(id)}/offers`, params);
}

/** GET /v1/billing/accounts — the org's billing account: balance, credited, used, payment mode. */
export function getBillingAccount(params: ApiCallParams): Promise<unknown> {
  return getJson("get_billing_account", `/v1/billing/accounts`, params);
}

/** GET /v1/features/orgs/usage — everything the org has been billed, by kind of work. */
export function getOrgUsage(params: ApiCallParams): Promise<unknown> {
  return getJson("get_org_usage", `/v1/features/orgs/usage`, params);
}

/**
 * GET /v1/runs/stats/costs?brandId&groupBy=campaignId&startedAfter — spend and
 * run count per campaign since the window start (the dashboard's Today/week read).
 */
export function getSpendByCampaign(
  args: { brandId: unknown; window: unknown },
  params: ApiCallParams,
): Promise<unknown> {
  const brandId = requireId("brandId", args.brandId);
  const startedAfter = windowStart((args.window ?? "today") as AccountWindow);
  const qs = new URLSearchParams({ brandId, groupBy: "campaignId", startedAfter });
  return getJson("get_spend_by_campaign", `/v1/runs/stats/costs?${qs}`, params);
}

/**
 * GET /v1/offers/{offerId}/revenue?brandId&pricing=net[&windowDays] — the offer's
 * money and outcomes as the dashboard shows them (spend, emails, replies, return).
 */
export function getOfferPerformance(
  args: { brandId: unknown; offerId: unknown; windowDays?: unknown },
  params: ApiCallParams,
): Promise<unknown> {
  const brandId = requireId("brandId", args.brandId);
  const offerId = requireId("offerId", args.offerId);
  const qs = new URLSearchParams({ brandId, pricing: "net" });
  if (args.windowDays !== undefined && args.windowDays !== null) {
    const days = Number(args.windowDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error("[account-client] windowDays must be an integer between 1 and 365");
    }
    qs.set("windowDays", String(days));
  }
  return getJson("get_offer_performance", `/v1/offers/${encodeURIComponent(offerId)}/revenue?${qs}`, params);
}

/**
 * GET /v1/leads?brandId&offerId&view=basic&bucket=positive_reply&standing=sales_interest&sort=activity&limit
 * — the people who REPLIED with interest and nobody has handled yet (the
 * dashboard's "needs your call"). `total` is lead-service's own count.
 */
export function listRepliesToHandle(
  args: { brandId: unknown; offerId: unknown; limit?: unknown },
  params: ApiCallParams,
): Promise<unknown> {
  const brandId = requireId("brandId", args.brandId);
  const offerId = requireId("offerId", args.offerId);
  const qs = new URLSearchParams({
    brandId,
    offerId,
    view: "basic",
    bucket: "positive_reply",
    standing: "sales_interest",
    sort: "activity",
    limit: String(boundedLimit(args.limit, 5, 20)),
  });
  return getJson("list_replies_to_handle", `/v1/leads?${qs}`, params);
}

/** GET /v1/runs?brandId&limit[&startedAfter] — the brand's latest runs (work done), newest first. */
export function listRecentRuns(
  args: { brandId: unknown; window?: unknown; limit?: unknown },
  params: ApiCallParams,
): Promise<unknown> {
  const brandId = requireId("brandId", args.brandId);
  const qs = new URLSearchParams({ brandId, limit: String(boundedLimit(args.limit, 20, 50)) });
  if (args.window !== undefined && args.window !== null) {
    qs.set("startedAfter", windowStart(args.window as AccountWindow));
  }
  return getJson("list_recent_runs", `/v1/runs?${qs}`, params);
}
