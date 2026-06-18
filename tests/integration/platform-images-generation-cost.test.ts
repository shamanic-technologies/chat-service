import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// /internal/platform-images/generate is the platform (no-org) twin of
// /orgs/images/generate: service-auth, platform key, platform-run cost tracking.
// Spend is declared on a platform run (create → execute → POST actual costs →
// PATCH status). Platform key spend, no org → costSource "platform", no
// affordability authorize, no provision/cancel (platform runs have no
// cost-status PATCH).

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
      return { ok: true, status: 201, body: { id: "prun-img-1", status: "running" } };
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
      return { ok: true, body: { id: "prun-img-1", status: body.status } };
    },
  } satisfies MockRoute;
}

function mockGeminiImage(cap: { calls: number; bodies: Record<string, unknown>[]; status?: number }) {
  return {
    match: (url: string) => url.includes(":generateContent") && url.includes("generativelanguage.googleapis.com"),
    respond: (_url: string, init?: RequestInit) => {
      cap.calls += 1;
      if (init?.body) cap.bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      if (cap.status && cap.status >= 400) {
        return {
          ok: false,
          status: cap.status,
          body: { error: { status: "INVALID_ARGUMENT", message: "Unsupported generation_config field" } },
        };
      }
      return {
        ok: true,
        body: {
          candidates: [
            {
              content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1290 },
        },
      };
    },
  } satisfies MockRoute;
}

const AUTH = { "x-api-key": "test-key" };

describe("POST /internal/platform-images/generate — platform run tracking + cost", () => {
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

  it("creates a platform run, declares actual image token costs, and returns image bytes", async () => {
    const runCap = { headers: [] as Array<Record<string, unknown>>, bodies: [] as unknown[] };
    const costCap = { postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string; costSource?: string }>> };
    const statusCap = { patchedStatuses: [] as string[] };
    const gemini = { calls: 0, bodies: [] as Record<string, unknown>[] };
    routes.push(
      mockPlatformKey(),
      mockPlatformRunCreate(runCap),
      mockPlatformRunCosts(costCap),
      mockPlatformRunStatus(statusCap),
      mockGeminiImage(gemini),
    );

    const res = await request(app)
      .post("/internal/platform-images/generate")
      .set(AUTH)
      .send({ prompt: "Generate a square avatar, no text." });

    expect(res.status).toBe(200);
    expect(gemini.calls).toBe(1);
    expect(res.body).toMatchObject({
      imageBase64: "iVBORw0KGgo=",
      mimeType: "image/png",
      model: "gemini-3.1-flash-image",
      tokensInput: 12,
      tokensOutput: 1290,
    });

    // No org/user/run headers — body shapes the platform run.
    expect(runCap.bodies[0]).toMatchObject({ serviceName: "chat-service", taskName: "generate-image" });
    expect((runCap.headers[0] as Record<string, string>)["x-service-name"]).toBe("chat-service");

    // ACTUAL token costs posted (no provisioned status), costSource platform,
    // byte-equal to the org route's catalog rows.
    const actual = costCap.postedItems[0];
    expect(actual.find((i) => i.costName === "google-flash-image-3.1-tokens-input")!.quantity).toBe(12);
    expect(actual.find((i) => i.costName === "google-flash-image-3.1-tokens-output")!.quantity).toBe(1290);
    expect(actual.every((i) => i.status === undefined)).toBe(true);
    expect(actual.every((i) => i.costSource === "platform")).toBe(true);

    // Run finalized completed.
    expect(statusCap.patchedStatuses).toContain("completed");
  });

  it("fails loud (502) when platform-run creation fails and does NOT call Gemini", async () => {
    const gemini = { calls: 0, bodies: [] as Record<string, unknown>[] };
    routes.push(
      mockPlatformKey(),
      {
        match: (url: string, init?: RequestInit) => url.endsWith("/v1/platform-runs") && (init?.method ?? "GET") === "POST",
        respond: () => ({ ok: false, status: 502, body: { error: "down" } }),
      },
      mockGeminiImage(gemini),
    );

    const res = await request(app)
      .post("/internal/platform-images/generate")
      .set(AUTH)
      .send({ prompt: "Generate a square avatar, no text." });

    expect(res.status).toBe(502);
    expect(gemini.calls).toBe(0);
  });

  it("surfaces Gemini 4xx provider details and finalizes the run failed", async () => {
    const runCap = { headers: [] as Array<Record<string, unknown>>, bodies: [] as unknown[] };
    const costCap = { postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string; costSource?: string }>> };
    const statusCap = { patchedStatuses: [] as string[] };
    const gemini = { calls: 0, bodies: [] as Record<string, unknown>[], status: 400 };
    routes.push(
      mockPlatformKey(),
      mockPlatformRunCreate(runCap),
      mockPlatformRunCosts(costCap),
      mockPlatformRunStatus(statusCap),
      mockGeminiImage(gemini),
    );

    const res = await request(app)
      .post("/internal/platform-images/generate")
      .set(AUTH)
      .send({ prompt: "Generate a square avatar, no text." });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("provider status 400");
    expect(res.body.providerError).toContain("Unsupported generation_config field");
    expect(statusCap.patchedStatuses).toContain("failed");
  });
});
