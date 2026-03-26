import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.API_SERVICE_URL = "https://api.test.local";
  process.env.ADMIN_DISTRIBUTE_API_KEY = "test-admin-key";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function loadModule() {
  vi.resetModules();
  return import("../../src/lib/campaign-client.js");
}

const params = {
  orgId: "org-uuid-123",
  userId: "user-uuid-456",
  runId: "run-uuid-789",
};

describe("getCampaignFeatureInputs", () => {
  it("fetches campaign and returns featureInputs", async () => {
    const featureInputs = { angle: "sustainability", geography: "US" };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ campaign: { id: "c1", featureInputs } }),
    });

    const { getCampaignFeatureInputs } = await loadModule();
    const result = await getCampaignFeatureInputs("c1", params);

    expect(result).toEqual(featureInputs);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/campaigns/c1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("calls the correct api-service v1 route (regression: was /campaign/campaigns/)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ campaign: { id: "reg1", featureInputs: { x: 1 } } }),
    });

    const { getCampaignFeatureInputs } = await loadModule();
    await getCampaignFeatureInputs("reg1", params);

    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toBe("https://api.test.local/v1/campaigns/reg1");
    expect(url).not.toContain("/campaign/campaigns/");
  });

  it("returns null when featureInputs is null in response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ campaign: { id: "c2", featureInputs: null } }),
    });

    const { getCampaignFeatureInputs } = await loadModule();
    const result = await getCampaignFeatureInputs("c2", params);

    expect(result).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    const { getCampaignFeatureInputs } = await loadModule();
    const result = await getCampaignFeatureInputs("missing", params);

    expect(result).toBeNull();
  });

  it("caches results by campaignId", async () => {
    const featureInputs = { angle: "growth" };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ campaign: { id: "c3", featureInputs } }),
    });

    const { getCampaignFeatureInputs } = await loadModule();

    const result1 = await getCampaignFeatureInputs("c3", params);
    const result2 = await getCampaignFeatureInputs("c3", params);

    expect(result1).toEqual(featureInputs);
    expect(result2).toEqual(featureInputs);
    // Only one fetch call — second was served from cache
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caches null featureInputs too", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ campaign: { id: "c4", featureInputs: null } }),
    });

    const { getCampaignFeatureInputs } = await loadModule();

    await getCampaignFeatureInputs("c4", params);
    await getCampaignFeatureInputs("c4", params);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ campaign: { id: "c5", featureInputs: {} } }),
    });

    const { getCampaignFeatureInputs } = await loadModule();
    await getCampaignFeatureInputs("c5", {
      ...params,
      trackingHeaders: { "x-campaign-id": "c5", "x-brand-id": "b1" },
    });

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders["x-campaign-id"]).toBe("c5");
    expect(callHeaders["x-brand-id"]).toBe("b1");
  });
});

describe("clearCampaignCache", () => {
  it("clears cache so next call fetches again", async () => {
    const featureInputs = { angle: "test" };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ campaign: { id: "c6", featureInputs } }),
    });

    const { getCampaignFeatureInputs, clearCampaignCache } = await loadModule();

    await getCampaignFeatureInputs("c6", params);
    clearCampaignCache();
    await getCampaignFeatureInputs("c6", params);

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
