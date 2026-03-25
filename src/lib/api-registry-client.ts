const API_REGISTRY_SERVICE_URL =
  process.env.API_REGISTRY_SERVICE_URL || "https://api-registry.distribute.you";
const API_REGISTRY_SERVICE_API_KEY = process.env.API_REGISTRY_SERVICE_API_KEY;

export interface ApiRegistryCallParams {
  orgId: string;
  userId: string;
  runId: string;
}

// ---------------------------------------------------------------------------
// Progressive disclosure: list_services → list_service_endpoints → call_api
// ---------------------------------------------------------------------------

function ensureApiKey(): string {
  if (!API_REGISTRY_SERVICE_API_KEY) {
    throw new Error(
      "[api-registry-client] API_REGISTRY_SERVICE_API_KEY is required",
    );
  }
  return API_REGISTRY_SERVICE_API_KEY;
}

function baseHeaders(params: ApiRegistryCallParams): Record<string, string> {
  return {
    "x-api-key": ensureApiKey(),
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
  };
}

/** Step 1: Lightweight overview — service names, descriptions, endpoint counts. */
export interface ServiceOverview {
  service: string;
  title?: string;
  description?: string;
  endpointCount: number;
}

export interface ListServicesResponse {
  _description: string;
  _workflow: string;
  serviceCount: number;
  services: ServiceOverview[];
}

export async function listServices(
  params: ApiRegistryCallParams,
): Promise<ListServicesResponse> {
  const res = await fetch(`${API_REGISTRY_SERVICE_URL}/llm-context`, {
    headers: baseHeaders(params),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[api-registry-client] GET /llm-context returned ${res.status}: ${text}`,
    );
  }
  return (await res.json()) as ListServicesResponse;
}

/** Step 2: Endpoints for a single service (method, path, summary). */
export interface EndpointSummary {
  method: string;
  path: string;
  summary: string;
}

export interface ListServiceEndpointsResponse {
  service: string;
  title?: string;
  description?: string;
  endpointCount: number;
  endpoints: EndpointSummary[];
}

export async function listServiceEndpoints(
  service: string,
  params: ApiRegistryCallParams,
): Promise<ListServiceEndpointsResponse> {
  const res = await fetch(
    `${API_REGISTRY_SERVICE_URL}/llm-context/${encodeURIComponent(service)}`,
    { headers: baseHeaders(params) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[api-registry-client] GET /llm-context/${service} returned ${res.status}: ${text}`,
    );
  }
  return (await res.json()) as ListServiceEndpointsResponse;
}

/** Step 3: Proxy an API call to a registered service (api-registry injects API key). */
export interface CallApiParams {
  service: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}

export interface CallApiResponse {
  status: number;
  ok: boolean;
  data: unknown;
}

export async function callApi(
  callParams: CallApiParams,
  identityParams: ApiRegistryCallParams,
): Promise<CallApiResponse> {
  const res = await fetch(
    `${API_REGISTRY_SERVICE_URL}/call/${encodeURIComponent(callParams.service)}`,
    {
      method: "POST",
      headers: {
        ...baseHeaders(identityParams),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: callParams.method,
        path: callParams.path,
        ...(callParams.body ? { body: callParams.body } : {}),
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[api-registry-client] POST /call/${callParams.service} returned ${res.status}: ${text}`,
    );
  }
  return (await res.json()) as CallApiResponse;
}
