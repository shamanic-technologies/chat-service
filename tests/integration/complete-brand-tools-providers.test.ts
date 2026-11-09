import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";

// brandTools on every provider /complete serves (BRAND-MCP-1109 follow-up):
// an Anthropic model runs its own tool-use loop on both tiers, every round's
// spend is declared (org tier: held per round, reconciled to actual; platform
// tier: actual lines), a failure mid-loop still declares the rounds spent, and
// the one combination no provider can serve is a named 400 before any spend.

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";
process.env.BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY || "test-billing-key";
process.env.BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "https://billing.test.local";

const sdk = vi.hoisted(() => ({
  replies: [] as Array<Record<string, unknown> | Error>,
  requests: [] as Array<Record<string, unknown>>,
}));
const brand = vi.hoisted(() => ({ calls: [] as Array<{ name: string; args: unknown }>, loads: 0 }));

vi.mock("@anthropic-ai/sdk", async (importActual) => {
  const actual = await importActual<typeof import("@anthropic-ai/sdk")>();
  class MockAnthropic {
    messages = {
      stream: vi.fn((params: Record<string, unknown>) => {
        sdk.requests.push(JSON.parse(JSON.stringify(params)));
        const next = sdk.replies.shift();
        return {
          finalMessage: async () => {
            if (!next) throw new Error("no scripted reply");
            if (next instanceof Error) throw next;
            return next;
          },
        };
      }),
    };
    static APIError = actual.default.APIError;
  }
  return { ...actual, default: MockAnthropic };
});

// The brand's plugged server, without a DB or a network: one tool.
vi.mock("../../src/lib/brand-mcp.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/brand-mcp.js")>();
  return {
    ...actual,
    loadBrandToolset: vi.fn(async () => {
      brand.loads += 1;
      return {
        tools: [{ name: "crm__get_lead", description: "Read a lead.", input_schema: { type: "object", properties: { email: { type: "string" } } } }],
        servers: [{ id: "s", name: "crm", tools: 1 }],
        has: (n: string) => n === "crm__get_lead",
        call: async (name: string, args: unknown) => {
          brand.calls.push({ name, args });
          return { ok: true, content: "Ava: 2 open deals" };
        },
      };
    }),
  };
});

interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown };
}
type Item = { costName: string; quantity: number; status?: string; costSource?: string };

let routes: MockRoute[] = [];

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      for (const route of routes) {
        if (route.match(url, init)) {
          const out = route.respond(url, init);
          return {
            ok: out.ok,
            status: out.status ?? (out.ok ? 200 : 500),
            json: () => Promise.resolve(out.body),
            text: () => Promise.resolve(JSON.stringify(out.body)),
            headers: new Headers(),
          } as unknown as Response;
        }
      }
      throw new Error(`[test] Unmocked fetch: ${url}`);
    }),
  );
}

const method = (init?: RequestInit) => init?.method ?? "GET";
const bodyOf = (init?: RequestInit) => (init?.body ? JSON.parse(init.body as string) : {});

function orgRoutes(cap: { posted: Item[][]; patched: string[]; authorized: number }) {
  return [
    { match: (u, i) => u.endsWith("/v1/runs") && method(i) === "POST", respond: () => ({ ok: true, status: 201, body: { id: "run-own-1" } }) },
    { match: (u) => u.includes("/keys/anthropic/decrypt"), respond: () => ({ ok: true, body: { provider: "anthropic", key: "k", keySource: "platform" } }) },
    {
      match: (u, i) => u.includes("/v1/customer_balance/authorize") && method(i) === "POST",
      respond: () => {
        cap.authorized += 1;
        return { ok: true, body: { sufficient: true, balance_cents: "100000", required_cents: "1" } };
      },
    },
    {
      match: (u, i) => /\/v1\/runs\/[^/]+\/costs$/.test(u) && method(i) === "POST",
      respond: (_u, i) => {
        const items = bodyOf(i).items as Item[];
        cap.posted.push(items);
        return { ok: true, status: 201, body: { costs: items.map((it, n) => ({ id: `cost-${cap.posted.length}-${n}`, ...it })) } };
      },
    },
    {
      match: (u, i) => /\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(u) && method(i) === "PATCH",
      respond: (_u, i) => {
        cap.patched.push(bodyOf(i).status);
        return { ok: true, body: {} };
      },
    },
    { match: (u, i) => /\/v1\/runs\/[^/]+$/.test(u) && method(i) === "PATCH", respond: () => ({ ok: true, body: {} }) },
    // Run events (traceEvent) are fire-and-forget.
    { match: (u) => u.includes("/events"), respond: () => ({ ok: true, body: {} }) },
  ] satisfies MockRoute[];
}

function platformRoutes(cap: { posted: Item[][]; statuses: string[] }) {
  return [
    { match: (u) => u.includes("/keys/platform/anthropic/decrypt"), respond: () => ({ ok: true, body: { provider: "anthropic", key: "k", keySource: "platform" } }) },
    { match: (u, i) => u.endsWith("/v1/platform-runs") && method(i) === "POST", respond: () => ({ ok: true, status: 201, body: { id: "prun-1" } }) },
    {
      match: (u, i) => /\/v1\/platform-runs\/[^/]+\/costs$/.test(u) && method(i) === "POST",
      respond: (_u, i) => {
        cap.posted.push(bodyOf(i).items as Item[]);
        return { ok: true, status: 201, body: { costs: [] } };
      },
    },
    {
      match: (u, i) => /\/v1\/platform-runs\/[^/]+$/.test(u) && method(i) === "PATCH",
      respond: (_u, i) => {
        cap.statuses.push(bodyOf(i).status);
        return { ok: true, body: {} };
      },
    },
    { match: (u) => u.includes("/events"), respond: () => ({ ok: true, body: {} }) },
  ] satisfies MockRoute[];
}

const AUTH = { "x-api-key": "test-key", "x-org-id": "11111111-1111-4111-8111-111111111111", "x-user-id": "22222222-2222-4222-8222-222222222222", "x-run-id": "parent-run-1" };
const BRAND_ID = "33333333-3333-4333-8333-333333333333";
const schema = { type: "object", properties: { decision: { type: "string" }, body: { type: "string" } }, required: ["decision"] };
const toolRound = () => ({ content: [{ type: "tool_use", id: "tu_1", name: "crm__get_lead", input: { email: "ava@x.com" } }], usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: "tool_use" });
const outputRound = () => ({ content: [{ type: "tool_use", id: "tu_2", name: "return_output", input: { decision: "write", body: "Hi Ava" } }], usage: { input_tokens: 300, output_tokens: 40 }, stop_reason: "tool_use" });

describe("brandTools on an Anthropic model", () => {
  let app: Awaited<ReturnType<typeof loadApp>>;
  async function loadApp() {
    return (await import("../../src/index.js")).default;
  }
  beforeAll(async () => {
    app = await loadApp();
  });
  beforeEach(() => {
    routes = [];
    sdk.replies.splice(0);
    sdk.requests.splice(0);
    brand.calls.splice(0);
    brand.loads = 0;
    installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("/complete: one brand tool round, then the structured output; each round held + authorized, all reconciled to actual", async () => {
    const cap = { posted: [] as Item[][], patched: [] as string[], authorized: 0 };
    routes.push(...orgRoutes(cap));
    sdk.replies.push(toolRound(), outputRound());

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "Lead Ava replied.", systemPrompt: "Write to the lead.", provider: "anthropic", model: "claude-opus", responseSchema: schema, brandTools: { brandId: BRAND_ID } });

    expect(res.status).toBe(200);
    expect(res.body.json).toEqual({ decision: "write", body: "Hi Ava" });
    expect(res.body.brandToolCalls).toBe(1);
    expect(brand.calls).toEqual([{ name: "crm__get_lead", args: { email: "ava@x.com" } }]);
    expect(sdk.requests).toHaveLength(2);
    // Reasoning-first model: never a sampling param.
    for (const r of sdk.requests) expect(r).not.toHaveProperty("temperature");

    // Two rounds → two holds (provisioned) and two authorizations.
    const holds = cap.posted.filter((items) => items.every((i) => i.status === "provisioned"));
    expect(holds).toHaveLength(2);
    expect(cap.authorized).toBe(2);
    // Actual = both rounds summed, Anthropic catalog names.
    const actual = cap.posted.find((items) => items.every((i) => i.status === undefined))!;
    expect(actual.map((i) => [i.costName, i.quantity])).toEqual([
      ["anthropic-opus-5.5-tokens-input", 400],
      ["anthropic-opus-5.5-tokens-output", 60],
    ]);
    // Every hold released.
    expect(cap.patched.filter((s) => s === "cancelled")).toHaveLength(holds.flat().length);
  });

  it("/complete: a provider failure at round 2 still declares round 1 as actual (502, nothing undeclared)", async () => {
    const cap = { posted: [] as Item[][], patched: [] as string[], authorized: 0 };
    routes.push(...orgRoutes(cap));
    sdk.replies.push(toolRound(), new Error("boom"));

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "m", systemPrompt: "s", provider: "anthropic", model: "claude-opus", responseSchema: schema, brandTools: { brandId: BRAND_ID } });

    expect(res.status).toBe(502);
    const actual = cap.posted.find((items) => items.every((i) => i.status === undefined))!;
    expect(actual.map((i) => [i.costName, i.quantity])).toEqual([
      ["anthropic-opus-5.5-tokens-input", 100],
      ["anthropic-opus-5.5-tokens-output", 20],
    ]);
  });

  it("/internal/platform-complete: the loop runs, every round's actual lines posted on the platform run", async () => {
    const cap = { posted: [] as Item[][], statuses: [] as string[] };
    routes.push(...platformRoutes(cap));
    sdk.replies.push(toolRound(), outputRound());

    const res = await request(app)
      .post("/internal/platform-complete")
      .set({ "x-api-key": "test-internal-key" })
      .send({ support: { kind: "staff_experiment", reason: "chat-service test" }, message: "m", systemPrompt: "s", provider: "anthropic", model: "claude-opus", responseSchema: schema, brandTools: { orgId: AUTH["x-org-id"], brandId: BRAND_ID } });

    expect(res.status).toBe(200);
    expect(res.body.json).toEqual({ decision: "write", body: "Hi Ava" });
    expect(res.body.brandToolCalls).toBe(1);
    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].map((i) => [i.costName, i.quantity, i.costSource])).toEqual([
      ["anthropic-opus-5.5-tokens-input", 400, "platform"],
      ["anthropic-opus-5.5-tokens-output", 60, "platform"],
    ]);
    expect(cap.statuses).toEqual(["completed"]);
  });

  it("/internal/platform-complete: a failure mid-loop posts the rounds already spent", async () => {
    const cap = { posted: [] as Item[][], statuses: [] as string[] };
    routes.push(...platformRoutes(cap));
    sdk.replies.push(toolRound(), new Error("boom"));

    const res = await request(app)
      .post("/internal/platform-complete")
      .set({ "x-api-key": "test-internal-key" })
      .send({ support: { kind: "staff_experiment", reason: "chat-service test" }, message: "m", systemPrompt: "s", provider: "anthropic", model: "claude-opus", responseSchema: schema, brandTools: { orgId: AUTH["x-org-id"], brandId: BRAND_ID } });

    expect(res.status).toBe(502);
    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].map((i) => [i.costName, i.quantity])).toEqual([
      ["anthropic-opus-5.5-tokens-input", 100],
      ["anthropic-opus-5.5-tokens-output", 20],
    ]);
    expect(cap.statuses).toEqual(["failed"]);
  });

  it("google + webSearch + brandTools: a named 400 before any key, run or spend", async () => {
    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "m", systemPrompt: "s", provider: "google", model: "flash", webSearch: true, brandTools: { brandId: BRAND_ID } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/webSearch on provider "google"/);
    expect(brand.loads).toBe(0);
  });
});
