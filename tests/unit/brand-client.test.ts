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
  return import("../../src/lib/brand-client.js");
}

const baseParams = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
};

describe("extractBrandFields", () => {
  it("calls POST /v1/brands/extract-fields via api-service (no brandId in path)", async () => {
    const mockResponse = {
      brandId: "brand-123",
      results: [
        { key: "industry", value: "SaaS", cached: false, extractedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-31T00:00:00Z", sourceUrls: ["https://example.com"] },
      ],
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { extractBrandFields } = await loadModule();
    const result = await extractBrandFields(
      [{ key: "industry", description: "The brand's primary industry" }],
      { ...baseParams, trackingHeaders: { "x-brand-id": "brand-123" } },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/brands/extract-fields",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
          "x-brand-id": "brand-123",
        }),
        body: JSON.stringify({
          fields: [{ key: "industry", description: "The brand's primary industry" }],
        }),
      }),
    );

    expect(result.brandId).toBe("brand-123");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].key).toBe("industry");
    expect(result.results[0].value).toBe("SaaS");
  });

  it("throws on non-OK response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Brand not found"),
    });

    const { extractBrandFields } = await loadModule();

    await expect(
      extractBrandFields([{ key: "x", description: "y" }], baseParams),
    ).rejects.toThrow("[brand-client] extract-fields failed (404)");
  });

  it("forwards tracking headers including multi-brand CSV x-brand-id", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ brandId: "b-1", results: [] }),
    });

    const { extractBrandFields } = await loadModule();
    await extractBrandFields([{ key: "x", description: "y" }], {
      ...baseParams,
      trackingHeaders: { "x-campaign-id": "camp-1", "x-brand-id": "b-1,b-2,b-3" },
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-campaign-id": "camp-1",
          "x-brand-id": "b-1,b-2,b-3",
        }),
      }),
    );
  });
});

describe("extractBrandText", () => {
  it("fetches URL map then content for scraped pages", async () => {
    const urlMap = [
      { url: "https://example.com/", source_type: "scraped_page", description: "Home" },
      { url: "https://example.com/about", source_type: "scraped_page", description: "About" },
      { url: "https://linkedin.com/post/123", source_type: "linkedin_post", description: "Post" },
    ];

    const contents = [
      { url: "https://example.com/", content: "Welcome to Example Inc.", source_type: "scraped_page" },
      { url: "https://example.com/about", content: "We are a SaaS company.", source_type: "scraped_page" },
    ];

    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(urlMap),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(contents),
      });

    const { extractBrandText } = await loadModule();
    const result = await extractBrandText("brand-123", baseParams);

    expect(result.brandId).toBe("brand-123");
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].url).toBe("https://example.com/");
    expect(result.pages[0].content).toBe("Welcome to Example Inc.");
    expect(result.pages[1].url).toBe("https://example.com/about");

    // First call: GET public-information-map
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/brands/brand-123/public-information-map",
      expect.objectContaining({ method: "GET" }),
    );

    // Second call: POST public-information-content — only scraped_page entries
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/brands/brand-123/public-information-content",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          selected_urls: [
            { url: "https://example.com/", source_type: "scraped_page" },
            { url: "https://example.com/about", source_type: "scraped_page" },
          ],
        }),
      }),
    );
  });

  it("returns empty pages when no scraped pages in URL map", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const { extractBrandText } = await loadModule();
    const result = await extractBrandText("brand-empty", baseParams);

    expect(result.brandId).toBe("brand-empty");
    expect(result.pages).toHaveLength(0);
    // Should NOT make a second fetch call
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("handles wrapped response format (object with urls/contents keys)", async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ urls: [{ url: "https://example.com/", source_type: "scraped_page" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contents: [{ url: "https://example.com/", content: "Hello", source_type: "scraped_page" }] }),
      });

    const { extractBrandText } = await loadModule();
    const result = await extractBrandText("brand-wrapped", baseParams);

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].content).toBe("Hello");
  });

  it("throws when URL map request fails", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal error"),
    });

    const { extractBrandText } = await loadModule();

    await expect(
      extractBrandText("brand-err", baseParams),
    ).rejects.toThrow("[brand-client] public-information-map failed (500)");
  });
});
