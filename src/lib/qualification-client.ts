import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

// ---------------------------------------------------------------------------
// Client for an offer's qualification checks, via api-service.
//
// lead-service owns the checks; api-service proxies them untransformed under
// /v1/brands/{brandId}/offers/{offerId}/qualification/* and /v1/qualification/catalog.
// A check is a yes/no question about a prospect's company, answered from a
// "source" (a built-in probe). Each has a MODE the customer sees as a ROLE:
//   must_pass → "Hard filter" (a company that fails is skipped)
//   mention   → "Bonus"       (evidence handed to the writer, nobody dropped)
// and an on/off switch. A check's question is immutable on purpose: it may
// already have run, so a reword is archive + create, never an edit. This client
// deliberately exposes NO question-edit call.
//
// Results are reshaped into a compact customer-language view (role, on, cost per
// lead, pass rate) so the chat model reasons in the words the customer sees and
// never echoes lead-service's internal mode/probe vocabulary.
// ---------------------------------------------------------------------------

export type QualificationCallParams = ApiCallParams;

export class QualificationError extends Error {
  constructor(
    public readonly status: number,
    public readonly upstreamBody: string,
    public readonly operation: string,
  ) {
    super(`[qualification-client] ${operation} failed (${status}): ${upstreamBody}`);
    this.name = "QualificationError";
  }
}

async function failLoud(res: Response, operation: string): Promise<never> {
  const text = await res.text().catch(() => "unknown error");
  throw new QualificationError(res.status, text, operation);
}

export type CheckRole = "hard_filter" | "bonus";
type CriterionMode = "must_pass" | "mention";

export const CHECK_SOURCES = [
  "company_data",
  "homepage_text",
  "homepage_screenshot",
  "job_postings",
  "linkedin_company_posts",
] as const;
export type CheckSource = (typeof CHECK_SOURCES)[number];

const ROLE_TO_MODE: Record<CheckRole, CriterionMode> = {
  hard_filter: "must_pass",
  bonus: "mention",
};

const MODE_TO_ROLE_LABEL: Record<CriterionMode, "Hard filter" | "Bonus"> = {
  must_pass: "Hard filter",
  mention: "Bonus",
};

/** A criterion as served by lead-service (only the fields this client reads). */
export interface Criterion {
  id: string;
  question: string;
  why: string | null;
  mode: CriterionMode;
  enabled: boolean;
  origin: "suggested" | "custom";
  source: string;
  estimate: { perRowUsd: number };
  passRate: {
    checked: number;
    yes: number;
    no: number;
    unavailable: number;
    passRate: number | null;
  };
}

/** The customer-language view handed to the chat model. */
export interface CheckView {
  checkId: string;
  question: string;
  why: string | null;
  role: "Hard filter" | "Bonus";
  on: boolean;
  suggestedByAi: boolean;
  source: string;
  costPerLeadUsd: number;
  passRate: number | null;
  companiesChecked: number;
}

export function toCheckView(c: Criterion): CheckView {
  const role = MODE_TO_ROLE_LABEL[c.mode];
  if (!role) {
    throw new Error(`[qualification-client] unknown criterion mode "${c.mode}"`);
  }
  return {
    checkId: c.id,
    question: c.question,
    why: c.why,
    role,
    on: c.enabled,
    suggestedByAi: c.origin === "suggested",
    source: c.source,
    costPerLeadUsd: c.estimate.perRowUsd,
    passRate: c.passRate.passRate,
    companiesChecked: c.passRate.checked,
  };
}

function basePath(brandId: string, offerId: string): string {
  return `/v1/brands/${encodeURIComponent(brandId)}/offers/${encodeURIComponent(offerId)}/qualification`;
}

/** GET .../qualification/criteria — every live check of the offer (no spend). */
export async function listChecks(
  brandId: string,
  offerId: string,
  params: QualificationCallParams,
): Promise<{ checks: CheckView[] }> {
  const res = await apiServiceFetch(`${basePath(brandId, offerId)}/criteria`, "GET", params);
  if (!res.ok) return failLoud(res, "list qualification checks");
  const body = (await res.json()) as { criteria: Criterion[] };
  return { checks: body.criteria.map(toCheckView) };
}

/** GET /v1/qualification/catalog — the sources a check can read, with cost per lead. */
export async function listCheckSources(
  params: QualificationCallParams,
): Promise<{
  sources: Array<{ source: CheckSource; label: string; description: string; costPerLeadUsd: number }>;
}> {
  const res = await apiServiceFetch(`/v1/qualification/catalog`, "GET", params);
  if (!res.ok) return failLoud(res, "list qualification sources");
  const body = (await res.json()) as {
    probes: Array<{
      key: CheckSource;
      source: string;
      description: string;
      estimate: { perRowUsd: number };
    }>;
  };
  return {
    sources: body.probes.map((p) => ({
      source: p.key,
      label: p.source,
      description: p.description,
      costPerLeadUsd: p.estimate.perRowUsd,
    })),
  };
}

/**
 * POST .../qualification/suggestions — AI suggestions (SPENDS, org-billed by
 * lead-service). Every suggestion is written turned OFF.
 */
export async function suggestChecks(
  brandId: string,
  offerId: string,
  params: QualificationCallParams,
): Promise<{ checks: CheckView[]; skipped: Array<{ question: string; reason: string }> }> {
  const res = await apiServiceFetch(`${basePath(brandId, offerId)}/suggestions`, "POST", params, {});
  if (!res.ok) return failLoud(res, "suggest qualification checks");
  const body = (await res.json()) as {
    criteria: Criterion[];
    dropped: Array<{ question: string; reason: string }>;
  };
  return { checks: body.criteria.map(toCheckView), skipped: body.dropped };
}

/** POST .../qualification/criteria — create a check from the customer's wording. */
export async function createCheck(
  brandId: string,
  offerId: string,
  input: { question: string; source: CheckSource; role: CheckRole; on: boolean },
  params: QualificationCallParams,
): Promise<{ check: CheckView }> {
  const mode = ROLE_TO_MODE[input.role];
  if (!mode) throw new Error(`[qualification-client] unknown role "${input.role}"`);
  if (!CHECK_SOURCES.includes(input.source)) {
    throw new Error(`[qualification-client] unknown source "${input.source}"`);
  }
  const res = await apiServiceFetch(`${basePath(brandId, offerId)}/criteria`, "POST", params, {
    question: input.question,
    probe: { builtin: input.source },
    mode,
    enabled: input.on,
  });
  if (!res.ok) return failLoud(res, "create qualification check");
  const body = (await res.json()) as { criterion: Criterion };
  return { check: toCheckView(body.criterion) };
}

/** PATCH .../criteria/{id} — turn on/off and/or switch role. Never the question. */
export async function updateCheck(
  brandId: string,
  offerId: string,
  checkId: string,
  change: { on?: boolean; role?: CheckRole },
  params: QualificationCallParams,
): Promise<{ check: CheckView }> {
  const body: { enabled?: boolean; mode?: CriterionMode } = {};
  if (change.on !== undefined) body.enabled = change.on;
  if (change.role !== undefined) {
    const mode = ROLE_TO_MODE[change.role];
    if (!mode) throw new Error(`[qualification-client] unknown role "${change.role}"`);
    body.mode = mode;
  }
  if (body.enabled === undefined && body.mode === undefined) {
    throw new Error("[qualification-client] update needs `on` or `role`");
  }
  const res = await apiServiceFetch(
    `${basePath(brandId, offerId)}/criteria/${encodeURIComponent(checkId)}`,
    "PATCH",
    params,
    body,
  );
  if (!res.ok) return failLoud(res, "update qualification check");
  const out = (await res.json()) as { criterion: Criterion };
  return { check: toCheckView(out.criterion) };
}

/** DELETE .../criteria/{id} — archive (gone from the list, past answers kept). */
export async function archiveCheck(
  brandId: string,
  offerId: string,
  checkId: string,
  params: QualificationCallParams,
): Promise<{ archived: true; checkId: string }> {
  const res = await apiServiceFetch(
    `${basePath(brandId, offerId)}/criteria/${encodeURIComponent(checkId)}`,
    "DELETE",
    params,
  );
  if (!res.ok) return failLoud(res, "archive qualification check");
  return { archived: true, checkId };
}

// ---------------------------------------------------------------------------
// Per-turn dedupe key for the qualification MUTATIONS.
//
// Measured in prod (v0.63.11, session f7d05287): asked to reword one check,
// Gemini put archive + create TWICE in the same reply (same args, different key
// order) and the duplicate create wrote a second identical check. A prompt rule
// did not stop it, so /chat runs an identical mutation at most once per turn. The
// repeat gets REPEATED_QUALIFICATION_MUTATION_RESULT, not the first result: given
// the first result again, the model confirmed the same change twice. Reads are free and never deduped.
// Scope: these four tools only (other editors were not measured here).
// ---------------------------------------------------------------------------

export const REPEATED_QUALIFICATION_MUTATION_RESULT = {
  skipped: true,
  note: "Duplicate call skipped: this exact change already succeeded earlier in this turn. Do not call it again. If you already confirmed it to the user, write nothing more about it.",
} as const;

const QUALIFICATION_MUTATIONS = new Set([
  "suggest_qualification_checks",
  "create_qualification_check",
  "update_qualification_check",
  "archive_qualification_check",
]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Key identifying a qualification mutation by tool + args (key order ignored); null for any other tool. */
export function qualificationMutationKey(
  name: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!QUALIFICATION_MUTATIONS.has(name)) return null;
  return `${name}:${JSON.stringify(canonical(args ?? {}))}`;
}
