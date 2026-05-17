import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

export type BrandCallParams = ApiCallParams;

export class BrandError extends Error {
  constructor(
    public readonly status: number,
    public readonly upstreamBody: string,
  ) {
    super(`[brand-client] extract-fields failed (${status}): ${upstreamBody}`);
    this.name = "BrandError";
  }
}

// ---------------------------------------------------------------------------
// POST /v1/brands/extract-fields
// Body: { brandIds: string[] (non-empty), fields: [{key, description}] }
// Response: { brands: [...], fields: { [key]: { value, byBrand: { [domain]: {...} } } } }
// ---------------------------------------------------------------------------

export interface ExtractFieldDef {
  key: string;
  description: string;
}

export interface ExtractFieldByBrand {
  value: unknown;
  cached: boolean;
  extractedAt: string;
  expiresAt: string | null;
  sourceUrls: string[] | null;
}

export interface ExtractFieldEntry {
  value: unknown;
  byBrand: Record<string, ExtractFieldByBrand>;
}

export interface ExtractBrandMeta {
  brandId: string;
  domain: string;
  name: string;
  brandUrl: string | null;
}

export interface ExtractFieldsResponse {
  brands: ExtractBrandMeta[];
  fields: Record<string, ExtractFieldEntry>;
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
    throw new BrandError(res.status, text);
  }

  return res.json() as Promise<ExtractFieldsResponse>;
}
