import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubGlobal("fetch", vi.fn());

async function loadModule() {
  vi.resetModules();
  process.env.API_REGISTRY_SERVICE_URL = "https://api-registry.test.local";
  process.env.API_REGISTRY_SERVICE_API_KEY = "test-registry-key";
  return import("../../src/lib/api-registry-client.js");
}

describe("listServices", () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it("calls GET /llm-context with correct headers", async () => {
    const mockResponse = {
      _description: "API registry",
      _workflow: "list_services → list_service_endpoints → call_api",
      serviceCount: 2,
      services: [
        { service: "brand", title: "Brand Service", endpointCount: 5 },
        { service: "features", title: "Features Service", endpointCount: 8 },
      ],
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    const { listServices } = await loadModule();
    const result = await listServices({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api-registry.test.local/llm-context",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "test-registry-key",
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
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    } as Response);

    const { listServices } = await loadModule();
    await expect(
      listServices({ orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 401/);
  });

  it("throws when API key is missing", async () => {
    vi.resetModules();
    process.env.API_REGISTRY_SERVICE_URL = "https://api-registry.test.local";
    delete process.env.API_REGISTRY_SERVICE_API_KEY;

    const { listServices } = await import(
      "../../src/lib/api-registry-client.js"
    );
    await expect(
      listServices({ orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/API_REGISTRY_SERVICE_API_KEY is required/);
  });
});

describe("listServiceEndpoints", () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it("calls GET /llm-context/{service} with correct path", async () => {
    const mockResponse = {
      service: "brand",
      title: "Brand Service",
      endpointCount: 2,
      endpoints: [
        { method: "GET", path: "/brands", summary: "List brands" },
        { method: "POST", path: "/brands", summary: "Create brand" },
      ],
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    const { listServiceEndpoints } = await loadModule();
    const result = await listServiceEndpoints("brand", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api-registry.test.local/llm-context/brand",
      expect.anything(),
    );
    expect(result.service).toBe("brand");
    expect(result.endpoints).toHaveLength(2);
  });

  it("throws on 404 (service not found)", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Service not found"),
    } as Response);

    const { listServiceEndpoints } = await loadModule();
    await expect(
      listServiceEndpoints("nonexistent", { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 404/);
  });
});

describe("callApi", () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it("proxies a GET request", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: 200,
          ok: true,
          data: { keys: [{ provider: "anthropic", maskedKey: "sk-...abc" }] },
        }),
    } as Response);

    const { callApi } = await loadModule();
    const result = await callApi(
      { service: "key", method: "GET", path: "/keys" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api-registry.test.local/call/key",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-api-key": "test-registry-key",
        }),
      }),
    );

    // Verify body contains the proxied request details
    const callBody = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(callBody).toEqual({ method: "GET", path: "/keys" });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("proxies a POST request with body", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ status: 200, ok: true, data: { providers: ["anthropic"] } }),
    } as Response);

    const { callApi } = await loadModule();
    await callApi(
      {
        service: "key",
        method: "POST",
        path: "/provider-requirements",
        body: { endpoints: [{ service: "chat", method: "POST", path: "/complete" }] },
      },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    const callBody = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(callBody.method).toBe("POST");
    expect(callBody.path).toBe("/provider-requirements");
    expect(callBody.body).toEqual({
      endpoints: [{ service: "chat", method: "POST", path: "/complete" }],
    });
  });

  it("throws on 502 (downstream failure)", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve("Downstream unavailable"),
    } as Response);

    const { callApi } = await loadModule();
    await expect(
      callApi(
        { service: "brand", method: "GET", path: "/brands" },
        { orgId: "o", userId: "u", runId: "r" },
      ),
    ).rejects.toThrow(/returned 502/);
  });
});
