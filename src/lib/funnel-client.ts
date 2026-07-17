import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

// ---------------------------------------------------------------------------
// Funnel client — the end-to-end "operate the platform" surface a dashboard
// user drives, exposed to the agentic chat as tools. Every call routes through
// api-service (the single gateway) with the caller's forwarded identity, so the
// underlying operation (brand creation, campaign launch, budget, pause) is
// metered/owned by the downstream service against the caller's org — chat-service
// declares no cost of its own here (its only spend is the LLM call, unchanged).
//
// Fail loud: every non-2xx throws with the upstream status + body so the agentic
// loop surfaces a structured, self-correctable error via formatToolError. Response
// shapes are owned downstream (mostly opaque in the registry), so we return the
// parsed JSON verbatim rather than re-declaring shapes here.
// ---------------------------------------------------------------------------

export type FunnelCallParams = ApiCallParams;

export class FunnelError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly upstreamBody: string,
  ) {
    super(`[funnel-client] ${operation} failed (${status}): ${upstreamBody}`);
    this.name = "FunnelError";
  }
}

async function requestJson(
  operation: string,
  path: string,
  method: string,
  params: FunnelCallParams,
  body?: unknown,
): Promise<unknown> {
  const res = await apiServiceFetch(path, method, params, body);
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error");
    throw new FunnelError(operation, res.status, text);
  }
  // Some endpoints (e.g. proxies) may return an empty body on success.
  const raw = await res.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

// --- Brand creation from a URL (onboarding-equivalent) ---------------------

/** POST /v1/brands { url } — upsert a brand from its website URL. Returns the brandId. */
export function createBrandFromUrl(
  url: string,
  params: FunnelCallParams,
): Promise<unknown> {
  return requestJson("create_brand_from_url", `/v1/brands`, "POST", params, { url });
}

/** GET /v1/brands — list every brand in the caller's org. */
export function listBrands(params: FunnelCallParams): Promise<unknown> {
  return requestJson("list_brands", `/v1/brands`, "GET", params);
}

// --- Campaign launch / stop / list -----------------------------------------

export interface LaunchCampaignBody {
  name: string;
  brandUrls: string[];
  featureInputs: Record<string, unknown>;
  featureSlug?: string;
  featureDynastySlug?: string;
  workflowSlug?: string;
  workflowDynastySlug?: string;
  maxBudgetDailyUsd?: string | number;
  maxBudgetWeeklyUsd?: string | number;
  maxBudgetMonthlyUsd?: string | number;
  maxBudgetTotalUsd?: string | number;
  maxLeads?: number;
  endDate?: string;
}

/** POST /v1/campaigns — launch a campaign for one or more brand URLs. */
export function launchCampaign(
  body: LaunchCampaignBody,
  params: FunnelCallParams,
): Promise<unknown> {
  return requestJson("launch_campaign", `/v1/campaigns`, "POST", params, body);
}

export interface ListCampaignsFilters {
  brandId?: string;
  status?: string;
}

/** GET /v1/campaigns — list the org's campaigns, optionally by brand / status. */
export function listCampaigns(
  filters: ListCampaignsFilters,
  params: FunnelCallParams,
): Promise<unknown> {
  const qs = new URLSearchParams();
  if (filters.brandId) qs.set("brandId", filters.brandId);
  if (filters.status) qs.set("status", filters.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return requestJson("list_campaigns", `/v1/campaigns${suffix}`, "GET", params);
}

/** POST /v1/campaigns/{id}/stop — stop a running campaign. */
export function stopCampaign(
  campaignId: string,
  params: FunnelCallParams,
): Promise<unknown> {
  return requestJson(
    "stop_campaign",
    `/v1/campaigns/${encodeURIComponent(campaignId)}/stop`,
    "POST",
    params,
  );
}

// --- Brand daily budget -----------------------------------------------------

/** GET /v1/brands/{brandId}/daily-budget — current daily spend ceiling (cents; null = unset). */
export function getBrandDailyBudget(
  brandId: string,
  params: FunnelCallParams,
): Promise<unknown> {
  return requestJson(
    "get_daily_budget",
    `/v1/brands/${encodeURIComponent(brandId)}/daily-budget`,
    "GET",
    params,
  );
}

/** PATCH /v1/brands/{brandId}/daily-budget { dailyBudgetCents } — set the daily spend ceiling. */
export function setBrandDailyBudget(
  brandId: string,
  dailyBudgetCents: number | string,
  params: FunnelCallParams,
): Promise<unknown> {
  return requestJson(
    "set_daily_budget",
    `/v1/brands/${encodeURIComponent(brandId)}/daily-budget`,
    "PATCH",
    params,
    { dailyBudgetCents },
  );
}

// --- Brand pause / resume ---------------------------------------------------

/** GET /v1/brands/{brandId}/pause — current pause state for the brand. */
export function getBrandPauseState(
  brandId: string,
  params: FunnelCallParams,
): Promise<unknown> {
  return requestJson(
    "get_brand_pause",
    `/v1/brands/${encodeURIComponent(brandId)}/pause`,
    "GET",
    params,
  );
}

/** PATCH /v1/brands/{brandId}/pause { paused } — pause (true) or resume (false) a brand. */
export function setBrandPauseState(
  brandId: string,
  paused: boolean,
  params: FunnelCallParams,
): Promise<unknown> {
  return requestJson(
    "set_brand_pause",
    `/v1/brands/${encodeURIComponent(brandId)}/pause`,
    "PATCH",
    params,
    { paused },
  );
}
