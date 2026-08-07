import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.API_REGISTRY_SERVICE_URL = "https://api-registry.test.local";
  process.env.API_REGISTRY_SERVICE_API_KEY = "test-registry-key";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function loadModule() {
  vi.resetModules();
  return import("../../src/lib/api-registry-client.js");
}

describe("listServices", () => {
  it("calls GET /llm-context on api-registry directly", async () => {
    const mockResponse = {
      _description: "API registry",
      _workflow: "list_services → list_service_endpoints",
      serviceCount: 2,
      services: [
        { service: "brand", title: "Brand Service", endpointCount: 5 },
        { service: "features", title: "Features Service", endpointCount: 8 },
      ],
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { listServices } = await loadModule();
    const result = await listServices();

    expect(fetch).toHaveBeenCalledWith(
      "https://api-registry.test.local/llm-context",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-API-Key": "test-registry-key",
        }),
      }),
    );
    expect(result.serviceCount).toBe(2);
    expect(result.services).toHaveLength(2);
  });

  it("omits X-API-Key header when no key is configured", async () => {
    delete process.env.API_REGISTRY_SERVICE_API_KEY;

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ serviceCount: 0, services: [] }),
    });

    const { listServices } = await loadModule();
    await listServices();

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty("X-API-Key");
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const { listServices } = await loadModule();
    await expect(listServices()).rejects.toThrow(/returned 401/);
  });
});

describe("listServiceEndpoints", () => {
  it("calls GET /llm-context/{service} on api-registry directly", async () => {
    const mockResponse = {
      service: "brand",
      title: "Brand Service",
      endpointCount: 2,
      endpoints: [
        { method: "GET", path: "/brands", summary: "List brands" },
        { method: "POST", path: "/brands", summary: "Create brand" },
      ],
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { listServiceEndpoints } = await loadModule();
    const result = await listServiceEndpoints("brand");

    expect(fetch).toHaveBeenCalledWith(
      "https://api-registry.test.local/llm-context/brand",
      expect.anything(),
    );
    expect(result.service).toBe("brand");
    expect(result.endpoints).toHaveLength(2);
  });

  it("handles grouped response for large services", async () => {
    const mockResponse = {
      service: "workflow",
      totalEndpoints: 45,
      groupCount: 3,
      groups: [
        {
          group: "workflows",
          endpointCount: 20,
          endpoints: [{ method: "GET", path: "/v1/workflows", summary: "List workflows" }],
        },
      ],
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { listServiceEndpoints } = await loadModule();
    const result = await listServiceEndpoints("workflow");

    expect(result.totalEndpoints).toBe(45);
    expect(result.groupCount).toBe(3);
    expect(result.groups).toHaveLength(1);
  });

  it("throws on 404 (service not found)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Service not found"),
    });

    const { listServiceEndpoints } = await loadModule();
    await expect(
      listServiceEndpoints("nonexistent"),
    ).rejects.toThrow(/returned 404/);
  });

  it("uses default URL when env var is not set", async () => {
    delete process.env.API_REGISTRY_SERVICE_URL;

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ service: "test", endpoints: [] }),
    });

    const { listServiceEndpoints } = await loadModule();
    await listServiceEndpoints("test");

    expect(fetch).toHaveBeenCalledWith(
      "https://api-registry.distribute.you/llm-context/test",
      expect.anything(),
    );
  });
});
