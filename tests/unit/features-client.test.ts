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
  return import("../../src/lib/features-client.js");
}

const sampleFeature = {
  slug: "cold-email-outreach",
  name: "Cold Email Outreach",
  description: "Automated cold email outreach campaign",
  icon: "mail",
  category: "sales",
  channel: "email",
  audienceType: "cold-outreach",
  inputs: [
    { key: "targetCompanyUrl", label: "Target Company URL", type: "text" as const, placeholder: "https://example.com", description: "URL of the company to prospect", extractKey: "company_url" },
  ],
  outputs: [
    { key: "emailsSent", label: "Emails Sent", type: "count" as const, displayOrder: 0, showInCampaignRow: true, showInFunnel: true },
  ],
};

describe("createFeature", () => {
  it("sends POST /v1/features via api-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ ...sampleFeature, id: "feat-1" }),
    });

    const { createFeature } = await loadModule();
    const result = await createFeature(sampleFeature, {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/features",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-svc-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
      }),
    );

    const sentBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sentBody.slug).toBe("cold-email-outreach");
    expect(sentBody.inputs).toHaveLength(1);
    expect(sentBody.outputs).toHaveLength(1);

    expect(result.slug).toBe("cold-email-outreach");
    expect(result.id).toBe("feat-1");
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(sampleFeature),
    });

    const { createFeature } = await loadModule();
    await createFeature(sampleFeature, {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      trackingHeaders: { "x-campaign-id": "camp-1", "x-feature-slug": "cold-email-outreach" },
    });

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders["x-campaign-id"]).toBe("camp-1");
    expect(callHeaders["x-feature-slug"]).toBe("cold-email-outreach");
  });

  it("throws with conflict message on HTTP 409", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      text: () => Promise.resolve("Feature with slug 'cold-email-outreach' already exists"),
    });

    const { createFeature } = await loadModule();
    await expect(
      createFeature(sampleFeature, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/already exists/);
  });

  it("throws on other HTTP errors", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve("Validation failed"),
    });

    const { createFeature } = await loadModule();
    await expect(
      createFeature(sampleFeature, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 422/);
  });

  it("throws when ADMIN_DISTRIBUTE_API_KEY is not set", async () => {
    delete process.env.ADMIN_DISTRIBUTE_API_KEY;

    const { createFeature } = await loadModule();
    await expect(
      createFeature(sampleFeature, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/ADMIN_DISTRIBUTE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses default API_SERVICE_URL when not set", async () => {
    delete process.env.API_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(sampleFeature),
    });

    const { createFeature } = await loadModule();
    await createFeature(sampleFeature, { orgId: "o", userId: "u", runId: "r" });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.distribute.you/v1/features",
      expect.anything(),
    );
  });
});

describe("updateFeature", () => {
  it("returns { feature, forked: false } on 200 (in-place update)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ...sampleFeature, description: "Updated description" }),
    });

    const { updateFeature } = await loadModule();
    const result = await updateFeature(
      "cold-email-outreach",
      { description: "Updated description" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/features/cold-email-outreach",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer test-api-svc-key",
          "x-org-id": "org-1",
        }),
      }),
    );

    const sentBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sentBody.description).toBe("Updated description");
    expect(sentBody.slug).toBeUndefined();

    expect(result.forked).toBe(false);
    expect(result.feature.description).toBe("Updated description");
  });

  it("returns { feature, forked: true } on 201 (fork-on-write)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ ...sampleFeature, slug: "cold-email-outreach-v2", name: "Cold Email Outreach v2" }),
    });

    const { updateFeature } = await loadModule();
    const result = await updateFeature(
      "cold-email-outreach",
      { inputs: [{ key: "newInput", label: "New", type: "text" as const, placeholder: "...", description: "new input", extractKey: "new" }] },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(result.forked).toBe(true);
    expect(result.feature.slug).toBe("cold-email-outreach-v2");
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(sampleFeature),
    });

    const { updateFeature } = await loadModule();
    await updateFeature(
      "cold-email-outreach",
      { name: "New Name" },
      {
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        trackingHeaders: { "x-feature-slug": "cold-email-outreach" },
      },
    );

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders["x-feature-slug"]).toBe("cold-email-outreach");
  });

  it("throws on HTTP 404", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not found"),
    });

    const { updateFeature } = await loadModule();
    await expect(
      updateFeature("nonexistent", { name: "x" }, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 404/);
  });

  it("throws on HTTP 409 (signature conflict)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      text: () => Promise.resolve("Signature conflict"),
    });

    const { updateFeature } = await loadModule();
    await expect(
      updateFeature("cold-email-outreach", { name: "Conflicting" }, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 409/);
  });

  it("URL-encodes the slug", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleFeature),
    });

    const { updateFeature } = await loadModule();
    await updateFeature("slug with spaces", { name: "x" }, { orgId: "o", userId: "u", runId: "r" });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("slug%20with%20spaces");
  });
});

describe("listFeatures", () => {
  it("sends GET /v1/features with query params via api-service", async () => {
    const mockFeatures = [sampleFeature];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockFeatures),
    });

    const { listFeatures } = await loadModule();
    const result = await listFeatures(
      { category: "sales", channel: "email", audienceType: "cold-outreach" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v1/features?");
    expect(calledUrl).toContain("category=sales");
    expect(calledUrl).toContain("channel=email");
    expect(calledUrl).toContain("audienceType=cold-outreach");
    expect(result).toEqual(mockFeatures);
  });

  it("sends GET /v1/features without query params when no filters", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const { listFeatures } = await loadModule();
    await listFeatures({}, { orgId: "o", userId: "u", runId: "r" });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.test.local/v1/features");
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server error"),
    });

    const { listFeatures } = await loadModule();
    await expect(
      listFeatures({ category: "sales" }, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 500/);
  });
});

describe("getFeature", () => {
  it("sends GET /v1/features/:slug via api-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleFeature),
    });

    const { getFeature } = await loadModule();
    const result = await getFeature("cold-email-outreach", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/features/cold-email-outreach",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-api-svc-key",
          "x-org-id": "org-1",
        }),
      }),
    );
    expect(result.slug).toBe("cold-email-outreach");
  });

  it("throws on HTTP 404", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not found"),
    });

    const { getFeature } = await loadModule();
    await expect(
      getFeature("nonexistent", { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 404/);
  });

  it("URL-encodes the slug", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleFeature),
    });

    const { getFeature } = await loadModule();
    await getFeature("slug with spaces", { orgId: "o", userId: "u", runId: "r" });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("slug%20with%20spaces");
  });
});

describe("getFeatureInputs", () => {
  it("sends GET /v1/features/:slug/inputs via api-service", async () => {
    const mockResponse = {
      slug: "cold-email-outreach",
      name: "Cold Email Outreach",
      inputs: sampleFeature.inputs,
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { getFeatureInputs } = await loadModule();
    const result = await getFeatureInputs("cold-email-outreach", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.test.local/v1/features/cold-email-outreach/inputs");
    expect(result.slug).toBe("cold-email-outreach");
    expect(result.inputs).toHaveLength(1);
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not found"),
    });

    const { getFeatureInputs } = await loadModule();
    await expect(
      getFeatureInputs("nonexistent", { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 404/);
  });
});

describe("prefillFeature", () => {
  it("sends POST /v1/features/:slug/prefill via api-service", async () => {
    const mockResponse = {
      slug: "cold-email-outreach",
      brandId: "brand-1",
      format: "text" as const,
      prefilled: { targetCompanyUrl: "https://acme.com" },
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { prefillFeature } = await loadModule();
    const result = await prefillFeature("cold-email-outreach", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/features/cold-email-outreach/prefill",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.prefilled.targetCompanyUrl).toBe("https://acme.com");
    expect(result.format).toBe("text");
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("No brand configured"),
    });

    const { prefillFeature } = await loadModule();
    await expect(
      prefillFeature("cold-email-outreach", { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 400/);
  });
});

describe("getFeatureStats", () => {
  it("sends GET /v1/features/:slug/stats with filters via api-service", async () => {
    const mockResponse = {
      featureSlug: "cold-email-outreach",
      systemStats: { totalCostInUsdCents: 150, completedRuns: 10, activeCampaigns: 2, firstRunAt: null, lastRunAt: null },
      stats: { emailsSent: 42 },
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { getFeatureStats } = await loadModule();
    const result = await getFeatureStats(
      "cold-email-outreach",
      { groupBy: "brandId", brandId: "brand-1" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v1/features/cold-email-outreach/stats?");
    expect(calledUrl).toContain("groupBy=brandId");
    expect(calledUrl).toContain("brandId=brand-1");
    expect(result.systemStats.completedRuns).toBe(10);
    expect(result.stats?.emailsSent).toBe(42);
  });

  it("sends GET /v1/features/:slug/stats without filters", async () => {
    const mockResponse = {
      featureSlug: "cold-email-outreach",
      systemStats: { totalCostInUsdCents: 0, completedRuns: 0, activeCampaigns: 0, firstRunAt: null, lastRunAt: null },
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { getFeatureStats } = await loadModule();
    await getFeatureStats("cold-email-outreach", {}, { orgId: "o", userId: "u", runId: "r" });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.test.local/v1/features/cold-email-outreach/stats");
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Feature not found"),
    });

    const { getFeatureStats } = await loadModule();
    await expect(
      getFeatureStats("nonexistent", {}, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 404/);
  });
});
