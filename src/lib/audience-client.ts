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
  /** Served by human-service beside the fields above; read by `toAudienceRows`. */
  offerId?: string | null;
  targetText?: string | null;
  channels?: Array<{ channel: string }> | null;
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

// ---------------------------------------------------------------------------
// What the chat model reads from list_audiences: one short row per audience,
// a page at a time. The full rows (filters, nlPrompt, targetText) weigh ~4 KB
// EACH: 26 audiences returned 111 KB (~30k tokens) per call and a Copilot turn
// read it twice (prod 2026-10-12). Owner rule: no tool result above ~2k tokens.
// ---------------------------------------------------------------------------

export const AUDIENCE_PAGE_SIZE = 15;
const TARGET_CHARS = 120;

export interface AudienceRow {
  id: string;
  name: string;
  status: AudienceStatus;
  offerId: string | null;
  size: number | null;
  channels: string[];
  /** Who it targets, cut to one line (targetText, else the nlPrompt). */
  target: string | null;
}

function oneLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TARGET_CHARS ? `${flat.slice(0, TARGET_CHARS)}…` : flat;
}

export function toAudienceRows(
  audiences: Audience[],
  offset: number,
): { total: number; offset: number; audiences: AudienceRow[]; nextOffset: number | null } {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`[audience-client] offset must be a whole number >= 0, got ${offset}`);
  }
  const page = audiences.slice(offset, offset + AUDIENCE_PAGE_SIZE);
  const next = offset + page.length;
  return {
    total: audiences.length,
    offset,
    audiences: page.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      offerId: a.offerId ?? null,
      size: a.apolloCount ?? a.apifyCount ?? null,
      channels: [...new Set((a.channels ?? []).map((c) => c.channel))],
      target: oneLine(a.targetText ?? a.nlPrompt),
    })),
    nextOffset: next < audiences.length ? next : null,
  };
}

/**
 * POST /v1/orgs/audiences/suggest — natural-language prompt -> candidate
 * audiences. Each candidate is PERSISTED at status `suggested`; the caller
 * activates a chosen one via setAudienceStatus(..., "active").
 *
 * `offerId` scopes the persisted candidates to one offer of the brand, so an
 * offer-scoped page (which lists only its own offer's audiences) can see them.
 * Omitted ⟹ brand-wide, byte-identical to the pre-offer body. Never guessed:
 * it comes only from the chat request `context.offerId` the dashboard sends
 * when the customer is on an offer-scoped page.
 */
export async function suggestAudiences(
  brandId: string,
  nlPrompt: string,
  params: AudienceCallParams,
  offerId?: string,
): Promise<{ candidates: AudienceCandidate[] }> {
  const res = await apiServiceFetch(
    `/v1/orgs/audiences/suggest`,
    "POST",
    params,
    offerId ? { brandId, nlPrompt, offerId } : { brandId, nlPrompt },
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
