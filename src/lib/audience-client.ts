import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

// ---------------------------------------------------------------------------
// Client for a brand's customer audiences, via api-service.
//
// All client-facing backend calls route through api-service as the single
// gateway (same pattern as brand-content-client.ts). The downstream owner is
// human-service; api-service proxies /v1/orgs/audiences/* untransformed.
//
// An audience is a SAVED filter-set (+ optional provider count snapshot) scoped
// to one brand inside the caller's org. The org is derived from the forwarded
// identity headers (x-org-id) — never a body/query param — so every call acts
// on the caller's org only. Lifecycle status is the only freely-mutable field
// besides name; filters are immutable after creation.
//
// Creation flow is suggest -> activate, NOT a raw create: POST /suggest emits
// LLM-generated candidates, each PERSISTED as an inactive `suggested` row; the
// caller activates a chosen one via PATCH /:id/status { status: "active" }.
// ---------------------------------------------------------------------------

export type AudienceCallParams = ApiCallParams;

export class AudienceError extends Error {
  constructor(
    public readonly status: number,
    public readonly upstreamBody: string,
    public readonly operation: string,
  ) {
    super(`[audience-client] ${operation} failed (${status}): ${upstreamBody}`);
    this.name = "AudienceError";
  }
}

async function failLoud(res: Response, operation: string): Promise<never> {
  const text = await res.text().catch(() => "unknown error");
  throw new AudienceError(res.status, text, operation);
}

export type AudienceStatus = "suggested" | "active" | "paused" | "archived";
export type AudienceProvider = "apollo" | "apify";

/** A saved audience (filter-set + count snapshot), as returned by human-service. */
export interface Audience {
  id: string;
  orgId: string;
  brandId: string;
  name: string;
  nlPrompt: string | null;
  provider: AudienceProvider | null;
  status: AudienceStatus;
  source: string | null;
  filters: Record<string, unknown> | null;
  avatarUrl: string | null;
  apolloCount: number | null;
  apifyCount: number | null;
  countedAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One candidate from POST /suggest — already persisted as an inactive `suggested` row. */
export interface AudienceCandidate {
  audienceId: string;
  name: string;
  rationale: string;
  provider: AudienceProvider;
  filters: Record<string, unknown>;
  count: number;
  status: AudienceStatus;
  validationError: string | null;
  truncated: boolean;
}

/** GET /v1/orgs/audiences?brandId=&status= — list one brand's audiences. */
export async function listAudiences(
  brandId: string,
  status: AudienceStatus | undefined,
  params: AudienceCallParams,
): Promise<{ audiences: Audience[]; total: number }> {
  const qs = new URLSearchParams({ brandId });
  if (status) qs.set("status", status);
  const res = await apiServiceFetch(
    `/v1/orgs/audiences?${qs.toString()}`,
    "GET",
    params,
  );
  if (!res.ok) return failLoud(res, "list audiences");
  return res.json() as Promise<{ audiences: Audience[]; total: number }>;
}

/**
 * POST /v1/orgs/audiences/suggest — natural-language prompt -> candidate
 * audiences. Each candidate is PERSISTED at status `suggested`; the caller
 * activates a chosen one via setAudienceStatus(..., "active").
 */
export async function suggestAudiences(
  brandId: string,
  nlPrompt: string,
  params: AudienceCallParams,
): Promise<{ candidates: AudienceCandidate[] }> {
  const res = await apiServiceFetch(
    `/v1/orgs/audiences/suggest`,
    "POST",
    params,
    { brandId, nlPrompt },
  );
  if (!res.ok) return failLoud(res, "suggest audiences");
  return res.json() as Promise<{ candidates: AudienceCandidate[] }>;
}

/**
 * PATCH /v1/orgs/audiences/:id/status — flip lifecycle status. Activating a
 * `suggested` candidate (status: "active") is how a candidate becomes a real
 * audience. Archiving never deletes; an archived audience can be re-activated.
 */
export async function setAudienceStatus(
  audienceId: string,
  status: AudienceStatus,
  params: AudienceCallParams,
): Promise<{ audience: Audience }> {
  const res = await apiServiceFetch(
    `/v1/orgs/audiences/${audienceId}/status`,
    "PATCH",
    params,
    { status },
  );
  if (!res.ok) return failLoud(res, "set audience status");
  return res.json() as Promise<{ audience: Audience }>;
}

/**
 * PATCH /v1/orgs/audiences/:id — update metadata. Only `name` is mutable here
 * (filters/provider/counts are immutable; status has its own endpoint).
 */
export async function renameAudience(
  audienceId: string,
  name: string,
  params: AudienceCallParams,
): Promise<{ audience: Audience }> {
  const res = await apiServiceFetch(
    `/v1/orgs/audiences/${audienceId}`,
    "PATCH",
    params,
    { name },
  );
  if (!res.ok) return failLoud(res, "rename audience");
  return res.json() as Promise<{ audience: Audience }>;
}

/**
 * POST /v1/orgs/audiences/:id/refresh-count — re-snapshot apollo + apify match
 * counts via the free dry-run. Returns the updated audience.
 */
export async function refreshAudienceCount(
  audienceId: string,
  params: AudienceCallParams,
): Promise<{ audience: Audience }> {
  const res = await apiServiceFetch(
    `/v1/orgs/audiences/${audienceId}/refresh-count`,
    "POST",
    params,
  );
  if (!res.ok) return failLoud(res, "refresh audience count");
  return res.json() as Promise<{ audience: Audience }>;
}

/**
 * POST /v1/orgs/audiences/:id/avatar — (re)generate the audience's avatar
 * image. Optional `prompt` steers the image; omit it to derive the image from
 * the audience's descriptors. ORG-BILLED downstream (forwards x-user-id like
 * refreshAudienceCount). Returns the updated audience with its new avatarUrl.
 */
export async function generateAudienceAvatar(
  audienceId: string,
  prompt: string | undefined,
  params: AudienceCallParams,
): Promise<{ audience: Audience }> {
  const res = await apiServiceFetch(
    `/v1/orgs/audiences/${audienceId}/avatar`,
    "POST",
    params,
    prompt ? { prompt } : undefined,
  );
  if (!res.ok) return failLoud(res, "generate audience avatar");
  return res.json() as Promise<{ audience: Audience }>;
}
