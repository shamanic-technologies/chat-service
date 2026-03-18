import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubGlobal("fetch", vi.fn());

async function loadModule() {
  vi.resetModules();
  process.env.API_REGISTRY_SERVICE_URL = "https://api-registry.test.local";
  process.env.API_REGISTRY_SERVICE_API_KEY = "test-registry-key";
  return import("../../src/lib/api-registry-client.js");
}

describe("listAvailableServices", () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it("calls GET /llm-context with correct headers", async () => {
    const mockResponse = {
      _description: "API registry",
      _usage: "Use service names in http.call nodes",
      services: [
        {
          service: "content-generation",
          baseUrl: "https://content-generation.distribute.you",
          title: "Content Generation",
          description: "Generates content",
          endpoints: [
            { method: "GET", path: "/prompts", summary: "Get prompts" },
            { method: "POST", path: "/generate", summary: "Generate content" },
          ],
        },
      ],
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    const { listAvailableServices } = await loadModule();
    const result = await listAvailableServices({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api-registry.test.local/llm-context",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-api-key": "test-registry-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
      }),
    );
    expect(result.services).toHaveLength(1);
    expect(result.services[0].service).toBe("content-generation");
    expect(result.services[0].endpoints).toHaveLength(2);
  });

  it("throws on HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    } as Response);

    const { listAvailableServices } = await loadModule();
    await expect(
      listAvailableServices({ orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 401/);
  });

  it("throws when API key is missing", async () => {
    vi.resetModules();
    process.env.API_REGISTRY_SERVICE_URL = "https://api-registry.test.local";
    delete process.env.API_REGISTRY_SERVICE_API_KEY;

    const { listAvailableServices } = await import(
      "../../src/lib/api-registry-client.js"
    );
    await expect(
      listAvailableServices({ orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/API_REGISTRY_SERVICE_API_KEY is required/);
  });

  it("uses default URL when env var is not set", async () => {
    vi.resetModules();
    delete process.env.API_REGISTRY_SERVICE_URL;
    process.env.API_REGISTRY_SERVICE_API_KEY = "test-key";

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ services: [] }),
    } as Response);

    const { listAvailableServices } = await import(
      "../../src/lib/api-registry-client.js"
    );
    await listAvailableServices({ orgId: "o", userId: "u", runId: "r" });

    expect(fetch).toHaveBeenCalledWith(
      "https://api-registry.distribute.you/llm-context",
      expect.anything(),
    );
  });
});
