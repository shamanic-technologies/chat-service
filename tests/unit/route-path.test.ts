import { describe, it, expect } from "vitest";
import { assertSafeRoutePath, UnsafeRoutePathError } from "../../src/lib/route-path.js";
import { testRunPath, TestRunRefusedError } from "../../src/lib/discovery-client.js";
import { buildRead } from "../../src/agent/outcome-tools.js";

// SSRF-1127: a model-built path never leaves the route it names, whatever its spelling.
const ESCAPES = [
  "/v1/x/../internal/keys",
  "/v1/x/%2e%2e/internal/keys",
  "/v1/x/%2E%2e/internal/keys",
  "/v1/x/.%2e/internal/keys",
  "/v1/x/%2e./internal/keys",
  "/v1/x/%252e%252e/internal/keys",
  "/v1/x/%25252e%25252e/internal/keys",
  "/v1/x/..%2finternal/keys",
  "/v1/x/%2e%2e%2finternal%2fkeys",
  "/v1/x\\..\\internal",
  "/v1/x%5c..%5cinternal",
  "/v1/x/./y",
  "/v1/x/%2e/y",
  "/v1//internal",
  "/v1/x%3f/../internal",
  "/v1/x/%00",
];

describe("assertSafeRoutePath", () => {
  it.each(ESCAPES)("refuses %s", (path) => {
    expect(() => assertSafeRoutePath(path)).toThrow(UnsafeRoutePathError);
  });

  it("refuses broken percent-encoding and a relative path", () => {
    expect(() => assertSafeRoutePath("/v1/%zz")).toThrow(UnsafeRoutePathError);
    expect(() => assertSafeRoutePath("v1/leads")).toThrow(UnsafeRoutePathError);
  });

  it("keeps plain routes and their query (data, not a location)", () => {
    expect(assertSafeRoutePath("/v1/leads/abc-123")).toBe("/v1/leads/abc-123");
    expect(assertSafeRoutePath("/v1/leads/?q=../x")).toBe("/v1/leads/");
    expect(assertSafeRoutePath("/v1/brands/a%20b")).toBe("/v1/brands/a b");
    expect(assertSafeRoutePath("/orgs/file.v2.json")).toBe("/orgs/file.v2.json");
  });

  it("names a 400", () => {
    try {
      assertSafeRoutePath("/v1/%2e%2e/internal");
    } catch (err) {
      expect((err as UnsafeRoutePathError).statusCode).toBe(400);
    }
  });
});

describe("test_endpoint scope is checked on the decoded path", () => {
  it.each([
    "/v1/brands/%2e%2e/%2e%2e/internal/users",
    "/orgs/x/%2E%2E/%2e%2e/admin/thing",
    "/public/%252e%252e/internal/x",
    "/v1/a\\..\\..\\internal",
    "/v1/%69nternal/keys",
    "/v1/x/%2finternal%2fkeys",
  ])("refuses %s", (path) => {
    expect(() => testRunPath({ method: "GET", path })).toThrow(TestRunRefusedError);
  });

  it("still runs a plain org route", () => {
    expect(testRunPath({ method: "GET", path: "/v1/leads", query: "limit=5" })).toBe("/v1/leads?limit=5");
  });
});

describe("get_units read with a dot-segment param", () => {
  const op = { service: "lead-service", method: "GET", path: "/orgs/leads/{id}/timeline" } as unknown as Parameters<typeof buildRead>[0];
  it.each(["..", "."])("refuses param %s", (id) => {
    expect(() => buildRead(op, { params: { id } })).toThrow(UnsafeRoutePathError);
  });
  it("keeps a real id", () => {
    expect(buildRead(op, { params: { id: "abc" } }).path).toBe("/orgs/leads/abc/timeline");
  });
});

describe("apiServiceFetch (admin key) refuses an escaping path before any request", () => {
  it("throws and sends nothing", async () => {
    const { vi } = await import("vitest");
    process.env.ADMIN_DISTRIBUTE_API_KEY = "admin-test";
    vi.resetModules();
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { apiServiceFetch } = await import("../../src/lib/api-client.js");
    expect(() => apiServiceFetch("/v1/leads/%2e%2e/%2e%2e/internal/x", "GET", { orgId: "o", userId: "u", runId: "r" })).toThrow(/dot-segment/);
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
