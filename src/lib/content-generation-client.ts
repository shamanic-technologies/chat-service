const CONTENT_GENERATION_SERVICE_URL =
  process.env.CONTENT_GENERATION_SERVICE_URL || "https://content-generation.distribute.you";
const CONTENT_GENERATION_SERVICE_API_KEY = process.env.CONTENT_GENERATION_SERVICE_API_KEY;

export interface PromptTemplate {
  id: string;
  type: string;
  prompt: string;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ContentGenerationCallParams {
  orgId: string;
  userId: string;
  runId: string;
  trackingHeaders?: Record<string, string>;
}

export async function getPromptTemplate(
  type: string,
  params: ContentGenerationCallParams,
): Promise<PromptTemplate> {
  if (!CONTENT_GENERATION_SERVICE_API_KEY) {
    throw new Error(
      "[content-generation-client] CONTENT_GENERATION_SERVICE_API_KEY is required",
    );
  }

  const url = `${CONTENT_GENERATION_SERVICE_URL}/prompts?type=${encodeURIComponent(type)}`;
  const headers: Record<string, string> = {
    "x-api-key": CONTENT_GENERATION_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
  };
  if (params.trackingHeaders) {
    for (const [k, v] of Object.entries(params.trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }

  const res = await fetch(url, { method: "GET", headers });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[content-generation-client] GET /prompts?type=${type} returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as PromptTemplate;
}

export interface UpdatePromptBody {
  sourceType: string;
  prompt: string;
  variables: string[];
}

export async function updatePromptTemplate(
  body: UpdatePromptBody,
  params: ContentGenerationCallParams,
): Promise<PromptTemplate> {
  if (!CONTENT_GENERATION_SERVICE_API_KEY) {
    throw new Error(
      "[content-generation-client] CONTENT_GENERATION_SERVICE_API_KEY is required",
    );
  }

  const url = `${CONTENT_GENERATION_SERVICE_URL}/prompts`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": CONTENT_GENERATION_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
  };
  if (params.trackingHeaders) {
    for (const [k, v] of Object.entries(params.trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }

  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[content-generation-client] PUT /prompts returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as PromptTemplate;
}
