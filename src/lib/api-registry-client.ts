import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

export type ApiRegistryCallParams = ApiCallParams;

// ---------------------------------------------------------------------------
// Progressive disclosure: list_services → list_service_endpoints → call_api
// All routed through api-service gateway.
// ---------------------------------------------------------------------------

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
  const res = await apiServiceFetch("/v1/platform/llm-context", "GET", params);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[api-registry-client] GET /v1/platform/llm-context returned ${res.status}: ${text}`,
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
  const res = await apiServiceFetch(
    `/v1/platform/services/${encodeURIComponent(service)}`,
    "GET",
    params,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[api-registry-client] GET /v1/platform/services/${service} returned ${res.status}: ${text}`,
    );
  }
  return (await res.json()) as ListServiceEndpointsResponse;
}

/** Step 3: Call an api-service endpoint directly. */
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
  const res = await apiServiceFetch(
    callParams.path,
    callParams.method,
    identityParams,
    callParams.body,
  );

  const data = await res.json().catch(() => null);
  return {
    status: res.status,
    ok: res.ok,
    data,
  };
}
