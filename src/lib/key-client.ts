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

