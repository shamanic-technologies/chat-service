const API_REGISTRY_URL =
  process.env.API_REGISTRY_SERVICE_URL || "https://api-registry.distribute.you";
const API_REGISTRY_API_KEY = process.env.API_REGISTRY_SERVICE_API_KEY;

// ---------------------------------------------------------------------------
// Progressive disclosure: list_services → list_service_endpoints
// Called directly against api-registry (no api-service proxy).
// ---------------------------------------------------------------------------

function registryFetch(path: string): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (API_REGISTRY_API_KEY) {
    headers["X-API-Key"] = API_REGISTRY_API_KEY;
  }
  return fetch(`${API_REGISTRY_URL}${path}`, { method: "GET", headers });
}

/** Step 1: Lightweight overview — service names, descriptions, endpoint counts. */
export interface ServiceOverview {
  service: string;
  title?: string;
  description?: string;
  error?: string;
  endpointCount: number;
}

export interface ListServicesResponse {
  _description: string;
  _workflow: string;
  serviceCount: number;
  services: ServiceOverview[];
}

export async function listServices(): Promise<ListServicesResponse> {
  const res = await registryFetch("/llm-context");
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
  endpointCount?: number;
  endpoints?: EndpointSummary[];
  /** Present when the service has 30+ endpoints and results are grouped. */
  totalEndpoints?: number;
  groupCount?: number;
  groups?: {
    group: string;
    endpointCount: number;
    endpoints: EndpointSummary[];
  }[];
}

export async function listServiceEndpoints(
  service: string,
): Promise<ListServiceEndpointsResponse> {
  const res = await registryFetch(
    `/llm-context/${encodeURIComponent(service)}`,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[api-registry-client] GET /llm-context/${service} returned ${res.status}: ${text}`,
    );
  }
  return (await res.json()) as ListServiceEndpointsResponse;
}
