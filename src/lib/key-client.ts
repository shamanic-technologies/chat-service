import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

// ---------------------------------------------------------------------------
// resolveKey — stays direct to key-service (infrastructure, not client-facing)
// ---------------------------------------------------------------------------

const KEY_SERVICE_URL =
  process.env.KEY_SERVICE_URL || "https://key.mcpfactory.org";
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;

const CALLER_SERVICE = "chat";

export interface CallerInfo {
  method: string;
  path: string;
}

export interface TrackingHeaders {
  "x-campaign-id"?: string;
  "x-brand-id"?: string;
  "x-workflow-slug"?: string;
  "x-feature-slug"?: string;
}

export interface KeyResolutionParams {
  provider: string;
  orgId: string;
  userId: string;
  runId: string;
  caller: CallerInfo;
  trackingHeaders?: TrackingHeaders;
}

export interface ResolvedKey {
  provider: string;
  key: string;
  keySource: "org" | "platform";
}

/**
 * key-service holds no key for this provider (its 404), as opposed to a failed
 * read. `scope` says whose key is missing: `org` only when key-service names the
 * org's own key; else the platform key (no platform row, or a provider nobody
 * registered a key for yet).
 */
export class KeyNotConfiguredError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly scope: "org" | "platform",
  ) {
    super(message);
    this.name = "KeyNotConfiguredError";
  }
}

function keyNotConfigured(provider: string, path: string, text: string, scope: "org" | "platform"): KeyNotConfiguredError {
  return new KeyNotConfiguredError(`[key-client] GET ${path} returned 404: ${text}`, provider, scope);
}

export async function resolveKey(
  params: KeyResolutionParams,
): Promise<ResolvedKey> {
  if (!KEY_SERVICE_API_KEY) {
    throw new Error(
      "[key-client] KEY_SERVICE_API_KEY is required to resolve keys",
    );
  }

  const { provider, orgId, userId, runId, caller, trackingHeaders } = params;
  const url = `${KEY_SERVICE_URL}/keys/${encodeURIComponent(provider)}/decrypt`;

  const headers: Record<string, string> = {
    "x-api-key": KEY_SERVICE_API_KEY,
    "x-org-id": orgId,
    "x-user-id": userId,
    "x-run-id": runId,
    "X-Caller-Service": CALLER_SERVICE,
    "X-Caller-Method": caller.method,
    "X-Caller-Path": caller.path,
  };
  if (trackingHeaders) {
    for (const [k, v] of Object.entries(trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }

  const res = await fetch(url, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 404) {
      throw keyNotConfigured(provider, `/keys/${provider}/decrypt`, text, /org key configured/i.test(text) ? "org" : "platform");
    }
    throw new Error(
      `[key-client] GET /keys/${provider}/decrypt returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as ResolvedKey;
}

// ---------------------------------------------------------------------------
// resolvePlatformKey — direct platform-key lookup (no org/user context needed)
// ---------------------------------------------------------------------------

export interface PlatformResolvedKey {
  provider: string;
  key: string;
}

export async function resolvePlatformKey(
  provider: string,
  caller: CallerInfo,
): Promise<PlatformResolvedKey> {
  if (!KEY_SERVICE_API_KEY) {
    throw new Error(
      "[key-client] KEY_SERVICE_API_KEY is required to resolve keys",
    );
  }

  const url = `${KEY_SERVICE_URL}/keys/platform/${encodeURIComponent(provider)}/decrypt`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": KEY_SERVICE_API_KEY,
      "X-Caller-Service": CALLER_SERVICE,
      "X-Caller-Method": caller.method,
      "X-Caller-Path": caller.path,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 404) throw keyNotConfigured(provider, `/keys/platform/${provider}/decrypt`, text, "platform");
    throw new Error(
      `[key-client] GET /keys/platform/${provider}/decrypt returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as PlatformResolvedKey;
}

/**
 * The providers that have a platform key, read from key-service's own list
 * (`GET /platform-keys`: provider names + masked keys; no key is decrypted or
 * kept here). Throws on any failed read: the caller keeps what it knew.
 */
export async function listPlatformKeyProviders(): Promise<string[]> {
  if (!KEY_SERVICE_API_KEY) {
    throw new Error("[key-client] KEY_SERVICE_API_KEY is required to list platform keys");
  }
  const res = await fetch(`${KEY_SERVICE_URL}/platform-keys`, {
    method: "GET",
    headers: { "x-api-key": KEY_SERVICE_API_KEY, "X-Caller-Service": CALLER_SERVICE },
  });
  if (!res.ok) throw new Error(`[key-client] GET /platform-keys returned ${res.status}`);
  const body = (await res.json()) as { keys?: Array<{ provider?: unknown }> };
  if (!Array.isArray(body.keys)) throw new Error("[key-client] GET /platform-keys: no `keys` array");
  return body.keys.map((k) => k.provider).filter((p): p is string => typeof p === "string");
}

// ---------------------------------------------------------------------------
// Read-only key tools (exposed to LLM) — routed via api-service
// ---------------------------------------------------------------------------

export interface KeyCallParams {
  orgId: string;
  userId: string;
  runId: string;
  trackingHeaders?: Record<string, string>;
}

export interface OrgKey {
  provider: string;
  maskedKey: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export async function listOrgKeys(
  params: KeyCallParams,
): Promise<{ keys: OrgKey[] }> {
  const res = await apiServiceFetch("/v1/keys", "GET", params);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[key-client] GET /v1/keys returned ${res.status}: ${text}`);
  }
  return (await res.json()) as { keys: OrgKey[] };
}

export interface KeySourcePreference {
  provider: string;
  orgId: string;
  keySource: "org" | "platform";
  isDefault: boolean;
}

export async function getKeySource(
  provider: string,
  params: KeyCallParams,
): Promise<KeySourcePreference> {
  const res = await apiServiceFetch(
    `/v1/keys/${encodeURIComponent(provider)}/source`,
    "GET",
    params,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[key-client] GET /v1/keys/${provider}/source returned ${res.status}: ${text}`,
    );
  }
  return (await res.json()) as KeySourcePreference;
}

export async function listKeySources(
  params: KeyCallParams,
): Promise<{ sources: Array<{ provider: string; keySource: "org" | "platform" }> }> {
  const res = await apiServiceFetch("/v1/keys/sources", "GET", params);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[key-client] GET /v1/keys/sources returned ${res.status}: ${text}`,
    );
  }
  return (await res.json()) as { sources: Array<{ provider: string; keySource: "org" | "platform" }> };
}

export interface ProviderRequirementsEndpoint {
  service: string;
  method: string;
  path: string;
}

export interface ProviderRequirementsResult {
  requirements: Array<{
    service: string;
    method: string;
    path: string;
    provider: string;
  }>;
  providers: string[];
}

export async function checkProviderRequirements(
  endpoints: ProviderRequirementsEndpoint[],
  params: KeyCallParams,
): Promise<ProviderRequirementsResult> {
  const res = await apiServiceFetch(
    "/v1/keys/provider-requirements",
    "POST",
    params,
    { endpoints },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[key-client] POST /v1/keys/provider-requirements returned ${res.status}: ${text}`,
    );
  }
  return (await res.json()) as ProviderRequirementsResult;
}
