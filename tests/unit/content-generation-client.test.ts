import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.CONTENT_GENERATION_SERVICE_API_KEY = "test-cg-key";
  process.env.CONTENT_GENERATION_SERVICE_URL = "https://content-generation.test.local";
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
  it("sends GET with correct URL, headers, and query param", async () => {
    const mockPrompt = {
      id: "p-1",
      type: "cold-email",
      prompt: "Write a cold email for {{leadFirstName}}",
      variables: ["leadFirstName"],
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
      "https://content-generation.test.local/prompts?type=cold-email",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-api-key": "test-cg-key",
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
    expect(calledUrl).toBe("https://content-generation.test.local/prompts?type=cold%20email");
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

  it("throws when CONTENT_GENERATION_SERVICE_API_KEY is not set", async () => {
    delete process.env.CONTENT_GENERATION_SERVICE_API_KEY;

    const { getPromptTemplate } = await loadModule();
    await expect(
      getPromptTemplate("cold-email", { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/CONTENT_GENERATION_SERVICE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses default URL when CONTENT_GENERATION_SERVICE_URL is not set", async () => {
    delete process.env.CONTENT_GENERATION_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "p-1", type: "t", prompt: "", variables: [], createdAt: "", updatedAt: "" }),
    });

    const { getPromptTemplate } = await loadModule();
    await getPromptTemplate("cold-email", { orgId: "o", userId: "u", runId: "r" });

    expect(fetch).toHaveBeenCalledWith(
      "https://content-generation.distribute.you/prompts?type=cold-email",
      expect.anything(),
    );
  });
});

describe("updatePromptTemplate", () => {
  it("sends PUT with correct URL, headers, and body", async () => {
    const mockResult = {
      id: "p-2",
      type: "cold-email-v2",
      prompt: "New prompt for {{leadFirstName}}",
      variables: ["leadFirstName"],
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
        variables: ["leadFirstName"],
      },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://content-generation.test.local/prompts",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-api-key": "test-cg-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
        body: JSON.stringify({
          sourceType: "cold-email",
          prompt: "New prompt for {{leadFirstName}}",
          variables: ["leadFirstName"],
        }),
      }),
    );
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

  it("throws when CONTENT_GENERATION_SERVICE_API_KEY is not set", async () => {
    delete process.env.CONTENT_GENERATION_SERVICE_API_KEY;

    const { updatePromptTemplate } = await loadModule();
    await expect(
      updatePromptTemplate(
        { sourceType: "cold-email", prompt: "test", variables: [] },
        { orgId: "o", userId: "u", runId: "r" },
      ),
    ).rejects.toThrow(/CONTENT_GENERATION_SERVICE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });
});
