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
    throw new BrandError(res.status, text);
  }

  return res.json() as Promise<ExtractFieldsResponse>;
}
