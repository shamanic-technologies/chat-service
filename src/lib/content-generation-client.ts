import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

/**
 * A template variable as declared by content-generation-service.
 * The deployed `PUT/GET /prompts` contract requires `{ name, description }`
 * objects (not bare strings) — the caller decides the JSON shape per name.
 * See DIS-138 / DIS-52.
 */
export interface PromptVariable {
  name: string;
  description: string;
}

export interface PromptTemplate {
  id: string;
  type: string;
  prompt: string;
  variables: PromptVariable[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The prompt routes are STAFF ONLY at the gateway (api-service `requireStaff`:
 * platform key + `x-email` in its staff allowlist). `staffEmail` is the
 * requester's email, resolved server-side from the gateway's `x-user-id`
 * (see staff-only-tools.ts); it is required so no caller can reach these
 * routes without saying who the staff member is.
 */
export interface ContentGenerationCallParams extends ApiCallParams {
  staffEmail: string;
}

function withStaffEmail(params: ContentGenerationCallParams): ApiCallParams {
  const { staffEmail, ...rest } = params;
  if (!staffEmail) throw new Error("[content-generation-client] staffEmail is required (staff-only route)");
  return { ...rest, trackingHeaders: { ...(rest.trackingHeaders ?? {}), "x-email": staffEmail } };
}

export async function getPromptTemplate(
  type: string,
  params: ContentGenerationCallParams,
): Promise<PromptTemplate> {
  const res = await apiServiceFetch(
    `/v1/prompts?type=${encodeURIComponent(type)}`,
    "GET",
    withStaffEmail(params),
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
  variables: PromptVariable[];
}

export async function updatePromptTemplate(
  body: UpdatePromptBody,
  params: ContentGenerationCallParams,
): Promise<PromptTemplate> {
  const res = await apiServiceFetch("/v1/prompts", "PUT", withStaffEmail(params), body);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[content-generation-client] PUT /v1/prompts returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as PromptTemplate;
}
