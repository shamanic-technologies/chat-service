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
  return import("../../src/lib/api-registry-client.js");
}

describe("listServices", () => {
  it("calls GET /v1/platform/llm-context via api-service", async () => {
    const mockResponse = {
      _description: "API registry",
      _workflow: "list_services → list_service_endpoints → call_api",
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
    const result = await listServices({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/platform/llm-context",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-API-Key": "test-api-svc-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
      }),
    );
    expect(result.serviceCount).toBe(2);
    expect(result.services).toHaveLength(2);
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const { listServices } = await loadModule();
    await expect(
      listServices({ orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 401/);
  });

  it("throws when API key is missing", async () => {
    delete process.env.ADMIN_DISTRIBUTE_API_KEY;

    const { listServices } = await loadModule();
    await expect(
      listServices({ orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/ADMIN_DISTRIBUTE_API_KEY is required/);
  });
});

describe("listServiceEndpoints", () => {
  it("calls GET /v1/platform/services/{service} via api-service", async () => {
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
    const result = await listServiceEndpoints("brand", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/platform/services/brand",
      expect.anything(),
    );
    expect(result.service).toBe("brand");
    expect(result.endpoints).toHaveLength(2);
  });

  it("throws on 404 (service not found)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Service not found"),
    });

    const { listServiceEndpoints } = await loadModule();
    await expect(
      listServiceEndpoints("nonexistent", { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 404/);
  });
});

describe("callApi", () => {
  it("makes a direct GET request via api-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ keys: [{ provider: "anthropic", maskedKey: "sk-...abc" }] }),
    });

    const { callApi } = await loadModule();
    const result = await callApi(
      { service: "key", method: "GET", path: "/v1/keys" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/keys",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-API-Key": "test-api-svc-key",
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("makes a direct POST request with body via api-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ providers: ["anthropic"] }),
    });

    const { callApi } = await loadModule();
    await callApi(
      {
        service: "key",
        method: "POST",
        path: "/v1/keys/provider-requirements",
        body: { endpoints: [{ service: "chat", method: "POST", path: "/complete" }] },
      },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/keys/provider-requirements",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const callBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(callBody).toEqual({
      endpoints: [{ service: "chat", method: "POST", path: "/complete" }],
    });
  });

  it("returns error status for failed requests", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: "Downstream unavailable" }),
    });

    const { callApi } = await loadModule();
    const result = await callApi(
      { service: "brand", method: "GET", path: "/v1/brands" },
      { orgId: "o", userId: "u", runId: "r" },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
  });
});
