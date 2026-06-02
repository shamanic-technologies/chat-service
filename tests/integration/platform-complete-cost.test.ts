import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";

// /internal/platform-complete now declares its LLM (and web-search) spend on a
// platform run: create platform-run → execute → POST actual costs → PATCH status.
// Platform key spend, no org → costSource "platform", no affordability authorize,
// no provision/cancel (platform runs have no cost-status PATCH). google provider
// (fetch-mockable, non-streaming, no DB).

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

function mockPlatformKey() {
  return {
    match: (url: string) => url.includes("/keys/platform/google/decrypt"),
    respond: () => ({ ok: true, body: { provider: "google", key: "fake-google-key", keySource: "platform" } }),
  } satisfies MockRoute;
}

function mockPlatformRunCreate(cap: { headers: Array<Record<string, unknown>>; bodies: unknown[] }) {
  return {
    match: (url: string, init?: RequestInit) => url.endsWith("/v1/platform-runs") && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      cap.headers.push((init?.headers ?? {}) as Record<string, unknown>);
      cap.bodies.push(init?.body ? JSON.parse(init.body as string) : null);
      return { ok: true, status: 201, body: { id: "prun-1", status: "running" } };
    },
  } satisfies MockRoute;
}

function mockPlatformRunCosts(cap: {
  postedItems: Array<Array<{ costName: string; quantity: number; status?: string; costSource?: string }>>;
  costStatus?: number;
}) {
  return {
    match: (url: string, init?: RequestInit) =>
      /\/v1\/platform-runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      const items = init?.body
        ? (JSON.parse(init.body as string) as { items: Array<{ costName: string; quantity: number; status?: string; costSource?: string }> }).items
        : [];
      cap.postedItems.push(items);
      if (cap.costStatus && cap.costStatus >= 400) {
        return { ok: false, status: cap.costStatus, body: { error: "Unknown cost" } };
      }
      return { ok: true, status: 201, body: { costs: items.map((it, i) => ({ id: `cost-${i}`, ...it })) } };
    },
  } satisfies MockRoute;
}

function mockPlatformRunStatus(cap: { patchedStatuses: string[] }) {
  return {
    match: (url: string, init?: RequestInit) =>
      /\/v1\/platform-runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: (_url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { status: string }) : { status: "?" };
      cap.patchedStatuses.push(body.status);
      return { ok: true, body: { id: "prun-1", status: body.status } };
    },
  } satisfies MockRoute;
}

function mockGemini(cap: { calls: number }, grounded = false) {
  return {
    match: (url: string) => url.includes(":generateContent") && url.includes("generativelanguage.googleapis.com"),
    respond: () => {
      cap.calls += 1;
      const candidate: Record<string, unknown> = {
        content: { parts: [{ text: "platform answer" }] },
        finishReason: "STOP",
      };
      if (grounded) {
        candidate.groundingMetadata = {
          webSearchQueries: ["q1", "q2"],
          groundingChunks: [{ web: { uri: "https://src.example/1", title: "Src 1" } }],
        };
      }
      return {
        ok: true,
        body: { candidates: [candidate], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 } },
      };
    },
  } satisfies MockRoute;
}

const AUTH = { "x-api-key": "test-key" };

describe("POST /internal/platform-complete — platform run tracking + cost", () => {
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

  it("creates a platform run, declares actual token costs, and finalizes the run", async () => {
    const runCap = { headers: [] as Array<Record<string, unknown>>, bodies: [] as unknown[] };
    const costCap = { postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string; costSource?: string }>> };
    const statusCap = { patchedStatuses: [] as string[] };
    const gemini = { calls: 0 };
    routes.push(
      mockPlatformKey(),
      mockPlatformRunCreate(runCap),
      mockPlatformRunCosts(costCap),
      mockPlatformRunStatus(statusCap),
      mockGemini(gemini),
    );

    const res = await request(app)
      .post("/internal/platform-complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "be brief", provider: "google", model: "flash" });

    expect(res.status).toBe(200);
    expect(gemini.calls).toBe(1);

    // Platform run created with serviceName/taskName + x-service-name header.
    expect(runCap.bodies[0]).toMatchObject({ serviceName: "chat-service", taskName: "platform-complete" });
    expect((runCap.headers[0] as Record<string, string>)["x-service-name"]).toBe("chat-service");

    // ACTUAL token costs posted (no provisioned status), costSource platform.
    const actual = costCap.postedItems[0];
    expect(actual.find((i) => i.costName === "google-flash-3-tokens-input")!.quantity).toBe(12);
    expect(actual.find((i) => i.costName === "google-flash-3-tokens-output")!.quantity).toBe(7);
    expect(actual.every((i) => i.status === undefined)).toBe(true);
    expect(actual.every((i) => i.costSource === "platform")).toBe(true);

    // Run finalized completed.
    expect(statusCap.patchedStatuses).toContain("completed");
  });

  it("declares the google-search-query cost and appends Sources when webSearch is true", async () => {
    const runCap = { headers: [] as Array<Record<string, unknown>>, bodies: [] as unknown[] };
    const costCap = { postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string; costSource?: string }>> };
    const statusCap = { patchedStatuses: [] as string[] };
    const gemini = { calls: 0 };
    routes.push(
      mockPlatformKey(),
      mockPlatformRunCreate(runCap),
      mockPlatformRunCosts(costCap),
      mockPlatformRunStatus(statusCap),
      mockGemini(gemini, true),
    );

    const res = await request(app)
      .post("/internal/platform-complete")
      .set(AUTH)
      .send({ message: "who won?", systemPrompt: "be brief", provider: "google", model: "flash", webSearch: true });

    expect(res.status).toBe(200);
    const actual = costCap.postedItems[0];
    expect(actual.find((i) => i.costName === "google-search-query")!.quantity).toBe(2);
    expect(res.body.content).toContain("Sources:");
    expect(res.body.content).toContain("https://src.example/1");
  });

  it("fails loud (502) when platform-run creation fails and does NOT call the model", async () => {
    const gemini = { calls: 0 };
    routes.push(
      mockPlatformKey(),
      {
        match: (url: string, init?: RequestInit) => url.endsWith("/v1/platform-runs") && (init?.method ?? "GET") === "POST",
        respond: () => ({ ok: false, status: 502, body: { error: "down" } }),
      },
      mockGemini(gemini),
    );

    const res = await request(app)
      .post("/internal/platform-complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "be brief", provider: "google", model: "flash" });

    expect(res.status).toBe(502);
    expect(gemini.calls).toBe(0);
  });
});
