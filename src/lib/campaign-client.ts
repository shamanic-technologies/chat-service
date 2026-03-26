import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

export interface CampaignFeatureInputs {
  [key: string]: unknown;
}

interface CampaignResponse {
  campaign: {
    id: string;
    featureInputs: CampaignFeatureInputs | null;
  };
}

// In-memory cache: featureInputs never change during a campaign's lifetime
const featureInputsCache = new Map<string, CampaignFeatureInputs | null>();

/**
 * Fetch the featureInputs for a campaign. Results are cached by campaignId
 * because featureInputs are immutable for the lifetime of a campaign.
 *
 * Returns null if the campaign has no featureInputs.
 * Throws on network/server errors.
 */
export async function getCampaignFeatureInputs(
  campaignId: string,
  params: ApiCallParams,
): Promise<CampaignFeatureInputs | null> {
  const cached = featureInputsCache.get(campaignId);
  if (cached !== undefined) return cached;

  const res = await apiServiceFetch(
    `/v1/campaigns/${campaignId}`,
    "GET",
    params,
  );

  if (!res.ok) {
    // Non-fatal: log and return null so the LLM call can proceed without context
    console.warn(
      `[campaign-client] Failed to fetch campaign "${campaignId}": ${res.status} ${res.statusText}`,
    );
    return null;
  }

  const data = (await res.json()) as CampaignResponse;
  const featureInputs = data.campaign.featureInputs ?? null;

  featureInputsCache.set(campaignId, featureInputs);
  return featureInputs;
}

/** Clear the cache (for testing). */
export function clearCampaignCache(): void {
  featureInputsCache.clear();
}
