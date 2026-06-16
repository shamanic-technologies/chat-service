import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

// ---------------------------------------------------------------------------
// Client for a brand's customer personas + brand profile, via api-service.
//
// All client-facing backend calls route through api-service as the single
// gateway (same pattern as brand-client.ts). The downstream brand-service owns
// the persona/brand-profile data model:
//   - personas are IMMUTABLE except for their lifecycle status (active/paused/
//     archived); "editing" a persona means creating a new one. Names are UNIQUE
//     PER BRAND (case-insensitive, across all statuses) → create returns 409.
//   - brand-profile is versioned + immutable: each save is a NEW version; prior
//     versions are never mutated.
// ---------------------------------------------------------------------------

export type BrandContentCallParams = ApiCallParams;

export class BrandContentError extends Error {
  constructor(
    public readonly status: number,
    public readonly upstreamBody: string,
    public readonly operation: string,
  ) {
    super(`[brand-content-client] ${operation} failed (${status}): ${upstreamBody}`);
    this.name = "BrandContentError";
  }
}

async function failLoud(res: Response, operation: string): Promise<never> {
  const text = await res.text().catch(() => "unknown error");
  throw new BrandContentError(res.status, text, operation);
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export type PersonaStatus = "active" | "paused" | "archived";

export interface Persona {
  id: string;
  brandId: string;
  name: string;
  filters: Record<string, string[]>;
  status: PersonaStatus;
  createdAt: string;
}

/** GET /v1/brands/:id/personas — read-only list, optional status filter. */
export async function listPersonas(
  brandId: string,
  status: PersonaStatus | undefined,
  params: BrandContentCallParams,
): Promise<{ personas: Persona[] }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await apiServiceFetch(
    `/v1/brands/${brandId}/personas${qs}`,
    "GET",
    params,
  );
  if (!res.ok) return failLoud(res, "list personas");
  return res.json() as Promise<{ personas: Persona[] }>;
}

export type CreatePersonaResult =
  | { created: true; persona: Persona }
  | { created: false; reason: "name_taken"; name: string };

/**
 * POST /v1/brands/:id/personas — create an immutable persona.
 * A 409 name clash is an EXPECTED business outcome (names are unique per brand,
 * case-insensitive) → returned as a structured result the model relays to the
 * user, NOT thrown. Every other non-2xx still fails loud.
 */
export async function createPersona(
  brandId: string,
  name: string,
  filters: Record<string, string[]>,
  params: BrandContentCallParams,
): Promise<CreatePersonaResult> {
  const res = await apiServiceFetch(
    `/v1/brands/${brandId}/personas`,
    "POST",
    params,
    { name, filters },
  );
  if (res.status === 409) return { created: false, reason: "name_taken", name };
  if (!res.ok) return failLoud(res, "create persona");
  const body = (await res.json()) as { persona: Persona };
  return { created: true, persona: body.persona };
}

/**
 * POST /v1/brands/:id/personas/:personaId/duplicate — copy filters into a new
 * persona. `name` is optional; brand-service auto-uniquifies, so this never 409s.
 */
export async function duplicatePersona(
  brandId: string,
  personaId: string,
  name: string | undefined,
  params: BrandContentCallParams,
): Promise<{ persona: Persona }> {
  const res = await apiServiceFetch(
    `/v1/brands/${brandId}/personas/${personaId}/duplicate`,
    "POST",
    params,
    name ? { name } : {},
  );
  if (!res.ok) return failLoud(res, "duplicate persona");
  return res.json() as Promise<{ persona: Persona }>;
}

/**
 * PATCH /v1/brands/:id/personas/:personaId/status — flip lifecycle status
 * (the ONLY mutable field). Archiving never deletes; there is no hard delete.
 */
export async function setPersonaStatus(
  brandId: string,
  personaId: string,
  status: PersonaStatus,
  params: BrandContentCallParams,
): Promise<{ persona: Persona }> {
  const res = await apiServiceFetch(
    `/v1/brands/${brandId}/personas/${personaId}/status`,
    "PATCH",
    params,
    { status },
  );
  if (!res.ok) return failLoud(res, "set persona status");
  return res.json() as Promise<{ persona: Persona }>;
}

/** Build brand-service's `filters` map from the LLM's array-of-pairs shape. */
export function buildPersonaFilters(
  pairs: Array<{ attribute: string; values: string[] }> | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!Array.isArray(pairs)) return out;
  for (const pair of pairs) {
    if (!pair || typeof pair.attribute !== "string") continue;
    const values = Array.isArray(pair.values)
      ? pair.values.filter((v): v is string => typeof v === "string")
      : [];
    // Last write wins per attribute; merge if the model repeats an attribute.
    out[pair.attribute] = out[pair.attribute]
      ? [...out[pair.attribute], ...values]
      : values;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Brand profile (versioned, immutable)
// ---------------------------------------------------------------------------

export type BrandProfileFieldValue = string | string[];
export type BrandProfileFields = Record<string, BrandProfileFieldValue>;

export interface BrandProfileVersion {
  id: string;
  brandId: string;
  version: number;
  fields: BrandProfileFields;
  createdAt: string;
}

export interface BrandProfileVersionRef {
  id: string;
  version: number;
  createdAt: string;
}

export interface BrandProfileResponse {
  current: BrandProfileVersion | null;
  versions: BrandProfileVersionRef[];
}

/** GET /v1/brands/:id/brand-profile — current version + version list. */
export async function getBrandProfile(
  brandId: string,
  params: BrandContentCallParams,
): Promise<BrandProfileResponse> {
  const res = await apiServiceFetch(
    `/v1/brands/${brandId}/brand-profile`,
    "GET",
    params,
  );
  if (!res.ok) return failLoud(res, "get brand profile");
  return res.json() as Promise<BrandProfileResponse>;
}

/** POST /v1/brands/:id/brand-profile — save a new immutable version. */
export async function saveBrandProfileVersion(
  brandId: string,
  fields: BrandProfileFields,
  params: BrandContentCallParams,
): Promise<{ version: BrandProfileVersion }> {
  const res = await apiServiceFetch(
    `/v1/brands/${brandId}/brand-profile`,
    "POST",
    params,
    { fields },
  );
  if (!res.ok) return failLoud(res, "save brand profile");
  return res.json() as Promise<{ version: BrandProfileVersion }>;
}

export interface BrandProfileChange {
  field: string;
  operation: "set" | "setList" | "add" | "remove";
  value?: string;
  values?: string[];
}

/**
 * Apply a list of changes on top of the current fields and return the FULL
 * merged map (so unchanged fields are preserved when the new version is saved —
 * brand-service replaces the whole map per version, so a partial map would drop
 * fields). Pure function — does not mutate the input.
 *   - set:     replace a free-text field with `value`
 *   - setList: replace a list field with `values`
 *   - add:     append `value` to a list field (coerces a scalar to a list; dedups)
 *   - remove:  delete `value` from a list field
 */
export function applyBrandProfileChanges(
  current: BrandProfileFields,
  changes: BrandProfileChange[],
): BrandProfileFields {
  const merged: BrandProfileFields = { ...current };
  for (const change of changes) {
    const { field, operation } = change;
    if (operation === "set") {
      merged[field] = change.value ?? "";
    } else if (operation === "setList") {
      merged[field] = Array.isArray(change.values) ? [...change.values] : [];
    } else if (operation === "add") {
      if (change.value === undefined) continue;
      const existing = merged[field];
      const list = Array.isArray(existing)
        ? [...existing]
        : existing
          ? [existing]
          : [];
      if (!list.includes(change.value)) list.push(change.value);
      merged[field] = list;
    } else if (operation === "remove") {
      if (change.value === undefined) continue;
      const existing = merged[field];
      const list = Array.isArray(existing)
        ? existing
        : existing
          ? [existing]
          : [];
      merged[field] = list.filter((v) => v !== change.value);
    }
  }
  return merged;
}
