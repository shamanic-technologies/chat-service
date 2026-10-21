import { apiServiceFetch, type ApiCallParams } from "./api-client.js";
import { FunnelError } from "./funnel-client.js";

// ---------------------------------------------------------------------------
// People corrections (PEOPLE-CORRECTIONS-1017, owner 2026-10-17).
//
// distribute.you groups everyone a brand deals with into ONE person per real
// human, tags how each one speaks (personal to the user / personal not to the
// user / professional about the brand / professional about something else) and
// attaches the companies they speak for. crm-service owns the people, the
// corrections and the stated merges; these tools read and state them through
// the api-service gateway with the chat's own identity, nothing else.
//
// A REFUSAL (crm-service `{ type: "refused", reason, error }`, 404 / 409 / 422)
// is an answer, not a crash: it comes back as `{ refused: true, reason, error }`
// so the model tells the user why in plain words. Any other failure throws.
// Results are projected: a people row is ~5 KB verbatim (presences, evidence).
// ---------------------------------------------------------------------------

export const CONNECTION_TAGS = [
  "personal_to_user",
  "personal_not_to_user",
  "professional_to_brand",
  "professional_not_to_brand",
] as const;
export type ConnectionTag = (typeof CONNECTION_TAGS)[number];

export const CORRECTION_KINDS = [
  "tag_add",
  "tag_remove",
  "organization_add",
  "organization_remove",
  "domain_kind",
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export const DOMAIN_KINDS = ["mailbox_provider", "organization"] as const;

const FIND_PEOPLE_MAX = 10;
const ORGANIZATIONS_MAX = 25;
const STATEMENTS_MAX = 20;

export interface Refused {
  refused: true;
  status: number;
  reason: string;
  error: string;
}

function requireId(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[people-client] ${name} is required`);
  }
  return value.trim();
}

function optionalText(name: string, value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`[people-client] ${name} must be a string`);
  const v = value.trim();
  if (v.length > max) throw new Error(`[people-client] ${name} is longer than ${max} characters`);
  return v || undefined;
}

function boundedInt(name: string, value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`[people-client] ${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function oneOf<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`[people-client] ${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/** A crm-service refusal body, else null. */
function refusalOf(status: number, raw: string): Refused | null {
  if (status !== 404 && status !== 409 && status !== 422) return null;
  try {
    const body = JSON.parse(raw) as { type?: unknown; reason?: unknown; error?: unknown };
    if (body && body.type === "refused" && typeof body.reason === "string") {
      return { refused: true, status, reason: body.reason, error: typeof body.error === "string" ? body.error : body.reason };
    }
  } catch {
    // not a refusal body
  }
  return null;
}

async function call(
  operation: string,
  path: string,
  method: "GET" | "POST",
  params: ApiCallParams,
  body?: unknown,
): Promise<{ ok: true; data: Record<string, unknown> } | Refused> {
  const res = await apiServiceFetch(path, method, params, body);
  const raw = await res.text();
  if (!res.ok) {
    const refused = refusalOf(res.status, raw);
    if (refused) return refused;
    throw new FunnelError(operation, res.status, raw || "unknown error");
  }
  return { ok: true, data: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
}

const enc = encodeURIComponent;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** One people row, cut to what a correction needs. */
export function toPersonRow(p: unknown) {
  const r = rec(p);
  return {
    personId: r.personId ?? null,
    name: r.displayName ?? null,
    company: r.company ?? null,
    emails: arr(r.emails).slice(0, 3),
    phones: arr(r.phones).slice(0, 2),
    channels: [...new Set(arr(r.sources).map((s) => (typeof s === "string" ? s : rec(s).source)).filter(Boolean))],
    tags: arr(r.connectionTags).map((t) => rec(t).tag),
    organizations: arr(r.organizations).map((o) => ({
      companyId: rec(o).companyId,
      domain: rec(o).domain,
      tags: arr(rec(o).tags).map((t) => rec(t).tag),
    })),
    lastActivityAt: r.lastActivityAt ?? null,
  };
}

/** GET /v1/orgs/people?brandId=&q=&limit= : who the user is talking about. */
export async function findPeople(
  args: { brandId: unknown; query?: unknown; limit?: unknown; offset?: unknown },
  params: ApiCallParams,
) {
  const brandId = requireId("brandId", args.brandId);
  const q = optionalText("query", args.query, 200);
  const limit = boundedInt("limit", args.limit, 5, 1, FIND_PEOPLE_MAX);
  const offset = boundedInt("offset", args.offset, 0, 0, 100_000);
  const qs = new URLSearchParams({ brandId, limit: String(limit), offset: String(offset) });
  if (q) qs.set("q", q);
  const out = await call("find_people", `/v1/orgs/people?${qs}`, "GET", params);
  if ("refused" in out) return out;
  const d = out.data;
  return {
    total: d.total ?? null,
    nextOffset: d.nextOffset ?? null,
    building: rec(d.scope).status === "building" ? true : undefined,
    people: arr(d.people).map(toPersonRow),
  };
}

/** GET /v1/orgs/people/organizations : the companies the brand's people speak for. */
export async function listPeopleOrganizations(
  args: { brandId: unknown; limit?: unknown; offset?: unknown },
  params: ApiCallParams,
) {
  const brandId = requireId("brandId", args.brandId);
  const limit = boundedInt("limit", args.limit, 15, 1, ORGANIZATIONS_MAX);
  const offset = boundedInt("offset", args.offset, 0, 0, 100_000);
  const qs = new URLSearchParams({ brandId, limit: String(limit), offset: String(offset) });
  const out = await call("list_people_organizations", `/v1/orgs/people/organizations?${qs}`, "GET", params);
  if ("refused" in out) return out;
  const d = out.data;
  return {
    total: d.total ?? null,
    organizations: arr(d.organizations).map((o) => {
      const r = rec(o);
      return { companyId: r.companyId, domains: arr(r.domains).slice(0, 5), people: r.people, tags: r.tags };
    }),
  };
}

function correctionRow(c: unknown) {
  const r = rec(c);
  return {
    correctionId: r.correctionId,
    kind: r.kind,
    personId: r.personId ?? null,
    target: r.target ?? null,
    reason: r.reason ?? null,
    createdAt: r.createdAt ?? null,
    undone: r.undoneAt != null,
  };
}

function mergeRow(m: unknown) {
  const r = rec(m);
  return {
    mergeId: r.mergeId,
    personIds: r.personIds ?? null,
    reason: r.reason ?? null,
    statedAt: r.statedAt ?? null,
    undone: r.undoneAt != null || r.active === false,
    applied: r.applied ?? null,
    personId: r.personId ?? null,
  };
}

/**
 * POST /v1/orgs/people/corrections. The body carries only the fields the kind
 * uses; a missing one is refused here, before any call, in the tool's words.
 */
export async function correctPerson(
  args: {
    brandId: unknown;
    kind: unknown;
    personId?: unknown;
    tag?: unknown;
    domain?: unknown;
    companyId?: unknown;
    domainKind?: unknown;
    tags?: unknown;
    reason?: unknown;
  },
  params: ApiCallParams,
) {
  const brandId = requireId("brandId", args.brandId);
  const kind = oneOf("kind", args.kind, CORRECTION_KINDS);
  const reason = optionalText("reason", args.reason, 2000);
  const body: Record<string, unknown> = { brandId, kind };
  if (kind === "tag_add" || kind === "tag_remove") {
    body.personId = requireId("personId", args.personId);
    body.tag = oneOf("tag", args.tag, CONNECTION_TAGS);
  } else if (kind === "organization_add") {
    body.personId = requireId("personId", args.personId);
    body.domain = requireId("domain", args.domain);
    if (args.tags !== undefined && args.tags !== null) {
      if (!Array.isArray(args.tags)) throw new Error("[people-client] tags must be a list");
      body.tags = args.tags.map((t) => oneOf("tags[]", t, CONNECTION_TAGS));
    }
  } else if (kind === "organization_remove") {
    body.personId = requireId("personId", args.personId);
    body.companyId = requireId("companyId", args.companyId);
  } else {
    body.domain = requireId("domain", args.domain);
    body.domainKind = oneOf("domainKind", args.domainKind, DOMAIN_KINDS);
  }
  if (reason) body.reason = reason;
  const out = await call("correct_person", "/v1/orgs/people/corrections", "POST", params, body);
  if ("refused" in out) return out;
  return {
    correction: correctionRow(out.data.correction),
    duplicate: out.data.duplicate ?? false,
    rebuild: out.data.rebuild ?? null,
  };
}

/** GET corrections + GET merges: every statement the brand made on its people, newest first. */
export async function listPeopleCorrections(
  args: { brandId: unknown; includeUndone?: unknown },
  params: ApiCallParams,
) {
  const brandId = requireId("brandId", args.brandId);
  const includeUndone = args.includeUndone === true;
  const qs = `brandId=${enc(brandId)}`;
  const [corr, merges] = await Promise.all([
    call("list_people_corrections", `/v1/orgs/people/corrections?${qs}`, "GET", params),
    call("list_people_corrections", `/v1/orgs/people/merges?${qs}`, "GET", params),
  ]);
  if ("refused" in corr) return corr;
  if ("refused" in merges) return merges;
  const c = arr(corr.data.corrections).map(correctionRow).filter((r) => includeUndone || !r.undone);
  const m = arr(merges.data.merges).map(mergeRow).filter((r) => includeUndone || !r.undone);
  return {
    corrections: c.slice(0, STATEMENTS_MAX),
    correctionsTotal: c.length,
    merges: m.slice(0, STATEMENTS_MAX),
    mergesTotal: m.length,
  };
}

/** POST /v1/orgs/people/corrections/{correctionId}/undo */
export async function undoPeopleCorrection(
  args: { brandId: unknown; correctionId: unknown },
  params: ApiCallParams,
) {
  const brandId = requireId("brandId", args.brandId);
  const id = requireId("correctionId", args.correctionId);
  const out = await call("undo_people_correction", `/v1/orgs/people/corrections/${enc(id)}/undo`, "POST", params, { brandId });
  if ("refused" in out) return out;
  return { correction: correctionRow(out.data.correction), duplicate: out.data.duplicate ?? false, rebuild: out.data.rebuild ?? null };
}

/** POST /v1/orgs/people/merges : two people are one human. */
export async function mergePeople(
  args: { brandId: unknown; personIds: unknown; reason?: unknown },
  params: ApiCallParams,
) {
  const brandId = requireId("brandId", args.brandId);
  if (!Array.isArray(args.personIds) || args.personIds.length !== 2) {
    throw new Error("[people-client] personIds must be exactly two person ids");
  }
  const personIds = args.personIds.map((p, i) => requireId(`personIds[${i}]`, p));
  const reason = optionalText("reason", args.reason, 1000);
  const out = await call("merge_people", "/v1/orgs/people/merges", "POST", params, {
    brandId,
    personIds,
    ...(reason ? { reason } : {}),
  });
  if ("refused" in out) return out;
  return {
    merge: mergeRow(out.data.merge),
    duplicate: out.data.duplicate ?? false,
    personId: out.data.personId ?? null,
    rebuild: out.data.rebuild ?? null,
  };
}

/** POST /v1/orgs/people/merges/{mergeId}/undo */
export async function undoPeopleMerge(args: { brandId: unknown; mergeId: unknown }, params: ApiCallParams) {
  const brandId = requireId("brandId", args.brandId);
  const id = requireId("mergeId", args.mergeId);
  const out = await call("undo_people_merge", `/v1/orgs/people/merges/${enc(id)}/undo`, "POST", params, { brandId });
  if ("refused" in out) return out;
  return { merge: mergeRow(out.data.merge), duplicate: out.data.duplicate ?? false, rebuild: out.data.rebuild ?? null };
}

// ---------------------------------------------------------------------------
// Add ONE person the client wants to reach (COPILOT-ADD-CONTACT-1021).
// crm-service stores them in the brand's own contacts ("Contacts added one by
// one"); nothing is looked up or paid at add time. A campaign on the CRM
// contacts source reaches them later, and an unknown email is found then,
// billed to that campaign. The note keeps what the client said about them.
// ---------------------------------------------------------------------------

const CONTACT_TEXT_FIELDS = [
  ["email", 320],
  ["phone", 40],
  ["firstName", 200],
  ["lastName", 200],
  ["fullName", 400],
  ["companyName", 300],
  ["companyDomain", 300],
  ["jobTitle", 300],
  ["linkedinUrl", 500],
  ["note", 5000],
] as const;

/** POST /v1/orgs/contacts : one person into the brand's contacts. */
export async function addContact(args: Record<string, unknown>, params: ApiCallParams) {
  const brandId = requireId("brandId", args.brandId);
  const body: Record<string, unknown> = { brandId };
  for (const [name, max] of CONTACT_TEXT_FIELDS) {
    const v = optionalText(name, args[name], max);
    if (v) body[name] = v;
  }
  const named = !!(body.fullName || body.firstName || body.lastName);
  if (!body.email && !body.linkedinUrl && !(named && (body.companyName || body.companyDomain))) {
    return {
      refused: true,
      status: 400,
      reason: "not_enough_to_find",
      error: "Need an email, a LinkedIn URL, or a name with a company: ask the user for one of them.",
    } satisfies Refused;
  }
  const res = await apiServiceFetch("/v1/orgs/contacts", "POST", params, body);
  const raw = await res.text();
  if (res.status === 400) {
    // crm-service's own validation (a LinkedIn URL that is not one, a bad domain): the user can fix it.
    const b = JSON.parse(raw) as { type?: unknown; error?: unknown };
    return { refused: true, status: 400, reason: String(b.type ?? "validation"), error: String(b.error ?? raw) } satisfies Refused;
  }
  if (!res.ok) {
    const refused = refusalOf(res.status, raw);
    if (refused) return refused;
    throw new FunnelError("add_contact", res.status, raw || "unknown error");
  }
  const d = JSON.parse(raw) as Record<string, unknown>;
  const c = rec(d.contact);
  return {
    contactId: d.contactId,
    added: d.created === true,
    // Already one of the brand's contacts (same email or LinkedIn): the details were added to it.
    alreadyThere: d.created === false ? { matchedOn: d.matchedOn ?? null } : undefined,
    name: c.fullName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null),
    company: c.companyName ?? c.companyDomain ?? null,
    // known = we have their email; unknown = found when a campaign reaches them; not_found = a lookup found none.
    emailStatus: d.emailStatus,
  };
}

/** Tool name -> handler, dispatched by the /chat handler (both agentic loops share executeTool). */
export const PEOPLE_TOOL_HANDLERS: Readonly<
  Record<string, (args: Record<string, unknown>, params: ApiCallParams) => Promise<unknown>>
> = {
  find_people: (a, p) => findPeople(a as Parameters<typeof findPeople>[0], p),
  list_people_organizations: (a, p) => listPeopleOrganizations(a as Parameters<typeof listPeopleOrganizations>[0], p),
  correct_person: (a, p) => correctPerson(a as Parameters<typeof correctPerson>[0], p),
  list_people_corrections: (a, p) => listPeopleCorrections(a as Parameters<typeof listPeopleCorrections>[0], p),
  undo_people_correction: (a, p) => undoPeopleCorrection(a as Parameters<typeof undoPeopleCorrection>[0], p),
  merge_people: (a, p) => mergePeople(a as Parameters<typeof mergePeople>[0], p),
  undo_people_merge: (a, p) => undoPeopleMerge(a as Parameters<typeof undoPeopleMerge>[0], p),
  add_contact: (a, p) => addContact(a, p),
};
