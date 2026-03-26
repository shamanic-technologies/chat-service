const FEATURES_SERVICE_URL =
  process.env.FEATURES_SERVICE_URL || "https://features.distribute.you";
const FEATURES_SERVICE_API_KEY = process.env.FEATURES_SERVICE_API_KEY;

export interface FeaturesCallParams {
  orgId: string;
  userId: string;
  runId: string;
  trackingHeaders?: Record<string, string>;
}

function buildHeaders(params: FeaturesCallParams): Record<string, string> {
  if (!FEATURES_SERVICE_API_KEY) {
    throw new Error(
      "[features-client] FEATURES_SERVICE_API_KEY is required",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": FEATURES_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
  };
  if (params.trackingHeaders) {
    for (const [k, v] of Object.entries(params.trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }
  return headers;
}

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

/**
 * Create a new feature via POST /features.
 * Slug is optional — auto-generated from name if omitted.
 * Returns 201 on success, throws on 409 (conflict) or other errors.
 */
export async function createFeature(
  body: CreateFeatureBody,
  params: FeaturesCallParams,
): Promise<FeatureResponse> {
  const url = `${FEATURES_SERVICE_URL}/features`;
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(params),
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] Feature already exists (slug, name, or signature conflict): ${text}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] POST /features returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as FeatureResponse;
}

export interface UpdateFeatureResult {
  feature: FeatureResponse;
  /** true when inputs/outputs changed and features-service forked a new version (HTTP 201) */
  forked: boolean;
}

/**
 * Update or fork a feature via PUT /features/:slug.
 * If only metadata changes (same signature) → updates in-place (200).
 * If inputs or outputs change (different signature) → creates a fork,
 * deprecates the original, and returns 201. The fork inherits displayName.
 */
export async function updateFeature(
  slug: string,
  body: Partial<Omit<CreateFeatureBody, "slug">>,
  params: FeaturesCallParams,
): Promise<UpdateFeatureResult> {
  const url = `${FEATURES_SERVICE_URL}/features/${encodeURIComponent(slug)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: buildHeaders(params),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] PUT /features/${slug} returned ${res.status}: ${text}`,
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

/**
 * List features via GET /features with optional filters.
 */
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
  const url = `${FEATURES_SERVICE_URL}/features${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] GET /features returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as FeatureResponse[];
}

/**
 * Get a single feature by slug via GET /features/:slug.
 */
export async function getFeature(
  slug: string,
  params: FeaturesCallParams,
): Promise<FeatureResponse> {
  const url = `${FEATURES_SERVICE_URL}/features/${encodeURIComponent(slug)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] GET /features/${slug} returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as FeatureResponse;
}

export interface FeatureInputsResponse {
  slug: string;
  name: string;
  inputs: FeatureInputDef[];
}

/**
 * Get input definitions for a feature via GET /features/:slug/inputs.
 */
export async function getFeatureInputs(
  slug: string,
  params: FeaturesCallParams,
): Promise<FeatureInputsResponse> {
  const url = `${FEATURES_SERVICE_URL}/features/${encodeURIComponent(slug)}/inputs`;
  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] GET /features/${slug}/inputs returned ${res.status}: ${text}`,
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

/**
 * Pre-fill input values for a feature from brand data via POST /features/:slug/prefill.
 * Returns a map of input key → pre-filled text value (or null if extraction failed).
 */
export async function prefillFeature(
  slug: string,
  params: FeaturesCallParams,
): Promise<PrefillTextResponse> {
  const url = `${FEATURES_SERVICE_URL}/features/${encodeURIComponent(slug)}/prefill?format=text`;
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] POST /features/${slug}/prefill returned ${res.status}: ${text}`,
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

/**
 * Get computed stats for a feature via GET /features/:slug/stats.
 */
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
  const url = `${FEATURES_SERVICE_URL}/features/${encodeURIComponent(slug)}/stats${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] GET /features/${slug}/stats returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as FeatureStatsResponse;
}
