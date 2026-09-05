import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";

// Regression — production outage 2026-08-14 → 2026-08-24.
//
// `POST /complete` and `POST /internal/platform-complete` with
// { provider: "google", model: "flash-pro", disableThinking: true } sent
// `thinkingConfig: { thinkingLevel: "minimal" }`, because the floor was picked
// from the model GENERATION plus a substring test for "pro". The `flash-pro`
// alias moved to gemini-3.7-flash (and since 2026-09-05 to gemini-3.8-flash),
// whose ids contain no "pro" and which REJECT
// minimal:
//
//   400 INVALID_ARGUMENT
//   "Thinking level MINIMAL is not supported for this model. Please retry with
//    other thinking level."
//
// Deterministic, so caller retries all failed identically. These tests assert
// the level ON THE WIRE per alias, for BOTH endpoints — the flag is accepted by
// both and the bug hit both.

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
let geminiBodies: Array<Record<string, unknown>> = [];

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
      for (const route of routes) {
        if (route.match(url, init)) return buildResponse(route.respond(url, init));
      }
      throw new Error(`[test] Unmocked fetch: ${url}`);
    }),
  );
}

/**
 * Stands in for the real Gemini endpoint AND enforces its contract: a request
 * whose thinkingLevel the model does not accept answers with the provider's own
 * 400, exactly as production did.
 */
const MODELS_REJECTING_MINIMAL = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.1-pro-preview",
];

function mockGemini() {
  return {
    match: (url: string) =>
      url.includes(":generateContent") && url.includes("generativelanguage.googleapis.com"),
    respond: (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      geminiBodies.push(body);
      const level = (
        (body.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig as
          | Record<string, unknown>
          | undefined
      )?.thinkingLevel;
      const model = MODELS_REJECTING_MINIMAL.find((m) => url.includes(m));
      if (model && level === "minimal") {
        return {
          ok: false,
          status: 400,
          body: {
            error: {
              code: 400,
              message:
                "Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.",
              status: "INVALID_ARGUMENT",
            },
          },
        };
      }
      return {
        ok: true,
        body: {
          candidates: [{ content: { parts: [{ text: "answer text" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      };
    },
  } satisfies MockRoute;
}

function mockOrgKey() {
  return {
    match: (url: string) => url.includes("/keys/google/decrypt"),
    respond: () => ({
      ok: true,
      body: { provider: "google", key: "fake-google-key", keySource: "platform" },
    }),
  } satisfies MockRoute;
}

function mockPlatformKey() {
  return {
    match: (url: string) => url.includes("/keys/platform/google/decrypt"),
    respond: () => ({
      ok: true,
      body: { provider: "google", key: "fake-google-key", keySource: "platform" },
    }),
  } satisfies MockRoute;
}

function mockRunsAndBilling(): MockRoute[] {
  return [
    {
      match: (url: string, init?: RequestInit) =>
        url.endsWith("/v1/runs") && (init?.method ?? "GET") === "POST",
      respond: () => ({ ok: true, status: 201, body: { id: "run-1", status: "running" } }),
    },
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
      respond: (_url: string, init?: RequestInit) => {
        const items = init?.body
          ? (JSON.parse(init.body as string) as { items: Array<Record<string, unknown>> }).items
          : [];
        return { ok: true, status: 201, body: { costs: items.map((it, i) => ({ id: `cost-${i}`, ...it })) } };
      },
    },
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
      respond: () => ({ ok: true, body: { id: "cost-0", status: "cancelled" } }),
    },
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
      respond: () => ({ ok: true, body: { id: "run-1", status: "completed" } }),
    },
    {
      match: (url: string, init?: RequestInit) =>
        url.includes("/v1/customer_balance/authorize") && (init?.method ?? "GET") === "POST",
      respond: () => ({
        ok: true,
        body: { sufficient: true, balance_cents: "100000", required_cents: "1" },
      }),
    },
  ];
}

function mockPlatformRuns(): MockRoute[] {
  return [
    {
      match: (url: string, init?: RequestInit) =>
        url.endsWith("/v1/platform-runs") && (init?.method ?? "GET") === "POST",
      respond: () => ({ ok: true, status: 201, body: { id: "prun-1", status: "running" } }),
    },
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/platform-runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
      respond: (_url: string, init?: RequestInit) => {
        const items = init?.body
          ? (JSON.parse(init.body as string) as { items: Array<Record<string, unknown>> }).items
          : [];
        return { ok: true, status: 201, body: { costs: items.map((it, i) => ({ id: `cost-${i}`, ...it })) } };
      },
    },
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/platform-runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
      respond: () => ({ ok: true, body: { id: "prun-1", status: "completed" } }),
    },
  ];
}

const ORG_AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "parent-run-1",
};
const PLATFORM_AUTH = { "x-api-key": "test-key" };

function thinkingConfigOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return (body.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig as
    | Record<string, unknown>
    | undefined;
}

// Every Gemini alias the service exposes, with the level disableThinking must
// resolve to. Floors read from https://ai.google.dev/gemini-api/docs/thinking
// (2026-08-24) and confirmed against the live API the same day.
const ALIAS_FLOOR: Array<[string, string]> = [
  ["flash-lite", "minimal"], // gemini-3.1-flash-lite
  ["flash", "minimal"], // gemini-3.5-flash-lite
  ["flash-pro", "low"], // gemini-3.8-flash — rejects minimal
  ["pro", "low"], // gemini-3.1-pro-preview — rejects minimal
];

describe("disableThinking resolves a level the model accepts — POST /complete", () => {
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
    geminiBodies = [];
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  for (const [alias, floor] of ALIAS_FLOOR) {
    it(`google/${alias} + disableThinking → 200 with thinkingLevel "${floor}"`, async () => {
      routes.push(mockOrgKey(), ...mockRunsAndBilling(), mockGemini());

      const res = await request(app)
        .post("/complete")
        .set(ORG_AUTH)
        .send({
          message: "give me this JSON fast",
          systemPrompt: "be brief",
          provider: "google",
          model: alias,
          disableThinking: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.content).toBe("answer text");
      expect(thinkingConfigOf(geminiBodies[0])).toEqual({ thinkingLevel: floor });
    });
  }

  it("leaves the level at the low default when disableThinking is absent", async () => {
    routes.push(mockOrgKey(), ...mockRunsAndBilling(), mockGemini());

    const res = await request(app)
      .post("/complete")
      .set(ORG_AUTH)
      .send({ message: "hi", systemPrompt: "be brief", provider: "google", model: "flash-pro" });

    expect(res.status).toBe(200);
    expect(thinkingConfigOf(geminiBodies[0])).toEqual({ thinkingLevel: "low" });
  });
});

describe("disableThinking resolves a level the model accepts — POST /internal/platform-complete", () => {
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
    geminiBodies = [];
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  for (const [alias, floor] of ALIAS_FLOOR) {
    it(`google/${alias} + disableThinking → 200 with thinkingLevel "${floor}"`, async () => {
      routes.push(mockPlatformKey(), ...mockPlatformRuns(), mockGemini());

      const res = await request(app)
        .post("/internal/platform-complete")
        .set(PLATFORM_AUTH)
        .send({
          message: "give me this JSON fast",
          systemPrompt: "be brief",
          provider: "google",
          model: alias,
          disableThinking: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.content).toBe("answer text");
      expect(thinkingConfigOf(geminiBodies[0])).toEqual({ thinkingLevel: floor });
    });
  }

  it("leaves the level at the low default when disableThinking is absent", async () => {
    routes.push(mockPlatformKey(), ...mockPlatformRuns(), mockGemini());

    const res = await request(app)
      .post("/internal/platform-complete")
      .set(PLATFORM_AUTH)
      .send({ message: "hi", systemPrompt: "be brief", provider: "google", model: "flash-pro" });

    expect(res.status).toBe(200);
    expect(thinkingConfigOf(geminiBodies[0])).toEqual({ thinkingLevel: "low" });
  });
});
