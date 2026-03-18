const API_REGISTRY_SERVICE_URL =
  process.env.API_REGISTRY_SERVICE_URL || "https://api-registry.distribute.you";
const API_REGISTRY_SERVICE_API_KEY = process.env.API_REGISTRY_SERVICE_API_KEY;

export interface ApiRegistryCallParams {
  orgId: string;
  userId: string;
  runId: string;
}

export interface EndpointSummary {
  method: string;
  path: string;
  summary: string;
  params?: Array<{ name: string; in: string; required: boolean; type?: string }>;
  bodyFields?: string[];
}

export interface ServiceSummary {
  service: string;
  baseUrl: string;
  title?: string;
  description?: string;
  error?: string;
  endpoints: EndpointSummary[];
}

export interface LlmContextResponse {
  _description: string;
  _usage: string;
  services: ServiceSummary[];
}

export async function listAvailableServices(
  params: ApiRegistryCallParams,
): Promise<LlmContextResponse> {
  if (!API_REGISTRY_SERVICE_API_KEY) {
    throw new Error(
      "[api-registry-client] API_REGISTRY_SERVICE_API_KEY is required",
    );
  }

  const url = `${API_REGISTRY_SERVICE_URL}/llm-context`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": API_REGISTRY_SERVICE_API_KEY,
      "x-org-id": params.orgId,
      "x-user-id": params.userId,
      "x-run-id": params.runId,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[api-registry-client] GET /llm-context returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as LlmContextResponse;
}
