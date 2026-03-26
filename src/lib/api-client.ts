const API_SERVICE_URL =
  process.env.API_SERVICE_URL || "https://api.distribute.you";
const ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY;

export interface ApiCallParams {
  orgId: string;
  userId: string;
  runId: string;
  trackingHeaders?: Record<string, string>;
}

/**
 * Make an authenticated request to api-service.
 * All client-facing backend calls route through api-service as the single gateway.
 */
export function apiServiceFetch(
  path: string,
  method: string,
  params: ApiCallParams,
  body?: unknown,
): Promise<Response> {
  if (!ADMIN_DISTRIBUTE_API_KEY) {
    throw new Error("[api-client] ADMIN_DISTRIBUTE_API_KEY is required");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ADMIN_DISTRIBUTE_API_KEY}`,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
  };
  if (params.trackingHeaders) {
    for (const [k, v] of Object.entries(params.trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }

  return fetch(`${API_SERVICE_URL}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
