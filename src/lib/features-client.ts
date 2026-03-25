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

export interface FeatureFieldDef {
  key: string;
  label: string;
  description: string;
}

export interface UpsertFeatureBody {
  slug: string;
  name: string;
  description: string;
  category: string;
  channel: string;
  audienceType: string;
  inputs: FeatureFieldDef[];
  outputs: FeatureFieldDef[];
}

export interface FeatureResponse {
  slug: string;
  name: string;
  description: string;
  category: string;
  channel: string;
  audienceType: string;
  inputs: FeatureFieldDef[];
  outputs: FeatureFieldDef[];
  [key: string]: unknown;
}

export async function upsertFeature(
  body: UpsertFeatureBody,
  params: FeaturesCallParams,
): Promise<FeatureResponse> {
  const url = `${FEATURES_SERVICE_URL}/features`;
  const res = await fetch(url, {
    method: "PUT",
    headers: buildHeaders(params),
    body: JSON.stringify({ features: [body] }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[features-client] PUT /features returned ${res.status}: ${text}`,
    );
  }

  const result = (await res.json()) as { features: FeatureResponse[] };
  return result.features[0];
}
