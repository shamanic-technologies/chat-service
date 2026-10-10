import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testRunPath, compactTestResult, TEST_RESULT_MAX_CHARS } from "../../src/lib/discovery-client.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.API_REGISTRY_SERVICE_URL = "http://registry.test";
  process.env.API_REGISTRY_SERVICE_API_KEY = "registry-key";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function load() {
  vi.resetModules();
  return import("../../src/lib/discovery-client.js");
}

const fetchMock = () => fetch as ReturnType<typeof vi.fn>;
const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(JSON.stringify(body)),
});

describe("discovery by depth (api-registry /discover)", () => {
  it.each([
    ["discover_services", { q: "lead", limit: 5 }, "/discover/services?q=lead&limit=5"],
    ["discover_service_endpoints", { service: "features", method: "get" }, "/discover/services/features/endpoints?method=GET"],
    ["discover_endpoint", { service: "features", method: "GET", path: "/internal/catalogue/steps" }, "/discover/services/features/endpoint?method=GET&path=%2Finternal%2Fcatalogue%2Fsteps"],
  ])("%s(%j) → GET %s with the registry key", async (tool, args, path) => {
    fetchMock().mockResolvedValue(res(200, { ok: 1 }));
    const { DISCOVERY_READ_TOOLS } = await load();
    expect(await DISCOVERY_READ_TOOLS[tool](args)).toEqual({ ok: 1 });
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://registry.test${path}`);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("registry-key");
  });

  it("fails loud when the registry is not configured", async () => {
    delete process.env.API_REGISTRY_SERVICE_URL;
    const { DISCOVERY_READ_TOOLS } = await load();
    await expect(DISCOVERY_READ_TOOLS.discover_services({})).rejects.toThrow(/API_REGISTRY_SERVICE_URL/);
  });
});

describe("test_endpoint is read-only and tenant-scoped", () => {
  it.each([
    [{ path: "/orgs/leads" }, "/orgs/leads"],
    [{ path: "/public/stats", query: "limit=5&q=a b" }, "/public/stats?limit=5&q=a%20b"],
    [{ path: "/v1/campaigns", method: "get" }, "/v1/campaigns"],
  ])("accepts %j → %s", (args, path) => {
    expect(testRunPath(args)).toBe(path);
  });

  it.each([
    [{ path: "/orgs/leads", method: "POST" }, /only GET/],
    [{ path: "/internal/catalogue/steps" }, /only \/orgs\//],
    [{ path: "/v1/internal/x" }, /never test-run/],
    [{ path: "/v1/admin/orgs" }, /never test-run/],
    [{ path: "/orgs/../internal/x" }, /absolute route path/],
    [{ path: "/v1/platform-runs" }, /never test-run/],
  ])("refuses %j", (args, re) => {
    expect(() => testRunPath(args)).toThrow(re);
  });

  it("calls /call/:service with the chat's identity and run id, never a write", async () => {
    fetchMock().mockResolvedValue(res(200, { status: 200, ok: true, data: { leads: [] } }));
    const { testEndpoint } = await load();
    const out = await testEndpoint({ service: "lead", path: "/orgs/leads" }, { orgId: "o", userId: "u", runId: "r", trackingHeaders: { "x-brand-id": "b" } });
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://registry.test/call/lead");
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h).toMatchObject({ "x-api-key": "registry-key", "x-org-id": "o", "x-user-id": "u", "x-brand-id": "b" });
    expect(JSON.parse(init.body as string)).toEqual({ method: "GET", path: "/orgs/leads", headers: { "x-run-id": "r" } });
    expect(out).toMatchObject({ service: "lead", status: 200, ok: true, data: { leads: [] } });
  });

  it("cuts a large body so one test run never floods the chat", () => {
    const big = { rows: "x".repeat(TEST_RESULT_MAX_CHARS * 2) };
    const out = compactTestResult(200, true, big) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect((out.dataPreview as string).length).toBe(TEST_RESULT_MAX_CHARS);
    expect(out.data).toBeUndefined();
    expect(compactTestResult(200, true, { a: 1 })).toEqual({ status: 200, ok: true, data: { a: 1 } });
  });
});
