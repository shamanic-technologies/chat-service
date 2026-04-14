import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.ADMIN_DISTRIBUTE_API_KEY = "test-api-svc-key";
  process.env.API_SERVICE_URL = "https://api.test.local";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function loadModule() {
  vi.resetModules();
  return import("../../src/lib/scraping-client.js");
}

const baseParams = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
};

describe("scrapeUrl", () => {
  it("calls POST /v1/scraping/scrape with firecrawl provider and onlyMainContent", async () => {
    const mockResponse = {
      cached: false,
      provider: "firecrawl",
      result: {
        url: "https://example.com",
        description: "Example page",
        rawMarkdown: "# Hello World\nSome content here.",
      },
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { scrapeUrl } = await loadModule();
    const result = await scrapeUrl("https://example.com", baseParams);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/scraping/scrape",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
        body: JSON.stringify({
          url: "https://example.com",
          provider: "firecrawl",
          options: {
            formats: ["markdown"],
            onlyMainContent: true,
          },
        }),
      }),
    );

    expect(result).toEqual({
      url: "https://example.com",
      description: "Example page",
      rawMarkdown: "# Hello World\nSome content here.",
    });
  });

  it("returns only url, description, and rawMarkdown from the response", async () => {
    const mockResponse = {
      cached: true,
      provider: "firecrawl",
      requestId: "req-123",
      result: {
        id: "scrape-id-1",
        url: "https://example.com/page",
        companyName: "Example Corp",
        description: "A test page",
        industry: "Tech",
        rawMarkdown: "# Page Content",
        createdAt: "2026-01-01T00:00:00Z",
      },
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { scrapeUrl } = await loadModule();
    const result = await scrapeUrl("https://example.com/page", baseParams);

    // Should only include the three fields we care about
    expect(Object.keys(result)).toEqual(["url", "description", "rawMarkdown"]);
    expect(result.url).toBe("https://example.com/page");
    expect(result.description).toBe("A test page");
    expect(result.rawMarkdown).toBe("# Page Content");
  });

  it("throws on non-OK response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal error"),
    });

    const { scrapeUrl } = await loadModule();

    await expect(
      scrapeUrl("https://example.com", baseParams),
    ).rejects.toThrow("[scraping-client] scrape failed (500)");
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: { url: "https://example.com", description: null, rawMarkdown: null },
      }),
    });

    const { scrapeUrl } = await loadModule();
    await scrapeUrl("https://example.com", {
      ...baseParams,
      trackingHeaders: { "x-campaign-id": "camp-1", "x-brand-id": "b-1" },
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-campaign-id": "camp-1",
          "x-brand-id": "b-1",
        }),
      }),
    );
  });
});
