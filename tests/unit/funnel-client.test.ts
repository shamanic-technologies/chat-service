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
  return import("../../src/lib/funnel-client.js");
}

const baseParams = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
};

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("funnel-client — end-to-end funnel operations", () => {
  it("create_brand_from_url POSTs /v1/brands { url } and returns the parsed body", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ brandId: "b-9" }));

    const { createBrandFromUrl } = await loadModule();
    const result = await createBrandFromUrl("https://acme.com", baseParams);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/brands",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "test-api-svc-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
        body: JSON.stringify({ url: "https://acme.com" }),
      }),
    );
    expect(result).toEqual({ brandId: "b-9" });
  });

  it("list_brands GETs /v1/brands", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ brands: [] }));
    const { listBrands } = await loadModule();
    await listBrands(baseParams);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/brands",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("launch_campaign POSTs /v1/campaigns with the full body", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ campaign: { id: "c-1", status: "active" } }));
    const { launchCampaign } = await loadModule();
    const body = {
      name: "Q2 Outreach",
      brandUrls: ["https://acme.com"],
      featureInputs: { targetAudience: "SaaS founders" },
      featureDynastySlug: "pr-cold-email-outreach",
      workflowDynastySlug: "sales-email-cold-outreach-sienna",
      maxBudgetTotalUsd: "500",
    };
    const result = await launchCampaign(body, baseParams);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/campaigns",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
    expect(result).toEqual({ campaign: { id: "c-1", status: "active" } });
  });

  it("list_campaigns builds the brandId + status query string", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ campaigns: [] }));
    const { listCampaigns } = await loadModule();
    await listCampaigns({ brandId: "b-1", status: "active" }, baseParams);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/campaigns?brandId=b-1&status=active",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("list_campaigns omits the query string when no filters", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ campaigns: [] }));
    const { listCampaigns } = await loadModule();
    await listCampaigns({}, baseParams);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/campaigns",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("stop_campaign POSTs /v1/campaigns/{id}/stop with an encoded id", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ campaign: { id: "c-1", status: "stopped" } }));
    const { stopCampaign } = await loadModule();
    await stopCampaign("c-1", baseParams);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/campaigns/c-1/stop",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("get_daily_budget GETs the brand daily-budget", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ dailyBudgetCents: 2000 }));
    const { getBrandDailyBudget } = await loadModule();
    const result = await getBrandDailyBudget("b-1", baseParams);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/brands/b-1/daily-budget",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toEqual({ dailyBudgetCents: 2000 });
  });

  it("set_daily_budget PATCHes { dailyBudgetCents }", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({}));
    const { setBrandDailyBudget } = await loadModule();
    await setBrandDailyBudget("b-1", 2500, baseParams);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/brands/b-1/daily-budget",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ dailyBudgetCents: 2500 }),
      }),
    );
  });

  it("set_brand_pause PATCHes { paused } for pause and resume", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({}));
    const { setBrandPauseState } = await loadModule();

    await setBrandPauseState("b-1", true, baseParams);
    expect(fetch).toHaveBeenLastCalledWith(
      "https://api.test.local/v1/brands/b-1/pause",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ paused: true }) }),
    );

    await setBrandPauseState("b-1", false, baseParams);
    expect(fetch).toHaveBeenLastCalledWith(
      "https://api.test.local/v1/brands/b-1/pause",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ paused: false }) }),
    );
  });

  it("get_brand_pause GETs the brand pause state", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ paused: false }));
    const { getBrandPauseState } = await loadModule();
    await getBrandPauseState("b-1", baseParams);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/brands/b-1/pause",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns {} for an empty success body", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
    });
    const { setBrandDailyBudget } = await loadModule();
    const result = await setBrandDailyBudget("b-1", 0, baseParams);
    expect(result).toEqual({});
  });

  it("fails loud (throws FunnelError) on a non-2xx response, preserving status + body", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("brandId required"),
    });
    const { launchCampaign, FunnelError } = await loadModule();

    const err = await launchCampaign(
      { name: "x", brandUrls: ["https://x.com"], featureInputs: {} },
      baseParams,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(FunnelError);
    expect(err.status).toBe(400);
    expect(err.operation).toBe("launch_campaign");
    expect(String(err.message)).toContain("brandId required");
  });

  it("forwards tracking headers to api-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ brands: [] }));
    const { listBrands } = await loadModule();
    await listBrands({ ...baseParams, trackingHeaders: { "x-brand-id": "b-1" } });
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-brand-id": "b-1" }),
      }),
    );
  });
});
