import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

export type BrandCallParams = ApiCallParams;

// ---------------------------------------------------------------------------
// POST /brands/extract-fields  (reads x-brand-id from forwarded headers)
// ---------------------------------------------------------------------------

export interface ExtractFieldDef {
  key: string;
  description: string;
}

export interface ExtractFieldResult {
  key: string;
  value: unknown;
  cached: boolean;
  extractedAt: string;
  expiresAt: string | null;
  sourceUrls: string[] | null;
}

export interface ExtractFieldsResponse {
  brandId: string;
  results: ExtractFieldResult[];
}

export async function extractBrandFields(
  fields: ExtractFieldDef[],
  params: BrandCallParams,
): Promise<ExtractFieldsResponse> {
  const res = await apiServiceFetch(
    `/v1/brands/extract-fields`,
    "POST",
    params,
    { fields },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error");
    throw new Error(`[brand-client] extract-fields failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<ExtractFieldsResponse>;
}

// ---------------------------------------------------------------------------
// GET /public-information-map + POST /public-information-content
// Used by extract_brand_text to get the full text of a brand's website.
// ---------------------------------------------------------------------------

interface PublicInfoMapEntry {
  url: string;
  source_type: string;
  description?: string;
}

export async function getPublicInformationMap(
  brandId: string,
  params: BrandCallParams,
): Promise<PublicInfoMapEntry[]> {
  const res = await apiServiceFetch(
    `/v1/brands/${encodeURIComponent(brandId)}/public-information-map`,
    "GET",
    params,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error");
    throw new Error(`[brand-client] public-information-map failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { urls?: PublicInfoMapEntry[] } | PublicInfoMapEntry[];
  return Array.isArray(data) ? data : (data.urls ?? []);
}

interface PublicInfoContentEntry {
  url: string;
  content: string;
  source_type: string;
}

export async function getPublicInformationContent(
  brandId: string,
  selectedUrls: Array<{ url: string; source_type: string }>,
  params: BrandCallParams,
): Promise<PublicInfoContentEntry[]> {
  const res = await apiServiceFetch(
    `/v1/brands/${encodeURIComponent(brandId)}/public-information-content`,
    "POST",
    params,
    { selected_urls: selectedUrls },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error");
    throw new Error(`[brand-client] public-information-content failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { contents?: PublicInfoContentEntry[] } | PublicInfoContentEntry[];
  return Array.isArray(data) ? data : (data.contents ?? []);
}

/**
 * High-level: get the full text of a brand's public pages.
 * Fetches the URL map, then fetches content for all scraped pages.
 */
export async function extractBrandText(
  brandId: string,
  params: BrandCallParams,
): Promise<{ brandId: string; pages: Array<{ url: string; content: string }> }> {
  const urlMap = await getPublicInformationMap(brandId, params);

  // Filter to scraped pages only (skip LinkedIn posts, etc.)
  const scrapedPages = urlMap.filter((entry) => entry.source_type === "scraped_page");

  if (scrapedPages.length === 0) {
    return { brandId, pages: [] };
  }

  const contents = await getPublicInformationContent(
    brandId,
    scrapedPages.map((entry) => ({ url: entry.url, source_type: entry.source_type })),
    params,
  );

  return {
    brandId,
    pages: contents.map((c) => ({ url: c.url, content: c.content })),
  };
}
