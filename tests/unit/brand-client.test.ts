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

function newShapeMockResponse(brandId: string, domain: string) {
  return {
    brands: [
      { brandId, domain, name: "Test Brand", brandUrl: `https://${domain}` },
    ],
    fields: {
      industry: {
        value: "SaaS",
        byBrand: {
          [domain]: {
            value: "SaaS",
            cached: false,
            extractedAt: "2026-01-01T00:00:00Z",
            expiresAt: "2026-01-31T00:00:00Z",
            sourceUrls: [`https://${domain}/about`],
          },
        },
      },
    },
  };
}

describe("extractBrandFields", () => {
  it("sends brandIds and fields in request body to POST /v1/brands/extract-fields", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(newShapeMockResponse("brand-123", "acme.com")),
    });

    const { extractBrandFields } = await loadModule();
    const result = await extractBrandFields(
      [{ key: "industry", description: "The brand's primary industry" }],
      ["brand-123"],
      baseParams,
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/brands/extract-fields",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
        body: JSON.stringify({
          brandIds: ["brand-123"],
          fields: [{ key: "industry", description: "The brand's primary industry" }],
        }),
      }),
    );

    expect(result.brands).toHaveLength(1);
    expect(result.brands[0].brandId).toBe("brand-123");
    expect(result.fields.industry.value).toBe("SaaS");
    expect(result.fields.industry.byBrand["acme.com"].cached).toBe(false);
  });

  it("sends multiple brandIds in body", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ brands: [], fields: {} }),
    });

    const { extractBrandFields } = await loadModule();
    await extractBrandFields(
      [{ key: "x", description: "y" }],
      ["b-1", "b-2", "b-3"],
      baseParams,
    );

    const sentBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(sentBody.brandIds).toEqual(["b-1", "b-2", "b-3"]);
    expect(sentBody.fields).toEqual([{ key: "x", description: "y" }]);
  });

  it("can force a fresh website extraction with resetCache", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ brands: [], fields: {} }),
    });

    const { extractBrandFields } = await loadModule();
    await extractBrandFields(
      [{ key: "valueProposition", description: "Value proposition" }],
      ["b-1"],
      baseParams,
      { resetCache: true },
    );

    const sentBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(sentBody).toEqual({
      brandIds: ["b-1"],
      fields: [{ key: "valueProposition", description: "Value proposition" }],
      resetCache: true,
    });
  });

  it("throws BrandError on non-OK response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Brand not found"),
    });

    const { extractBrandFields, BrandError } = await loadModule();

    const err = await extractBrandFields(
      [{ key: "x", description: "y" }],
      ["brand-1"],
      baseParams,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(BrandError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/extract-fields failed \(404\)/);
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ brands: [], fields: {} }),
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
