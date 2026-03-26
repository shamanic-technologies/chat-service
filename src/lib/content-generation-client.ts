import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

export interface PromptTemplate {
  id: string;
  type: string;
  prompt: string;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

export type ContentGenerationCallParams = ApiCallParams;

export async function getPromptTemplate(
  type: string,
  params: ContentGenerationCallParams,
): Promise<PromptTemplate> {
  const res = await apiServiceFetch(
    `/v1/prompts?type=${encodeURIComponent(type)}`,
    "GET",
    params,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[content-generation-client] GET /v1/prompts?type=${type} returned ${res.status}: ${text}`,
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
  const res = await apiServiceFetch("/v1/prompts", "PUT", params, body);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[content-generation-client] PUT /v1/prompts returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as PromptTemplate;
}
