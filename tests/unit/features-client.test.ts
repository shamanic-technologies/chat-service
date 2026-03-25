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

describe("createFeature", () => {
  it("sends POST /features with correct URL, headers, and body", async () => {
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
      "https://features.test.local/features",
      expect.objectContaining({
        method: "POST",
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

  it("throws when FEATURES_SERVICE_API_KEY is not set", async () => {
    delete process.env.FEATURES_SERVICE_API_KEY;

    const { createFeature } = await loadModule();
    await expect(
      createFeature(sampleFeature, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/FEATURES_SERVICE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses default FEATURES_SERVICE_URL when not set", async () => {
    delete process.env.FEATURES_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(sampleFeature),
    });

    const { createFeature } = await loadModule();
    await createFeature(sampleFeature, { orgId: "o", userId: "u", runId: "r" });

    expect(fetch).toHaveBeenCalledWith(
      "https://features.distribute.you/features",
      expect.anything(),
    );
  });
});

describe("updateFeature", () => {
  it("sends PUT /features/:slug with partial body", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...sampleFeature, description: "Updated description" }),
    });

    const { updateFeature } = await loadModule();
    const result = await updateFeature(
      "cold-email-outreach",
      { description: "Updated description" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://features.test.local/features/cold-email-outreach",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "x-api-key": "test-feat-key",
          "x-org-id": "org-1",
        }),
      }),
    );

    const sentBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sentBody.description).toBe("Updated description");
    expect(sentBody.slug).toBeUndefined();

    expect(result.description).toBe("Updated description");
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
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
  it("sends GET /features with query params", async () => {
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
    expect(calledUrl).toContain("/features?");
    expect(calledUrl).toContain("category=sales");
    expect(calledUrl).toContain("channel=email");
    expect(calledUrl).toContain("audienceType=cold-outreach");
    expect(result).toEqual(mockFeatures);
  });

  it("sends GET /features without query params when no filters", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const { listFeatures } = await loadModule();
    await listFeatures({}, { orgId: "o", userId: "u", runId: "r" });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://features.test.local/features");
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
  it("sends GET /features/:slug with correct URL and headers", async () => {
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
      "https://features.test.local/features/cold-email-outreach",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-api-key": "test-feat-key",
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
