import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.FEATURES_SERVICE_API_KEY = "test-feat-key";
  process.env.FEATURES_SERVICE_URL = "https://features.test.local";
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
  category: "sales",
  channel: "email",
  audienceType: "cold-outreach",
  inputs: [
    { key: "targetCompanyUrl", label: "Target Company URL", description: "URL of the company to prospect" },
  ],
  outputs: [
    { key: "generatedEmail", label: "Generated Email", description: "The generated cold email" },
  ],
};

describe("upsertFeature", () => {
  it("sends PUT /features with correct URL, headers, and body", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ features: [{ ...sampleFeature, id: "feat-1" }] }),
    });

    const { upsertFeature } = await loadModule();
    const result = await upsertFeature(sampleFeature, {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://features.test.local/features",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-api-key": "test-feat-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
      }),
    );

    const sentBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sentBody.features).toHaveLength(1);
    expect(sentBody.features[0].slug).toBe("cold-email-outreach");
    expect(sentBody.features[0].inputs).toHaveLength(1);
    expect(sentBody.features[0].outputs).toHaveLength(1);

    expect(result.slug).toBe("cold-email-outreach");
    expect(result.id).toBe("feat-1");
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ features: [sampleFeature] }),
    });

    const { upsertFeature } = await loadModule();
    await upsertFeature(sampleFeature, {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      trackingHeaders: { "x-campaign-id": "camp-1", "x-feature-slug": "cold-email-outreach" },
    });

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders["x-campaign-id"]).toBe("camp-1");
    expect(callHeaders["x-feature-slug"]).toBe("cold-email-outreach");
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve("Validation failed"),
    });

    const { upsertFeature } = await loadModule();
    await expect(
      upsertFeature(sampleFeature, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 422/);
  });

  it("throws when FEATURES_SERVICE_API_KEY is not set", async () => {
    delete process.env.FEATURES_SERVICE_API_KEY;

    const { upsertFeature } = await loadModule();
    await expect(
      upsertFeature(sampleFeature, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/FEATURES_SERVICE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses default FEATURES_SERVICE_URL when not set", async () => {
    delete process.env.FEATURES_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ features: [sampleFeature] }),
    });

    const { upsertFeature } = await loadModule();
    await upsertFeature(sampleFeature, { orgId: "o", userId: "u", runId: "r" });

    expect(fetch).toHaveBeenCalledWith(
      "https://features.distribute.you/features",
      expect.anything(),
    );
  });
});
