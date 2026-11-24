import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";

// OPEN-LLM-FREE-1124 (owner 2026-11-24): open-weight models on the free tiers of Cerebras and Groq. A free tier's
// cap (per minute, per day) must never leave a writer without a completion: on our platform key the call moves down
// the fallback order and names why; a provider whose platform key is not registered yet fails loud, named.

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";
process.env.BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY || "test-billing-key";
process.env.BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "https://billing.test.local";

const TEST_PLATFORM_SUPPORT = { kind: "staff_experiment", reason: "chat-service test" };
const INTERNAL_AUTH = { "x-api-key": "test-key" };
const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "parent-run-1" };
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const ZAI_URL = "https://api.z.ai/api/paas/v4/chat/completions";
const ASK = { message: "Reply: yes please send pricing", systemPrompt: "Label the reply as JSON.", provider: "groq", model: "groq-qwen", responseFormat: "json", temperature: 0 };

interface Out { ok: boolean; status?: number; body: unknown; headers?: Record<string, string> }
interface MockRoute { match: (url: string, init?: RequestInit) => boolean; respond: (url: string, init?: RequestInit) => Out }
interface CostItem { costName: string; quantity: number; status?: string; costSource?: string }

let routes: MockRoute[] = [];
let fetchCalls: string[] = [];

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push(url);
      for (const route of routes) {
        if (!route.match(url, init)) continue;
        const out = route.respond(url, init);
        return {
          ok: out.ok,
          status: out.status ?? (out.ok ? 200 : 500),
          json: () => Promise.resolve(out.body),
          text: () => Promise.resolve(typeof out.body === "string" ? out.body : JSON.stringify(out.body)),
          headers: new Headers(out.headers ?? {}),
        } as unknown as Response;
      }
      throw new Error(`[test] Unmocked fetch: ${url}`);
    }),
  );
}

function vendorOk(host: string, model: string, cap: { calls: number }): MockRoute {
  return {
    match: (url) => url.startsWith(host),
    respond: () => {
      cap.calls += 1;
      return { ok: true, body: { id: "c", model, choices: [{ message: { content: '{"label":"lead_interested"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } } };
    },
  };
}

function groqRefuses(cap: { calls: number }, status: number, body: string, headers: Record<string, string> = {}): MockRoute {
  return { match: (url) => url.startsWith(GROQ_URL), respond: () => { cap.calls += 1; return { ok: false, status, body, headers }; } };
}

/** Platform runs + costs (the /internal/platform-complete path), capturing declared cost names. */
function platformRuns(cap: { names: string[] }): MockRoute[] {
  return [
    { match: (u, i) => u.endsWith("/v1/platform-runs") && i?.method === "POST", respond: () => ({ ok: true, status: 201, body: { id: "prun-1", status: "running" } }) },
    {
      match: (u, i) => /\/v1\/platform-runs\/[^/]+\/costs$/.test(u) && i?.method === "POST",
      respond: (_u, i) => {
        const items = (JSON.parse(i!.body as string) as { items: CostItem[] }).items;
        cap.names.push(...items.map((it) => it.costName));
        return { ok: true, status: 201, body: { costs: items.map((it, n) => ({ id: `cost-${n}`, ...it })) } };
      },
    },
    { match: (u, i) => /\/v1\/platform-runs\/[^/]+$/.test(u) && i?.method === "PATCH", respond: () => ({ ok: true, body: {} }) },
  ];
}

/** Org runs + costs + billing (the /complete path). */
function orgRuns(): MockRoute[] {
  return [
    { match: (u, i) => u.includes("/v1/customer_balance/authorize") && i?.method === "POST", respond: () => ({ ok: true, body: { sufficient: true, balance_cents: "100000", required_cents: "1" } }) },
    { match: (u, i) => u.endsWith("/v1/runs") && i?.method === "POST", respond: () => ({ ok: true, status: 201, body: { id: "run-own-1", status: "running" } }) },
    { match: (u, i) => /\/v1\/runs\/[^/]+$/.test(u) && i?.method === "PATCH", respond: () => ({ ok: true, body: { id: "run-own-1", status: "completed" } }) },
    {
      match: (u, i) => /\/v1\/runs\/[^/]+\/costs$/.test(u) && i?.method === "POST",
      respond: (_u, i) => {
        const items = (JSON.parse(i!.body as string) as { items: CostItem[] }).items;
        return { ok: true, status: 201, body: { costs: items.map((it, n) => ({ id: `cost-${n}`, ...it })) } };
      },
    },
    { match: (u, i) => /\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(u) && i?.method === "PATCH", respond: () => ({ ok: true, body: { id: "cost-0" } }) },
  ];
}

/** Every platform key present (key-service decrypt), except the providers listed missing (key-service 404). */
function platformKeys(missing: string[] = []): MockRoute {
  return {
    match: (u) => /\/keys\/platform\/[^/]+\/decrypt/.test(u),
    respond: (u) => {
      const provider = /\/keys\/platform\/([^/]+)\/decrypt/.exec(u)![1];
      if (missing.includes(provider)) return { ok: false, status: 404, body: { error: `No platform key configured for provider '${provider}'` } };
      return { ok: true, body: { provider, key: `fake-${provider}-key` } };
    },
  };
}

/** Org-scoped key resolution; `source` says whose key key-service resolved. */
function orgScopedKeys(source: "org" | "platform"): MockRoute {
  return {
    match: (u) => /\/keys\/[^/]+\/decrypt/.test(u) && !u.includes("/keys/platform/"),
    respond: (u) => {
      const provider = /\/keys\/([^/]+)\/decrypt/.exec(u)![1];
      return { ok: true, body: { provider, key: `fake-${provider}-key`, keySource: source } };
    },
  };
}

import { LIST_PRICES_2026_11_08 } from "../unit/llm-list-prices.fixture.js";

describe("a free-tier cap moves the call down the fallback order (OPEN-LLM-FREE-1124)", () => {
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
    credit.setFallbackPrices(LIST_PRICES_2026_11_08);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    credit.resetVendorCredit();
  });

  /** Every other vendor answers, so whichever the order picks serves the call. */
  function othersServe(cap: { calls: number }): MockRoute[] {
    return [vendorOk(DEEPSEEK_URL, "deepseek-flash", cap), vendorOk(ZAI_URL, "glm-5.3-flash", cap)];
  }

  it("a daily cap (Retry-After of minutes): no retry, served by the next model, `fallback.reason: quota_exhausted`", async () => {
    const groq = { calls: 0 };
    const others = { calls: 0 };
    const costs = { names: [] as string[] };
    routes.push(
      platformKeys(),
      ...platformRuns(costs),
      groqRefuses(groq, 429, JSON.stringify({ error: { message: "Rate limit reached for model `qwen/qwen3.8-27b` on tokens per day (TPD): Limit 200000, Used 199990. Please try again in 7m12s.", type: "tokens" } }), { "retry-after": "432" }),
      ...othersServe(others),
    );
    const res = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...ASK, support: TEST_PLATFORM_SUPPORT });
    expect(res.status).toBe(200);
    expect(res.body.fallback).toEqual({ from: "qwen/qwen3.8-27b", reason: "quota_exhausted" });
    expect(res.body.json).toEqual({ label: "lead_interested" });
    expect(groq.calls).toBe(1);
    expect(others.calls).toBe(1);
    // The model that ran is the one billed (the Rating credits it): never a Groq name.
    expect(costs.names.length).toBeGreaterThan(0);
    expect(costs.names.some((n) => n.startsWith("groq-"))).toBe(false);
    // A cap is not a broken vendor: no out-of-credit outage is stored.
    expect(credit.isProviderOutOfCredit("groq")).toBe(false);
  });

  it("a per-day cap named in the body with no Retry-After moves down the same way", async () => {
    const groq = { calls: 0 };
    const others = { calls: 0 };
    routes.push(
      platformKeys(),
      ...platformRuns({ names: [] }),
      groqRefuses(groq, 429, JSON.stringify({ error: { message: "Rate limit reached on requests per day (RPD): Limit 1000, Used 1000." } })),
      ...othersServe(others),
    );
    const res = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...ASK, support: TEST_PLATFORM_SUPPORT });
    expect(res.status).toBe(200);
    expect(res.body.fallback.reason).toBe("quota_exhausted");
    expect(groq.calls).toBe(1);
  });

  it("a per-minute cap is retried first, then moves down once the retries are spent (`rate_limited`)", async () => {
    const groq = { calls: 0 };
    const others = { calls: 0 };
    routes.push(
      platformKeys(),
      ...platformRuns({ names: [] }),
      groqRefuses(groq, 429, JSON.stringify({ error: { message: "Rate limit reached on tokens per minute (TPM): Limit 8000." } }), { "retry-after": "0.05" }),
      ...othersServe(others),
    );
    const res = await request(app).post("/internal/platform-complete").set(INTERNAL_AUTH).send({ ...ASK, support: TEST_PLATFORM_SUPPORT });
    expect(res.status).toBe(200);
    expect(res.body.fallback).toEqual({ from: "qwen/qwen3.8-27b", reason: "rate_limited" });
    expect(groq.calls).toBeGreaterThan(1);
    expect(others.calls).toBe(1);
  }, 30_000);

  it("/complete on an org's OWN key: the cap is the caller's answer, a named 429", async () => {
    const groq = { calls: 0 };
    const others = { calls: 0 };
    routes.push(
      orgScopedKeys("org"),
      ...orgRuns(),
      groqRefuses(groq, 429, JSON.stringify({ error: { message: "Rate limit reached on tokens per day (TPD)." } }), { "retry-after": "600" }),
      ...othersServe(others),
    );
    const res = await request(app).post("/complete").set(AUTH).send(ASK);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "Provider quota is exhausted for this model.", retryable: true, retryAfterSeconds: 600 });
    expect(others.calls).toBe(0);
  });

  it("/complete on our platform key moves down like the platform route", async () => {
    const others = { calls: 0 };
    routes.push(
      orgScopedKeys("platform"),
      ...orgRuns(),
      groqRefuses({ calls: 0 }, 429, JSON.stringify({ error: { message: "tokens per day (TPD)" } }), { "retry-after": "600" }),
      ...othersServe(others),
    );
    const res = await request(app).post("/complete").set(AUTH).send(ASK);
    expect(res.status).toBe(200);
    expect(res.body.fallback).toEqual({ from: "qwen/qwen3.8-27b", reason: "quota_exhausted" });
  });

  it("no platform key registered yet: a NAMED 502 (`platform_key_missing`), no vendor called, no silent fallback", async () => {
    const others = { calls: 0 };
    const cerebras = { calls: 0 };
    routes.push(platformKeys(["cerebras"]), ...platformRuns({ names: [] }), vendorOk(CEREBRAS_URL, "gpt-oss-120b", cerebras), ...othersServe(others));
    const res = await request(app)
      .post("/internal/platform-complete")
      .set(INTERNAL_AUTH)
      .send({ ...ASK, provider: "cerebras", model: "cerebras-gpt-oss", support: TEST_PLATFORM_SUPPORT });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "platform_key_missing", provider: "cerebras", retryable: false });
    expect(res.body.error).toMatch(/Cerebras API key \(key-service provider "cerebras"\)/);
    expect(cerebras.calls).toBe(0);
    expect(others.calls).toBe(0);
  });
});
