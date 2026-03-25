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
  "x-workflow-name"?: string;
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
    throw new Error(
      `[key-client] GET /keys/${provider}/decrypt returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as ResolvedKey;
}

// ---------------------------------------------------------------------------
// Read-only key-service tools (exposed to LLM)
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
  if (!KEY_SERVICE_API_KEY) {
    throw new Error("[key-client] KEY_SERVICE_API_KEY is required");
  }

  const headers: Record<string, string> = {
    "x-api-key": KEY_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
  };
  if (params.trackingHeaders) {
    for (const [k, v] of Object.entries(params.trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }

  const res = await fetch(`${KEY_SERVICE_URL}/keys`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[key-client] GET /keys returned ${res.status}: ${text}`);
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
  if (!KEY_SERVICE_API_KEY) {
    throw new Error("[key-client] KEY_SERVICE_API_KEY is required");
  }

  const headers: Record<string, string> = {
    "x-api-key": KEY_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
  };
  if (params.trackingHeaders) {
    for (const [k, v] of Object.entries(params.trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }

  const res = await fetch(
    `${KEY_SERVICE_URL}/keys/${encodeURIComponent(provider)}/source`,
    { headers },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[key-client] GET /keys/${provider}/source returned ${res.status}: ${text}`,
    );
  }
  return (await res.json()) as KeySourcePreference;
}

export async function listKeySources(
  params: KeyCallParams,
): Promise<{ sources: Array<{ provider: string; keySource: "org" | "platform" }> }> {
  if (!KEY_SERVICE_API_KEY) {
    throw new Error("[key-client] KEY_SERVICE_API_KEY is required");
  }

  const headers: Record<string, string> = {
    "x-api-key": KEY_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
  };
  if (params.trackingHeaders) {
    for (const [k, v] of Object.entries(params.trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }

  const res = await fetch(`${KEY_SERVICE_URL}/keys/sources`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[key-client] GET /keys/sources returned ${res.status}: ${text}`,
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
  if (!KEY_SERVICE_API_KEY) {
    throw new Error("[key-client] KEY_SERVICE_API_KEY is required");
  }

  const headers: Record<string, string> = {
    "x-api-key": KEY_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
    "content-type": "application/json",
  };
  if (params.trackingHeaders) {
    for (const [k, v] of Object.entries(params.trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }

  const res = await fetch(`${KEY_SERVICE_URL}/provider-requirements`, {
    method: "POST",
    headers,
    body: JSON.stringify({ endpoints }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[key-client] POST /provider-requirements returned ${res.status}: ${text}`,
    );
  }
  return (await res.json()) as ProviderRequirementsResult;
}

