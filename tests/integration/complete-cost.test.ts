import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";

// /complete cost flow: provision (worst case) → authorize (platform) → execute →
// reconcile (POST actual real tokens + cancel the provisioned holds). google provider
// (fetch-mockable, non-streaming, no DB).

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

// Captures every POST /v1/runs/:id/costs body (provision AND actual) + every cost-status
// PATCH. `provisionStatus` forces a runs-service rejection on the provision POST.
function mockRunsCostRoutes(cap: {
  postedItems: Array<Array<{ costName: string; quantity: number; status?: string }>>;
  patchedStatuses: string[];
  provisionStatus?: number;
}) {
  return [
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
      respond: (_url: string, init?: RequestInit) => {
        const items = init?.body
          ? (JSON.parse(init.body as string) as { items: Array<{ costName: string; quantity: number; status?: string }> }).items
          : [];
        cap.postedItems.push(items);
        const isProvision = items[0]?.status === "provisioned";
        if (isProvision && cap.provisionStatus && cap.provisionStatus >= 400) {
          return { ok: false, status: cap.provisionStatus, body: { error: "Unknown cost name" } };
        }
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

function mockKeyDecrypt() {
  return {
    match: (url: string) => url.includes("/keys/google/decrypt"),
    respond: () => ({ ok: true, body: { provider: "google", key: "fake-google-key", keySource: "platform" } }),
  } satisfies MockRoute;
}

function mockBilling(opts?: { sufficient?: boolean }) {
  return {
    match: (url: string, init?: RequestInit) =>
      url.includes("/v1/customer_balance/authorize") && (init?.method ?? "GET") === "POST",
    respond: () => ({
      ok: true,
      body: { sufficient: opts?.sufficient ?? true, balance_cents: "100000", required_cents: "1" },
    }),
  } satisfies MockRoute;
}

function mockGeminiComplete(cap: { calls: number }) {
  return {
    match: (url: string) => url.includes(":generateContent") && url.includes("generativelanguage.googleapis.com"),
    respond: () => {
      cap.calls += 1;
      return {
        ok: true,
        body: {
          candidates: [{ content: { parts: [{ text: "hello world" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      };
    },
  } satisfies MockRoute;
}

// Grounded Gemini response: 3 search queries + 1 source chunk.
function mockGeminiGrounded(cap: { calls: number }) {
  return {
    match: (url: string) => url.includes(":generateContent") && url.includes("generativelanguage.googleapis.com"),
    respond: () => {
      cap.calls += 1;
      return {
        ok: true,
        body: {
          candidates: [
            {
              content: { parts: [{ text: "Live answer." }] },
              finishReason: "STOP",
              groundingMetadata: {
                webSearchQueries: ["q1", "q2", "q3"],
                groundingChunks: [{ web: { uri: "https://src.example/1", title: "Src 1" } }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      };
    },
  } satisfies MockRoute;
}

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "parent-run-1" };

describe("POST /complete — cost provision → authorize → execute → reconcile", () => {
  let app: Awaited<ReturnType<typeof loadApp>>;
  async function loadApp() {
    vi.resetModules();
    return (await import("../../src/index.js")).default;
  }
  beforeAll(async () => {
    app = await loadApp();
  });
  beforeEach(() => {
    routes = [];
    fetchCalls = [];
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  it("provisions worst-case before the call, then records actual real tokens + cancels the holds", async () => {
    const cap = { postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string }>>, patchedStatuses: [] as string[] };
    const gemini = { calls: 0 };
    routes.push(mockRunsCreate(), mockKeyDecrypt(), mockBilling(), mockGeminiComplete(gemini), ...mockRunsCostRoutes(cap), mockRunsStatusPatch());

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "be brief", provider: "google", model: "flash" });

    expect(res.status).toBe(200);
    expect(gemini.calls).toBe(1);

    // PROVISION: first POST /costs is 2 worst-case items, status "provisioned".
    const provision = cap.postedItems[0];
    expect(provision).toHaveLength(2);
    expect(provision.every((i) => i.status === "provisioned")).toBe(true);
    expect(provision.map((i) => i.costName).sort()).toEqual([
      "google-flash-3-tokens-input",
      "google-flash-3-tokens-output",
    ]);
    // Output provisioned at the worst-case budget (64k), not the real 5.
    expect(provision.find((i) => i.costName.endsWith("output"))!.quantity).toBe(64_000);

    // ORDER: provision precedes the Gemini call.
    const provisionIdx = fetchCalls.findIndex(
      (c) => /\/v1\/runs\/[^/]+\/costs$/.test(c.url) && (c.init?.method ?? "GET") === "POST",
    );
    const llmIdx = fetchCalls.findIndex((c) => c.url.includes(":generateContent"));
    expect(provisionIdx).toBeGreaterThanOrEqual(0);
    expect(llmIdx).toBeGreaterThan(provisionIdx);

    // ACTUAL: a later POST /costs records the REAL tokens (10 in / 5 out), no provisioned status.
    const actual = cap.postedItems.find((items) => items.some((i) => i.status === undefined));
    expect(actual).toBeDefined();
    expect(actual!.find((i) => i.costName.endsWith("input"))!.quantity).toBe(10);
    expect(actual!.find((i) => i.costName.endsWith("output"))!.quantity).toBe(5);

    // RECONCILE: the 2 provisioned holds are cancelled.
    expect(cap.patchedStatuses.filter((s) => s === "cancelled")).toHaveLength(2);
  });

  it("fails loud (502) and does NOT call the model when provision is rejected", async () => {
    const cap = { postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string }>>, patchedStatuses: [] as string[], provisionStatus: 422 };
    const gemini = { calls: 0 };
    routes.push(mockRunsCreate(), mockKeyDecrypt(), mockBilling(), mockGeminiComplete(gemini), ...mockRunsCostRoutes(cap), mockRunsStatusPatch());

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "be brief", provider: "google", model: "flash" });

    expect(res.status).toBe(502);
    expect(gemini.calls).toBe(0);
  });

  it("webSearch:true provisions + authorizes + actuals the google-search-query cost and appends Sources", async () => {
    const cap = { postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string }>>, patchedStatuses: [] as string[] };
    const gemini = { calls: 0 };
    routes.push(mockRunsCreate(), mockKeyDecrypt(), mockBilling(), mockGeminiGrounded(gemini), ...mockRunsCostRoutes(cap), mockRunsStatusPatch());

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "who won?", systemPrompt: "be brief", provider: "google", model: "flash", webSearch: true });

    expect(res.status).toBe(200);
    expect(gemini.calls).toBe(1);

    // PROVISION: 3 worst-case items incl the google-search-query hold (qty 20, the observed
    // Gemini-3 per-query production max — the hold must not under-reserve vs real spend).
    const provision = cap.postedItems[0];
    expect(provision).toHaveLength(3);
    expect(provision.every((i) => i.status === "provisioned")).toBe(true);
    expect(provision.map((i) => i.costName).sort()).toEqual([
      "google-flash-3-tokens-input",
      "google-flash-3-tokens-output",
      "google-search-query",
    ]);
    expect(provision.find((i) => i.costName === "google-search-query")!.quantity).toBe(20);

    // ACTUAL: google-search-query records the REAL query count (3).
    const actual = cap.postedItems.find((items) => items.some((i) => i.status === undefined));
    expect(actual).toBeDefined();
    expect(actual!.find((i) => i.costName === "google-search-query")!.quantity).toBe(3);

    // Citation source URLs surface in the response content text.
    expect(res.body.content).toContain("Sources:");
    expect(res.body.content).toContain("https://src.example/1");

    // RECONCILE: all 3 provisioned holds cancelled.
    expect(cap.patchedStatuses.filter((s) => s === "cancelled")).toHaveLength(3);
  });

  it("returns 402 and does NOT call the model when billing reports insufficient credits", async () => {
    const cap = { postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string }>>, patchedStatuses: [] as string[] };
    const gemini = { calls: 0 };
    routes.push(mockRunsCreate(), mockKeyDecrypt(), mockBilling({ sufficient: false }), mockGeminiComplete(gemini), ...mockRunsCostRoutes(cap), mockRunsStatusPatch());

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "be brief", provider: "google", model: "flash" });

    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/Insufficient credits/);
    expect(gemini.calls).toBe(0);
    // provisioned holds released on insufficient credits
    expect(cap.patchedStatuses).toContain("cancelled");
  });
});
