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
  return import("../../src/lib/content-generation-client.js");
}

describe("getPromptTemplate", () => {
  it("sends GET via api-service with correct URL and headers", async () => {
    const mockPrompt = {
      id: "p-1",
      type: "cold-email",
      prompt: "Write a cold email for {{leadFirstName}}",
      variables: [{ name: "leadFirstName", description: "The lead's first name" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockPrompt),
    });

    const { getPromptTemplate } = await loadModule();
    const result = await getPromptTemplate("cold-email", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/prompts?type=cold-email",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-API-Key": "test-api-svc-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
      }),
    );
    expect(result).toEqual(mockPrompt);
  });

  it("encodes special characters in type parameter", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "p-1", type: "cold email", prompt: "", variables: [], createdAt: "", updatedAt: "" }),
    });

    const { getPromptTemplate } = await loadModule();
    await getPromptTemplate("cold email", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toBe("https://api.test.local/v1/prompts?type=cold%20email");
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "p-1", type: "t", prompt: "", variables: [], createdAt: "", updatedAt: "" }),
    });

    const { getPromptTemplate } = await loadModule();
    await getPromptTemplate("cold-email", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      trackingHeaders: { "x-campaign-id": "camp-1" },
    });

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders["x-campaign-id"]).toBe("camp-1");
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not found"),
    });

    const { getPromptTemplate } = await loadModule();
    await expect(
      getPromptTemplate("nonexistent", { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 404/);
  });

  it("throws when ADMIN_DISTRIBUTE_API_KEY is not set", async () => {
    delete process.env.ADMIN_DISTRIBUTE_API_KEY;

    const { getPromptTemplate } = await loadModule();
    await expect(
      getPromptTemplate("cold-email", { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/ADMIN_DISTRIBUTE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses default URL when API_SERVICE_URL is not set", async () => {
    delete process.env.API_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "p-1", type: "t", prompt: "", variables: [], createdAt: "", updatedAt: "" }),
    });

    const { getPromptTemplate } = await loadModule();
    await getPromptTemplate("cold-email", { orgId: "o", userId: "u", runId: "r" });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.distribute.you/v1/prompts?type=cold-email",
      expect.anything(),
    );
  });
});

describe("updatePromptTemplate", () => {
  it("sends PUT via api-service with correct URL, headers, and object variables", async () => {
    const variables = [
      { name: "leadFirstName", description: "The lead's first name" },
    ];
    const mockResult = {
      id: "p-2",
      type: "cold-email-v2",
      prompt: "New prompt for {{leadFirstName}}",
      variables,
      createdAt: "2026-03-18T00:00:00Z",
      updatedAt: "2026-03-18T00:00:00Z",
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResult),
    });

    const { updatePromptTemplate } = await loadModule();
    const result = await updatePromptTemplate(
      {
        sourceType: "cold-email",
        prompt: "New prompt for {{leadFirstName}}",
        variables,
      },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/prompts",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-API-Key": "test-api-svc-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
        body: JSON.stringify({
          sourceType: "cold-email",
          prompt: "New prompt for {{leadFirstName}}",
          variables,
        }),
      }),
    );
    expect(result).toEqual(mockResult);
  });

  // Regression — DIS-138: object-shaped `variables` must reach the wire as
  // objects, never coerced to bare strings. Reproduces the failing prod call
  // (blind-discovery-email-v15, 11 variables) that 400'd at content-generation
  // ("expected object, received string" ×11) when the client still sent strings.
  it("forwards object variables uncoerced (blind-discovery-email-v15, 11 vars)", async () => {
    const variables = [
      { name: "senderFirstName", description: "Sender's first name" },
      { name: "senderCompany", description: "Sender's company name" },
      { name: "senderRole", description: "Sender's job title" },
      { name: "leadFirstName", description: "Lead's first name" },
      { name: "leadCompany", description: "Lead's company name" },
      { name: "leadRole", description: "Lead's job title" },
      { name: "leadIndustry", description: "Lead's industry" },
      { name: "painPoint", description: "Inferred pain point" },
      { name: "valueProp", description: "Value proposition" },
      { name: "callToAction", description: "Desired CTA" },
      { name: "brandProfiles", description: "Array of brand profiles (multibrand)" },
    ];
    const mockResult = {
      id: "p-15",
      type: "blind-discovery-email-v15",
      prompt: "Hi {{leadFirstName}} ... {{callToAction}}",
      variables,
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResult),
    });

    const { updatePromptTemplate } = await loadModule();
    const result = await updatePromptTemplate(
      {
        sourceType: "blind-discovery-email-v14",
        prompt: "Hi {{leadFirstName}} ... {{callToAction}}",
        variables,
      },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    // Assert the OUTBOUND PUT body carries object variables — not strings.
    const sentBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    );
    expect(sentBody.variables).toHaveLength(11);
    for (const v of sentBody.variables) {
      expect(typeof v).toBe("object");
      expect(typeof v.name).toBe("string");
      expect(typeof v.description).toBe("string");
    }
    expect(sentBody.variables[10]).toEqual({
      name: "brandProfiles",
      description: "Array of brand profiles (multibrand)",
    });
    // 2xx maps to the saved template.
    expect(result).toEqual(mockResult);
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "p-2", type: "t-v2", prompt: "", variables: [], createdAt: "", updatedAt: "" }),
    });

    const { updatePromptTemplate } = await loadModule();
    await updatePromptTemplate(
      { sourceType: "cold-email", prompt: "test", variables: [] },
      { orgId: "org-1", userId: "user-1", runId: "run-1", trackingHeaders: { "x-brand-id": "brand-1" } },
    );

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders["x-brand-id"]).toBe("brand-1");
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Invalid request"),
    });

    const { updatePromptTemplate } = await loadModule();
    await expect(
      updatePromptTemplate(
        { sourceType: "bad", prompt: "", variables: [] },
        { orgId: "o", userId: "u", runId: "r" },
      ),
    ).rejects.toThrow(/returned 400/);
  });

  it("throws when ADMIN_DISTRIBUTE_API_KEY is not set", async () => {
    delete process.env.ADMIN_DISTRIBUTE_API_KEY;

    const { updatePromptTemplate } = await loadModule();
    await expect(
      updatePromptTemplate(
        { sourceType: "cold-email", prompt: "test", variables: [] },
        { orgId: "o", userId: "u", runId: "r" },
      ),
    ).rejects.toThrow(/ADMIN_DISTRIBUTE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });
});
