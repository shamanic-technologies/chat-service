import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

export type ScrapingCallParams = ApiCallParams;

// ---------------------------------------------------------------------------
// POST /v1/scraping/scrape  (via api-service proxy to scraping-service)
// ---------------------------------------------------------------------------

export interface ScrapeResult {
  url: string;
  description: string | null;
  rawMarkdown: string | null;
}

export async function scrapeUrl(
  url: string,
  params: ScrapingCallParams,
): Promise<ScrapeResult> {
  const res = await apiServiceFetch(
    `/v1/scraping/scrape`,
    "POST",
    params,
    {
      url,
      provider: "firecrawl",
      options: {
        formats: ["markdown"],
        onlyMainContent: true,
      },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error");
    throw new Error(`[scraping-client] scrape failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    result: {
      url: string;
      description: string | null;
      rawMarkdown: string | null;
    };
  };

  return {
    url: data.result.url,
    description: data.result.description,
    rawMarkdown: data.result.rawMarkdown,
  };
}
