import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";

// Every platform call states whose work it is (COST-SUPPORT-1024): these tests are support calls.
const TEST_PLATFORM_SUPPORT = { kind: "staff_experiment", reason: "chat-service test" };

// VENDOR-CREDIT-1030: a vendor out of credit reroutes to its declared fallback
// (deepseek-flash -> GLM-5.3 Flash), the run declares the fallback's own cost
// names, and calls return to the primary as soon as a call on it succeeds.

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";
process.env.BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY || "test-billing-key";
process.env.BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "https://billing.test.local";

interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown };
}

interface CostItem {
  costName: string;
  quantity: number;
  status?: string;
  costSource?: string;
}

let routes: MockRoute[] = [];
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function buildResponse(out: { ok: boolean; status?: number; body: unknown }): Response {
  return {
    ok: out.ok,
    status: out.status ?? (out.ok ? 200 : 500),
    json: () => Promise.resolve(out.body),
    text: () =>
      Promise.resolve(typeof out.body === "string" ? out.body : JSON.stringify(out.body)),
    headers: new Headers(),
  } as unknown as Response;
}

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      for (const route of routes) {
        if (route.match(url, init)) return buildResponse(route.respond(url, init));
      }
      throw new Error(`[test] Unmocked fetch: ${url}`);
    }),
  );
}

function mockRunsCostRoutes(cap: { postedItems: CostItem[][]; patchedStatuses: string[] }) {
  return [
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
      respond: (_url: string, init?: RequestInit) => {
        const items = init?.body
          ? (JSON.parse(init.body as string) as { items: CostItem[] }).items
          : [];
        cap.postedItems.push(items);
        return { ok: true, status: 201, body: { costs: items.map((it, i) => ({ id: `cost-${i}`, ...it })) } };
      },
    },
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
      respond: (_url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(init.body as string) as { status: string }) : { status: "?" };
        cap.patchedStatuses.push(body.status);
        return { ok: true, body: { id: "cost-0", status: body.status } };
      },
    },
  ] satisfies MockRoute[];
}

function mockRunsCreate() {
  return {
    match: (url: string, init?: RequestInit) => url.endsWith("/v1/runs") && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: "run-own-1", status: "running" } }),
  } satisfies MockRoute;
}

function mockRunsStatusPatch() {
  return {
    match: (url: string, init?: RequestInit) => /\/v1\/runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: () => ({ ok: true, body: { id: "run-own-1", status: "completed" } }),
  } satisfies MockRoute;
}

/** Org-scoped key lookup for one vendor slug. Any OTHER slug stays unmocked → loud. */
function mockVendorKey(provider: string) {
  return {
    match: (url: string) => url.includes(`/keys/${provider}/decrypt`),
    respond: () => ({ ok: true, body: { provider, key: `fake-${provider}-key`, keySource: "platform" } }),
  } satisfies MockRoute;
}

function mockVendorPlatformKey(provider: string) {
  return {
    match: (url: string) => url.includes(`/keys/platform/${provider}/decrypt`),
    respond: () => ({ ok: true, body: { provider, key: `fake-${provider}-key` } }),
  } satisfies MockRoute;
}

/** Key-service rejects — the shape of an unconfigured vendor key. */
function mockVendorKeyMissing(provider: string, platform = false) {
  const path = platform ? `/keys/platform/${provider}/decrypt` : `/keys/${provider}/decrypt`;
  return {
    match: (url: string) => url.includes(path),
    respond: () => ({ ok: false, status: 404, body: { error: "Key not found" } }),
  } satisfies MockRoute;
}

function mockBilling() {
  return {
    match: (url: string, init?: RequestInit) =>
      url.includes("/v1/customer_balance/authorize") && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, body: { sufficient: true, balance_cents: "100000", required_cents: "1" } }),
  } satisfies MockRoute;
}

function mockPlatformRunCreate() {
  return {
    match: (url: string, init?: RequestInit) => url.endsWith("/v1/platform-runs") && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: "prun-1", status: "running" } }),
  } satisfies MockRoute;
}

function mockPlatformRunCosts(cap: { postedItems: CostItem[][] }) {
  return {
    match: (url: string, init?: RequestInit) =>
      /\/v1\/platform-runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      const items = init?.body ? (JSON.parse(init.body as string) as { items: CostItem[] }).items : [];
      cap.postedItems.push(items);
      return { ok: true, status: 201, body: { costs: items.map((it, i) => ({ id: `cost-${i}`, ...it })) } };
    },
  } satisfies MockRoute;
}

function mockPlatformRunStatus() {
  return {
    match: (url: string, init?: RequestInit) =>
      /\/v1\/platform-runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: () => ({ ok: true, body: { id: "prun-1", status: "completed" } }),
  } satisfies MockRoute;
}

function vendorOk(host: string, model: string, cap: { calls: number }) {
  return {
    match: (url: string) => url.startsWith(host),
    respond: () => {
      cap.calls += 1;
      return {
        ok: true,
        body: { id: "c", model, choices: [{ message: { content: '{"label":"lead_interested"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
      };
    },
  } satisfies MockRoute;
}

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const ZAI_URL = "https://api.z.ai/api/paas/v4/chat/completions";
const INTERNAL_AUTH = { "x-api-key": "test-key" };
const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "parent-run-1" };
const JUDGE = { message: "Reply: yes please send pricing", systemPrompt: "Label the reply.", provider: "deepseek", model: "deepseek-flash", responseFormat: "json", temperature: 0, disableThinking: true };

describe("out of credit: reroute to the declared fallback", () => {
  let app: Awaited<ReturnType<typeof loadApp>>;
  let credit: typeof import("../../src/lib/vendor-credit.js");
  async function loadApp() {
    vi.resetModules();
    return (await import("../../src/index.js")).default;
  }
  beforeAll(async () => {
    app = await loadApp();
    credit = await import("../../src/lib/vendor-credit.js");
  });
  beforeEach(() => {
    routes = [];
    fetchCalls = [];
    installFetchMock();
    credit.resetVendorCredit();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T16:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    credit.resetVendorCredit();
  });

  it("platform-complete: a 402 from DeepSeek is retried once on GLM-5.3 Flash, declared at GLM's price", async () => {
    const costCap = { postedItems: [] as CostItem[][] };
    const statuses: string[] = [];
    const deepseek = { calls: 0 };
    const zai = { calls: 0 };
    routes.push(
      mockVendorPlatformKey("deepseek"),
      mockVendorPlatformKey("zai"),
      mockPlatformRunCreate(),
      mockPlatformRunCosts(costCap),
      {
        match: (url: string, init?: RequestInit) => /\/v1\/platform-runs\/[^/]+$/.test(url) && init?.method === "PATCH",
        respond: (_u: string, init?: RequestInit) => {
          statuses.push(JSON.parse(init!.body as string).status);
          return { ok: true, body: {} };
        },
      },
      {
        match: (url: string) => url.startsWith(DEEPSEEK_URL),
        respond: () => {
          deepseek.calls += 1;
          return { ok: false, status: 402, body: '{"error":{"message":"Insufficient Balance","type":"insufficient_balance_error","param":null,"code":"invalid_request_error"}}' };
        },
      },
      vendorOk(ZAI_URL, "glm-5.3-flash", zai),
    );

    const res = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...JUDGE, support: TEST_PLATFORM_SUPPORT });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe("glm-5.3-flash");
    expect(res.body.fallback).toEqual({ from: "deepseek-flash", reason: "out_of_credit" });
    expect(res.body.json).toEqual({ label: "lead_interested" });
    expect(deepseek.calls).toBe(1);
    expect(zai.calls).toBe(1);
    // First run closed failed with no cost (nothing ran), the retry's run completed.
    expect(statuses).toEqual(["failed", "completed"]);
    const names = costCap.postedItems.flat().map((i) => i.costName);
    expect(names).toEqual(["zai-glm-5.3-flash-tokens-input", "zai-glm-5.3-flash-tokens-output"]);
    expect(credit.isProviderOutOfCredit("deepseek")).toBe(true);

    // While out of credit: straight to the fallback, DeepSeek not asked.
    const res2 = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...JUDGE, support: TEST_PLATFORM_SUPPORT });
    expect(res2.body.model).toBe("glm-5.3-flash");
    expect(deepseek.calls).toBe(1);
    expect(zai.calls).toBe(2);

    // Topped up: the next probe slot goes to DeepSeek, succeeds, and traffic returns.
    routes = routes.filter((r) => !r.match(DEEPSEEK_URL));
    routes.push(vendorOk(DEEPSEEK_URL, "deepseek-flash", deepseek));
    vi.setSystemTime(new Date(Date.now() + credit.PROBE_INTERVAL_MS));
    const res3 = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...JUDGE, support: TEST_PLATFORM_SUPPORT });
    expect(res3.body.model).toBe("deepseek-flash");
    expect(res3.body.fallback).toBeUndefined();
    expect(credit.isProviderOutOfCredit("deepseek")).toBe(false);
  });

  it("fails loud (502) when the fallback's vendor is out of credit too", async () => {
    routes.push(
      mockVendorPlatformKey("deepseek"),
      mockVendorPlatformKey("zai"),
      mockPlatformRunCreate(),
      mockPlatformRunCosts({ postedItems: [] }),
      mockPlatformRunStatus(),
      { match: (url: string) => url.startsWith(DEEPSEEK_URL), respond: () => ({ ok: false, status: 402, body: '{"error":{"message":"Insufficient Balance"}}' }) },
      { match: (url: string) => url.startsWith(ZAI_URL), respond: () => ({ ok: false, status: 429, body: '{"error":{"code":"1113","message":"Insufficient balance or no resource package."}}' }) },
    );
    const res = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...JUDGE, support: TEST_PLATFORM_SUPPORT });
    expect(res.status).toBe(502);
    expect(credit.isProviderOutOfCredit("deepseek")).toBe(true);
    expect(credit.isProviderOutOfCredit("zai")).toBe(true);
  });

  it("/complete on our platform key reroutes the same way and names the fallback", async () => {
    const costCap = { postedItems: [] as CostItem[][], patchedStatuses: [] as string[] };
    const zai = { calls: 0 };
    routes.push(
      mockVendorKey("deepseek"),
      mockVendorKey("zai"),
      mockBilling(),
      mockRunsCreate(),
      mockRunsStatusPatch(),
      ...[mockRunsCostRoutes(costCap)].flat(),
      { match: (url: string) => url.startsWith(DEEPSEEK_URL), respond: () => ({ ok: false, status: 402, body: '{"error":{"message":"Insufficient Balance"}}' }) },
      vendorOk(ZAI_URL, "glm-5.3-flash", zai),
    );
    const { support: _s, ...body } = { ...JUDGE, support: null };
    const res = await request(app).post("/complete").set(AUTH).send(body);
    expect(res.status).toBe(200);
    expect(res.body.model).toBe("glm-5.3-flash");
    expect(res.body.fallback).toEqual({ from: "deepseek-flash", reason: "out_of_credit" });
    const actual = costCap.postedItems.flat().filter((i) => i.status === undefined || i.status === "actual").map((i) => i.costName);
    expect(actual.every((n) => n.startsWith("zai-glm-5.3-flash"))).toBe(true);
  });
});
