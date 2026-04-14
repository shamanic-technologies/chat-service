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
  brandIds: string[],
  params: BrandCallParams,
): Promise<ExtractFieldsResponse> {
  const res = await apiServiceFetch(
    `/v1/brands/extract-fields`,
    "POST",
    params,
    { brandIds, fields },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error");
    throw new Error(`[brand-client] extract-fields failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<ExtractFieldsResponse>;
}
