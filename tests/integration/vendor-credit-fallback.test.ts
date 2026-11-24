import { loadRegimeCatalogue } from "../regime-hours.fixture.js";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";

// Every platform call states whose work it is (COST-SUPPORT-1024): these tests are support calls.
const TEST_PLATFORM_SUPPORT = { kind: "staff_experiment", reason: "chat-service test" };

// VENDOR-CREDIT-1030 + LLM-CREDIT-GENERIC-1108: a vendor out of credit reroutes
// to the cheapest same-tier model on a vendor with credit that takes the request
// (deepseek-flash JSON-without-schema -> GLM-5.3 Flash; Gemini Flash-Lite the
// same way), the run declares the fallback's own cost names, and calls return to
// the primary as soon as a call on it succeeds.

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

import { LIST_PRICES_2026_11_08 } from "../unit/llm-list-prices.fixture.js";

describe("out of credit: reroute to the cheapest model that takes the request", () => {
  let app: Awaited<ReturnType<typeof loadApp>>;
  let credit: typeof import("../../src/lib/vendor-credit.js");
  async function loadApp() {
    vi.resetModules();
    await loadRegimeCatalogue();
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
    credit.setFallbackPrices(LIST_PRICES_2026_11_08);
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

  it("/complete: Gemini Flash-Lite with an empty prepay balance is rerouted (the 2026-11-07 outage, no declared entry)", async () => {
    const costCap = { postedItems: [] as CostItem[][], patchedStatuses: [] as string[] };
    const zai = { calls: 0 };
    const gemini = { calls: 0 };
    routes.push(
      mockVendorKey("google"),
      mockVendorKey("zai"),
      mockBilling(),
      mockRunsCreate(),
      mockRunsStatusPatch(),
      ...[mockRunsCostRoutes(costCap)].flat(),
      {
        match: (url: string) => url.startsWith("https://generativelanguage.googleapis.com/"),
        respond: () => {
          gemini.calls += 1;
          return {
            ok: false,
            status: 402,
            body: '{"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.","status":"RESOURCE_EXHAUSTED"}}',
          };
        },
      },
      vendorOk(ZAI_URL, "glm-5.3-flash", zai),
    );
    const body = { message: "Read this lead.", systemPrompt: "Answer in JSON.", provider: "google", model: "gemini-flash-lite", responseFormat: "json" };
    const res = await request(app).post("/complete").set(AUTH).send(body);
    expect(res.status).toBe(200);
    expect(res.body.model).toBe("glm-5.3-flash");
    expect(res.body.fallback).toEqual({ from: "gemini-3.5-flash-lite", reason: "out_of_credit" });
    expect(credit.isProviderOutOfCredit("google")).toBe(true);
    // While Google is dry: straight to the fallback, Gemini not asked again.
    const res2 = await request(app).post("/complete").set(AUTH).send(body);
    expect(res2.body.model).toBe("glm-5.3-flash");
    expect(gemini.calls).toBe(1);
    expect(zai.calls).toBe(2);
    const actual = costCap.postedItems.flat().filter((i) => i.status === undefined || i.status === "actual").map((i) => i.costName);
    expect(actual.every((n) => n.startsWith("zai-glm-5.3-flash"))).toBe(true);
  });
});

// FALLBACK-REFUSED-1124 (owner 2026-11-24: « il faut prendre le deuxième meilleur quand ça arrive »). Prod
// 11-17..11-24: a call refused for credit ran on ONE fallback, ONCE. 148 calls died on a fallback that refused
// the request's shape (Kimi -> Haiku), others on a fallback that ran dry in the same minute. Every failure of
// a fallback now hands the call to the next model of the order; a refused call is one NO model served.
describe("out of credit: the call goes DOWN the fallback order, never fails while a model serves", () => {
  const MOONSHOT_URL = "https://api.moonshot.ai/v1/chat/completions";
  // Three priced models = a known order for a plain JSON call on deepseek-flash: GLM-5.3 Flash, then Kimi K2.6.
  const THREE_MODELS = LIST_PRICES_2026_11_08.filter((p) => /^(deepseek-v4\.1-flash|zai-glm-5\.3-flash|moonshot-kimi-k2\.6)-/.test(p.name));
  const CALL = { message: "Reply: yes please send pricing", systemPrompt: "Label the reply.", provider: "deepseek", model: "deepseek-flash", responseFormat: "json" };
  const DRY_DEEPSEEK = { match: (url: string) => url.startsWith(DEEPSEEK_URL), respond: () => ({ ok: false, status: 402, body: '{"error":{"message":"Insufficient Balance","type":"insufficient_balance_error"}}' }) } satisfies MockRoute;
  const DRY_ZAI = { match: (url: string) => url.startsWith(ZAI_URL), respond: () => ({ ok: false, status: 429, body: '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}' }) } satisfies MockRoute;
  const DRY_MOONSHOT = { match: (url: string) => url.startsWith(MOONSHOT_URL), respond: () => ({ ok: false, status: 429, body: '{"error":{"message":"Your account org-x is suspended due to insufficient balance, please recharge your account or check your plan and billing details","type":"exceeded_current_quota_error"}}' }) } satisfies MockRoute;

  let app: Awaited<ReturnType<typeof loadApp>>;
  let credit: typeof import("../../src/lib/vendor-credit.js");
  let stored: string[];
  async function loadApp() {
    vi.resetModules();
    await loadRegimeCatalogue();
    return (await import("../../src/index.js")).default;
  }
  function platformRoutes(statuses: string[]): MockRoute[] {
    return [
      mockVendorPlatformKey("deepseek"),
      mockVendorPlatformKey("zai"),
      mockVendorPlatformKey("moonshot"),
      mockPlatformRunCreate(),
      mockPlatformRunCosts({ postedItems: [] }),
      {
        match: (url: string, init?: RequestInit) => /\/v1\/platform-runs\/[^/]+$/.test(url) && init?.method === "PATCH",
        respond: (_u: string, init?: RequestInit) => {
          statuses.push(JSON.parse(init!.body as string).status);
          return { ok: true, body: {} };
        },
      },
    ];
  }
  function orgRoutes(): MockRoute[] {
    return [mockVendorKey("deepseek"), mockVendorKey("zai"), mockVendorKey("moonshot"), mockVendorKey("google"), mockBilling(), mockRunsCreate(), mockRunsStatusPatch(), ...mockRunsCostRoutes({ postedItems: [], patchedStatuses: [] })];
  }
  beforeAll(async () => {
    app = await loadApp();
    credit = await import("../../src/lib/vendor-credit.js");
  });
  beforeEach(async () => {
    routes = [];
    fetchCalls = [];
    installFetchMock();
    credit.resetVendorCredit();
    stored = [];
    await credit.initVendorCredit({
      recordRefusal: async (i) => void stored.push(`refusal:${i.provider}`),
      recordReroute: async (i) => void stored.push(`reroute:${i.provider}`),
      recordUnserved: async (i) => void stored.push(`unserved:${i.provider}`),
      closeOutage: async (i) => void stored.push(`close:${i.provider}`),
      loadOpen: async () => [],
    });
    credit.setFallbackPrices(THREE_MODELS);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T05:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    credit.resetVendorCredit();
  });

  it("platform-complete: the fallback's vendor runs dry in the same request, the call runs on the NEXT model", async () => {
    const statuses: string[] = [];
    const kimi = { calls: 0 };
    routes.push(...platformRoutes(statuses), DRY_DEEPSEEK, DRY_ZAI, vendorOk(MOONSHOT_URL, "kimi-k2.6", kimi));

    const res = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...CALL, support: TEST_PLATFORM_SUPPORT });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe("kimi-k2.6");
    expect(res.body.fallback).toEqual({ from: "deepseek-flash", reason: "out_of_credit" });
    expect(kimi.calls).toBe(1);
    // Each model that refused closed its own run failed; the one that served completed.
    expect(statuses).toEqual(["failed", "failed", "completed"]);
    expect(credit.isProviderOutOfCredit("deepseek")).toBe(true);
    expect(credit.isProviderOutOfCredit("zai")).toBe(true);
    // Served = rerouted. No refused call is counted: a model served it.
    expect(stored).toContain("reroute:deepseek");
    expect(stored.filter((s) => s.startsWith("unserved"))).toEqual([]);

    // The next call skips both dry vendors without asking them.
    const before = fetchCalls.length;
    const res2 = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...CALL, support: TEST_PLATFORM_SUPPORT });
    expect(res2.body.model).toBe("kimi-k2.6");
    expect(fetchCalls.slice(before).some((c) => c.url.startsWith(DEEPSEEK_URL) || c.url.startsWith(ZAI_URL))).toBe(false);
  });

  it("/complete with a pinned model and a responseSchema: a fallback that refuses the request's shape hands it to the next model", async () => {
    const kimi = { calls: 0 };
    const zai = { calls: 0 };
    routes.push(
      ...orgRoutes(),
      DRY_DEEPSEEK,
      {
        match: (url: string) => url.startsWith(ZAI_URL),
        respond: () => {
          zai.calls += 1;
          return { ok: false, status: 400, body: '{"error":{"code":"1210","message":"Invalid API parameter, please check the documentation."}}' };
        },
      },
      vendorOk(MOONSHOT_URL, "kimi-k2.6", kimi),
    );
    const { responseFormat: _f, ...call } = CALL;
    const body = { ...call, responseSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } };

    const res = await request(app).post("/complete").set(AUTH).send(body);

    expect(res.status).toBe(200);
    expect(res.body.model).toBe("kimi-k2.6");
    expect(res.body.fallback).toEqual({ from: "deepseek-flash", reason: "out_of_credit" });
    expect(res.body.json).toEqual({ label: "lead_interested" });
    expect(zai.calls).toBe(1);
    // Z.ai refused a shape, not for credit: it is not out of credit.
    expect(credit.isProviderOutOfCredit("zai")).toBe(false);
    expect(stored.filter((s) => s.startsWith("unserved"))).toEqual([]);
  });

  it("/complete: a fallback that is DOWN (5xx) hands the call to the next model too", async () => {
    const kimi = { calls: 0 };
    routes.push(...orgRoutes(), DRY_DEEPSEEK, { match: (url: string) => url.startsWith(ZAI_URL), respond: () => ({ ok: false, status: 502, body: "<html><head><title>502 Bad Gateway</title></head></html>" }) }, vendorOk(MOONSHOT_URL, "kimi-k2.6", kimi));
    const res = await request(app).post("/complete").set(AUTH).send(CALL);
    expect(res.status).toBe(200);
    expect(res.body.model).toBe("kimi-k2.6");
    expect(kimi.calls).toBe(1);
  });

  it("a primary that fails for another reason than credit is the caller's own failure: no detour", async () => {
    const zai = { calls: 0 };
    routes.push(...orgRoutes(), { match: (url: string) => url.startsWith(DEEPSEEK_URL), respond: () => ({ ok: false, status: 400, body: '{"error":{"message":"Invalid parameter"}}' }) }, vendorOk(ZAI_URL, "glm-5.3-flash", zai));
    const res = await request(app).post("/complete").set(AUTH).send(CALL);
    expect(res.status).toBe(400);
    expect(zai.calls).toBe(0);
    expect(stored).toEqual([]);
  });

  it("every model of the order is out of credit: a NAMED error (never the vendor's raw words), counted refused once", async () => {
    const statuses: string[] = [];
    routes.push(...platformRoutes(statuses), DRY_DEEPSEEK, DRY_ZAI, DRY_MOONSHOT);

    const res = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...CALL, support: TEST_PLATFORM_SUPPORT });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: "no_serving_model",
      requestedModel: "deepseek-flash",
      outOfCredit: ["deepseek", "zai", "moonshot"],
      tried: ["deepseek-flash", "glm-5.3-flash", "kimi-k2.6"],
      retryable: false,
    });
    expect(res.body.error).toContain("No model can serve this request");
    expect(JSON.stringify(res.body)).not.toContain("Insufficient");
    expect(statuses).toEqual(["failed", "failed", "failed"]);
    expect(stored.filter((s) => s.startsWith("unserved"))).toEqual(["unserved:deepseek"]);

    // While every vendor is dry the call still names itself, and is counted once more.
    const res2 = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...CALL, support: TEST_PLATFORM_SUPPORT });
    expect(res2.body.code).toBe("no_serving_model");
    expect(stored.filter((s) => s.startsWith("unserved"))).toEqual(["unserved:deepseek", "unserved:deepseek"]);
  });

  it("/complete: a request shape no other model takes (web search, Anthropic dry too) is the named error, counted refused", async () => {
    credit.setFallbackPrices(LIST_PRICES_2026_11_08);
    credit.recordOutOfCredit({ provider: "anthropic", model: "claude-haiku-5-5", status: 400, message: "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC." });
    routes.push(
      ...orgRoutes(),
      {
        match: (url: string) => url.startsWith("https://generativelanguage.googleapis.com/"),
        respond: () => ({ ok: false, status: 402, body: '{"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.","status":"RESOURCE_EXHAUSTED"}}' }),
      },
    );
    const res = await request(app).post("/complete").set(AUTH).send({ message: "Who runs this company?", systemPrompt: "Answer with sources.", provider: "google", model: "gemini-flash-lite", webSearch: true });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "no_serving_model", requestedModel: "gemini-3.5-flash-lite", tried: ["gemini-3.5-flash-lite"], retryable: false });
    expect(res.body.outOfCredit).toEqual(["anthropic", "google"]);
    expect(stored.filter((s) => s.startsWith("unserved"))).toEqual(["unserved:google"]);
  });

  it("a call stops after four models: the order is bounded", async () => {
    credit.setFallbackPrices(LIST_PRICES_2026_11_08);
    const hosts = new Set<string>();
    routes.push(...platformRoutes([]), {
      // Every vendor is down (not dry): each fallback fails, the call moves on, four models at most.
      match: (url: string) => /deepseek\.com|z\.ai|moonshot\.ai|openai\.com|googleapis\.com|anthropic\.com/.test(url) && !url.includes("/keys/"),
      respond: (url: string) => {
        hosts.add(new URL(url).host);
        return url.startsWith(DEEPSEEK_URL) ? DRY_DEEPSEEK.respond() : { ok: false, status: 400, body: '{"error":{"message":"refused"}}' };
      },
    }, { match: (url: string) => url.includes("/keys/platform/"), respond: (url: string) => ({ ok: true, body: { provider: "x", key: `fake-${url.length}` } }) });
    const res = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...CALL, support: TEST_PLATFORM_SUPPORT });
    expect(res.status).toBe(400);
    const llmCalls = fetchCalls.filter((c) => /chat\/completions|\/responses|generateContent|v1\/messages/.test(c.url)).length;
    expect(llmCalls).toBe(4);
    expect(hosts.size).toBeGreaterThanOrEqual(3);
    expect(stored.filter((s) => s.startsWith("unserved"))).toEqual(["unserved:deepseek"]);
  });
});

