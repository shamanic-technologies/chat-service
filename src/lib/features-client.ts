import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

export type FeaturesCallParams = ApiCallParams;

export interface FeatureInputDef {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select";
  placeholder: string;
  description: string;
  extractKey: string;
  options?: string[];
}

export interface FeatureOutputDef {
  key: string;
  displayOrder: number;
  defaultSort?: boolean;
  sortDirection?: "asc" | "desc";
}

export interface FunnelBarChart {
  key: string;
  type: "funnel-bar";
  title: string;
  displayOrder: number;
  steps: { key: string }[];
}

export interface BreakdownBarChart {
  key: string;
  type: "breakdown-bar";
  title: string;
  displayOrder: number;
  segments: { key: string; color: "green" | "blue" | "red" | "gray" | "orange"; sentiment: "positive" | "neutral" | "negative" }[];
}

export type FeatureChartDef = FunnelBarChart | BreakdownBarChart;

export interface CreateFeatureBody {
  slug?: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  channel: string;
  audienceType: string;
  implemented?: boolean;
  displayOrder?: number;
  status?: "active" | "draft" | "deprecated";
  inputs: FeatureInputDef[];
  outputs: FeatureOutputDef[];
  charts: FeatureChartDef[];
  entities: string[];
}

export interface FeatureResponse {
  id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  icon: string;
  category: string;
  channel: string;
  audienceType: string;
  implemented: boolean;
  displayOrder: number;
  status: "active" | "draft" | "deprecated";
  signature: string;
  inputs: FeatureInputDef[];
  outputs: FeatureOutputDef[];
  charts: FeatureChartDef[];
  entities: string[];
  [key: string]: unknown;
}

export async function createFeature(
  body: CreateFeatureBody,
  params: FeaturesCallParams,
): Promise<FeatureResponse> {
  const res = await apiServiceFetch("/v1/features", "POST", params, body);

  if (res.status === 409) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] Feature already exists (slug, name, or signature conflict): ${text}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] POST /v1/features returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as FeatureResponse;
}

export interface UpdateFeatureResult {
  feature: FeatureResponse;
  forked: boolean;
}

export async function updateFeature(
  slug: string,
  body: Partial<Omit<CreateFeatureBody, "slug">>,
  params: FeaturesCallParams,
): Promise<UpdateFeatureResult> {
  const res = await apiServiceFetch(
    `/v1/features/${encodeURIComponent(slug)}`,
    "PUT",
    params,
    body,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] PUT /v1/features/${slug} returned ${res.status}: ${text}`,
    );
  }

  const feature = (await res.json()) as FeatureResponse;
  return { feature, forked: res.status === 201 };
}

export interface ListFeaturesFilters {
  status?: string;
  category?: string;
  channel?: string;
  audienceType?: string;
  implemented?: string;
}

export async function listFeatures(
  filters: ListFeaturesFilters,
  params: FeaturesCallParams,
): Promise<FeatureResponse[]> {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.category) query.set("category", filters.category);
  if (filters.channel) query.set("channel", filters.channel);
  if (filters.audienceType) query.set("audienceType", filters.audienceType);
  if (filters.implemented) query.set("implemented", filters.implemented);

  const qs = query.toString();
  const res = await apiServiceFetch(
    `/v1/features${qs ? `?${qs}` : ""}`,
    "GET",
    params,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] GET /v1/features returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as FeatureResponse[];
}

export async function getFeature(
  slug: string,
  params: FeaturesCallParams,
): Promise<FeatureResponse> {
  const res = await apiServiceFetch(
    `/v1/features/${encodeURIComponent(slug)}`,
    "GET",
    params,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] GET /v1/features/${slug} returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as FeatureResponse;
}

export interface FeatureInputsResponse {
  slug: string;
  name: string;
  inputs: FeatureInputDef[];
}

export async function getFeatureInputs(
  slug: string,
  params: FeaturesCallParams,
): Promise<FeatureInputsResponse> {
  const res = await apiServiceFetch(
    `/v1/features/${encodeURIComponent(slug)}/inputs`,
    "GET",
    params,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] GET /v1/features/${slug}/inputs returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as FeatureInputsResponse;
}

export interface PrefillTextResponse {
  slug: string;
  brandId: string;
  format: "text";
  prefilled: Record<string, string | null>;
}

export async function prefillFeature(
  slug: string,
  params: FeaturesCallParams,
): Promise<PrefillTextResponse> {
  const res = await apiServiceFetch(
    `/v1/features/${encodeURIComponent(slug)}/prefill`,
    "POST",
    params,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] POST /v1/features/${slug}/prefill returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as PrefillTextResponse;
}

export interface FeatureStatsSystemStats {
  totalCostInUsdCents: number;
  completedRuns: number;
  activeCampaigns: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
}

export interface FeatureStatsResponse {
  featureSlug: string;
  groupBy?: string;
  systemStats: FeatureStatsSystemStats;
  stats?: Record<string, number | null>;
  groups?: Array<{
    workflowName?: string | null;
    brandId?: string | null;
    campaignId?: string | null;
    systemStats: FeatureStatsSystemStats;
    stats: Record<string, number | null>;
  }>;
}

export interface GetFeatureStatsFilters {
  groupBy?: "workflowName" | "brandId" | "campaignId";
  brandId?: string;
  campaignId?: string;
  workflowName?: string;
}

export async function getFeatureStats(
  slug: string,
  filters: GetFeatureStatsFilters,
  params: FeaturesCallParams,
): Promise<FeatureStatsResponse> {
  const query = new URLSearchParams();
  if (filters.groupBy) query.set("groupBy", filters.groupBy);
  if (filters.brandId) query.set("brandId", filters.brandId);
  if (filters.campaignId) query.set("campaignId", filters.campaignId);
  if (filters.workflowName) query.set("workflowName", filters.workflowName);

  const qs = query.toString();
  const res = await apiServiceFetch(
    `/v1/features/${encodeURIComponent(slug)}/stats${qs ? `?${qs}` : ""}`,
    "GET",
    params,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] GET /v1/features/${slug}/stats returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as FeatureStatsResponse;
}
