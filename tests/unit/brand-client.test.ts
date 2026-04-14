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
  it("sends brandIds in request body alongside fields", async () => {
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
      ["brand-123"],
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
          brandIds: ["brand-123"],
          fields: [{ key: "industry", description: "The brand's primary industry" }],
        }),
      }),
    );

    expect(result.brandId).toBe("brand-123");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].key).toBe("industry");
    expect(result.results[0].value).toBe("SaaS");
  });

  it("sends multiple brandIds in body", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ brandId: "b-1", results: [] }),
    });

    const { extractBrandFields } = await loadModule();
    await extractBrandFields(
      [{ key: "x", description: "y" }],
      ["b-1", "b-2", "b-3"],
      baseParams,
    );

    const sentBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sentBody.brandIds).toEqual(["b-1", "b-2", "b-3"]);
    expect(sentBody.fields).toEqual([{ key: "x", description: "y" }]);
  });

  it("throws on non-OK response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Brand not found"),
    });

    const { extractBrandFields } = await loadModule();

    await expect(
      extractBrandFields([{ key: "x", description: "y" }], ["brand-1"], baseParams),
    ).rejects.toThrow("[brand-client] extract-fields failed (404)");
  });

  it("forwards tracking headers including multi-brand CSV x-brand-id", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ brandId: "b-1", results: [] }),
    });

    const { extractBrandFields } = await loadModule();
    await extractBrandFields(
      [{ key: "x", description: "y" }],
      ["b-1", "b-2", "b-3"],
      {
        ...baseParams,
        trackingHeaders: { "x-campaign-id": "camp-1", "x-brand-id": "b-1,b-2,b-3" },
      },
    );

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

