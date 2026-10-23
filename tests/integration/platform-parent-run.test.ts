import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// COST-ACCOUNTING-1023: a platform call (/internal/platform-complete,
// /internal/platform-judgments) can be made ON BEHALF of a caller's run. The
// caller names it in `x-run-id`; chat-service opens its platform run as that
// run's CHILD (so the spend rolls into the caller's subtree in runs-service) and
// returns the run that carried the call. No header = a root platform run, as
// before. chat-service declares no outcome of its own.

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";

interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown };
}

let routes: MockRoute[] = [];
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      for (const route of routes) {
        if (route.match(url, init)) {
          const out = route.respond(url, init);
          return {
            ok: out.ok,
            status: out.status ?? (out.ok ? 200 : 500),
            json: () => Promise.resolve(out.body),
            text: () => Promise.resolve(typeof out.body === "string" ? out.body : JSON.stringify(out.body)),
            headers: new Headers(),
          } as unknown as Response;
        }
      }
      throw new Error(`[test] Unmocked fetch: ${url}`);
    }),
  );
}

const CALLER_RUN = "5f0c2a8e-1b3d-4c6e-9f70-a1b2c3d4e5f6";
const PLATFORM_RUN = "prun-parent-1";

function platformKey(provider: string): MockRoute {
  return {
    match: (url) => url.includes(`/keys/platform/${provider}/decrypt`),
    respond: () => ({ ok: true, body: { provider, key: `fake-${provider}-key`, keySource: "platform" } }),
  };
}

function runCreate(cap: { headers: Array<Record<string, string>> }, refuse?: { status: number; body: unknown }): MockRoute {
  return {
    match: (url, init) => url.endsWith("/v1/platform-runs") && init?.method === "POST",
    respond: (_url, init) => {
      cap.headers.push((init?.headers ?? {}) as Record<string, string>);
      if (refuse) return { ok: false, status: refuse.status, body: refuse.body };
      return { ok: true, status: 201, body: { id: PLATFORM_RUN, status: "running" } };
    },
  };
}

const runCosts: MockRoute = {
  match: (url, init) => /\/v1\/platform-runs\/[^/]+\/costs$/.test(url) && init?.method === "POST",
  respond: (_url, init) => {
    const items = (JSON.parse(init!.body as string) as { items: unknown[] }).items;
    return { ok: true, status: 201, body: { costs: items.map((it, i) => ({ id: `c-${i}`, ...(it as object) })) } };
  },
};

const runStatus: MockRoute = {
  match: (url, init) => /\/v1\/platform-runs\/[^/]+$/.test(url) && init?.method === "PATCH",
  respond: () => ({ ok: true, body: { id: PLATFORM_RUN, status: "completed" } }),
};

const gemini: MockRoute = {
  match: (url) => url.includes(":generateContent"),
  respond: () => ({
    ok: true,
    body: {
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 },
    },
  }),
};

const typesafe: MockRoute = {
  match: (url) => url.startsWith("https://api.typesafe.ai/v1/systemone"),
  respond: () => ({
    ok: true,
    body: {
      model: "jev-1.13.0",
      answers: { positive: { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 40, output_tokens: 2 },
    },
  }),
};

const COMPLETE = { message: "hi", systemPrompt: "be brief", provider: "google", model: "flash" };
const JUDGE = { state: "Sounds good, let's talk Tuesday", questions: { positive: { type: "noul", instructions: "Is this a positive reply?" } } };

const ROUTES = [
  { path: "/internal/platform-complete", body: COMPLETE, provider: "google", vendor: gemini, taskName: "platform-complete" },
  { path: "/internal/platform-judgments", body: JUDGE, provider: "typesafe", vendor: typesafe, taskName: "platform-judgments" },
] as const;

describe("platform calls on behalf of a caller's run", () => {
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

  for (const r of ROUTES) {
    describe(r.path, () => {
      it("opens the platform run as the CHILD of the caller's run and returns the run that carried the call", async () => {
        const cap = { headers: [] as Array<Record<string, string>> };
        routes.push(platformKey(r.provider), runCreate(cap), runCosts, runStatus, r.vendor);

        const res = await request(app).post(r.path).set({ "x-api-key": "k", "x-run-id": CALLER_RUN }).send(r.body);

        expect(res.status).toBe(200);
        expect(res.body.runId).toBe(PLATFORM_RUN);
        expect(cap.headers).toHaveLength(1);
        expect(cap.headers[0]["x-run-id"]).toBe(CALLER_RUN);
        // Still a PLATFORM run: no org identity travels, so no org is charged.
        expect(cap.headers[0]["x-org-id"]).toBeUndefined();
        expect(cap.headers[0]["x-user-id"]).toBeUndefined();
        expect(cap.headers[0]["x-service-name"]).toBe("chat-service");
        // chat-service produces no outcome: it never declares one.
        expect(fetchCalls.some((c) => c.url.includes("/outcomes"))).toBe(false);
      });

      it("without x-run-id opens a root platform run, exactly as before", async () => {
        const cap = { headers: [] as Array<Record<string, string>> };
        routes.push(platformKey(r.provider), runCreate(cap), runCosts, runStatus, r.vendor);

        const res = await request(app).post(r.path).set({ "x-api-key": "k" }).send(r.body);

        expect(res.status).toBe(200);
        expect(res.body.runId).toBe(PLATFORM_RUN);
        expect("x-run-id" in cap.headers[0]).toBe(false);
      });

      it("refuses a malformed x-run-id with a 400 before any spend", async () => {
        const cap = { headers: [] as Array<Record<string, string>> };
        routes.push(platformKey(r.provider), runCreate(cap), runCosts, runStatus, r.vendor);

        const res = await request(app).post(r.path).set({ "x-api-key": "k", "x-run-id": "not-a-run" }).send(r.body);

        expect(res.status).toBe(400);
        expect(res.body.retryable).toBe(false);
        expect(cap.headers).toHaveLength(0);
      });

      it("answers 400 naming the parent when runs-service refuses it, never a retryable 502", async () => {
        const cap = { headers: [] as Array<Record<string, string>> };
        routes.push(
          platformKey(r.provider),
          runCreate(cap, { status: 404, body: { error: "Parent run not found" } }),
          runCosts,
          runStatus,
          r.vendor,
        );

        const res = await request(app).post(r.path).set({ "x-api-key": "k", "x-run-id": CALLER_RUN }).send(r.body);

        expect(res.status).toBe(400);
        expect(res.body.error).toContain(CALLER_RUN);
        expect(res.body.detail).toContain("Parent run not found");
        expect(res.body.retryable).toBe(false);
      });

      it("keeps a runs-service outage a retryable 502 when no parent was named", async () => {
        const cap = { headers: [] as Array<Record<string, string>> };
        routes.push(platformKey(r.provider), runCreate(cap, { status: 503, body: "down" }), r.vendor);

        const res = await request(app).post(r.path).set({ "x-api-key": "k" }).send(r.body);

        expect(res.status).toBe(502);
      });
    });
  }
});
