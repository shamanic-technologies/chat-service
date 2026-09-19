import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// /internal/platform-judgments is the platform (no-org) twin of /orgs/judgments:
// service auth only, the platform TypeSafe key, and spend declared on a platform
// run (create → execute → POST the actual cost → PATCH status). No org identity,
// no affordability authorize, no provisioned hold — platform runs have no
// cost-status PATCH, so the only quantity ever declared is the exact input-token
// count the vendor reports.

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

function mockPlatformKey(cap?: { headers: Array<Record<string, unknown>> }, failure?: { status: number; body: unknown }) {
  return {
    match: (url: string) => url.includes("/keys/platform/typesafe/decrypt"),
    respond: (_url: string, init?: RequestInit) => {
      cap?.headers.push((init?.headers ?? {}) as Record<string, unknown>);
      if (failure) return { ok: false, status: failure.status, body: failure.body };
      return { ok: true, body: { provider: "typesafe", key: "fake-typesafe-key" } };
    },
  } satisfies MockRoute;
}

function mockPlatformRunCreate(cap: { headers: Array<Record<string, unknown>>; bodies: unknown[] }) {
  return {
    match: (url: string, init?: RequestInit) =>
      url.endsWith("/v1/platform-runs") && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      cap.headers.push((init?.headers ?? {}) as Record<string, unknown>);
      cap.bodies.push(init?.body ? JSON.parse(init.body as string) : null);
      return { ok: true, status: 201, body: { id: "prun-judg-1", status: "running" } };
    },
  } satisfies MockRoute;
}

type PostedCost = { costName: string; quantity: number; status?: string; costSource?: string };

function mockPlatformRunCosts(cap: { postedItems: PostedCost[][]; costStatus?: number }) {
  return {
    match: (url: string, init?: RequestInit) =>
      /\/v1\/platform-runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      const items = init?.body
        ? (JSON.parse(init.body as string) as { items: PostedCost[] }).items
        : [];
      cap.postedItems.push(items);
      if (cap.costStatus && cap.costStatus >= 400) {
        return { ok: false, status: cap.costStatus, body: { error: "Unknown cost name" } };
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
      return { ok: true, body: { id: "prun-judg-1", status: body.status } };
    },
  } satisfies MockRoute;
}

function mockTypeSafe(cap: {
  calls: number;
  bodies: Record<string, unknown>[];
  status?: number;
  errorBody?: unknown;
  answers?: Record<string, unknown>;
  inputTokens?: number;
}) {
  return {
    match: (url: string) => url.startsWith("https://api.typesafe.ai/v1/systemone"),
    respond: (_url: string, init?: RequestInit) => {
      cap.calls += 1;
      if (init?.body) cap.bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      if (cap.status && cap.status >= 400) {
        return { ok: false, status: cap.status, body: cap.errorBody ?? { error: { message: "refused" } } };
      }
      return {
        ok: true,
        body: {
          model: "jev-1.13.0",
          answers: cap.answers ?? {
            urgent: { type: "noul", noul: 0.92 },
            team: {
              type: "choice",
              choice: "billing",
              confidence: 0.81,
              probabilities: { billing: 0.81, support: 0.19 },
            },
            severity: {
              type: "score",
              score: 1.3,
              confidence: 0.54,
              probabilities: { "1": 0.7, "2": 0.3 },
              legend: { "1": "minor", "2": "major" },
            },
          },
          usage: { input_tokens: cap.inputTokens ?? 137, output_tokens: 9 },
        },
      };
    },
  } satisfies MockRoute;
}

const AUTH = { "x-api-key": "test-key" };

const BODY = {
  state: "Help! My payouts have been failing for 3 days.",
  questions: {
    urgent: { type: "noul", instructions: "Does this convey urgency?" },
    team: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: { billing: "money movement", support: "everything else" },
    },
    severity: {
      type: "score",
      instructions: "How severe is the reported issue?",
      criteria: ["minor", "major"],
    },
  },
};

describe("POST /internal/platform-judgments — platform run tracking + cost", () => {
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
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers every question with its distribution intact, with no org identity supplied", async () => {
    const runCap = { headers: [] as Array<Record<string, unknown>>, bodies: [] as unknown[] };
    const costCap = { postedItems: [] as PostedCost[][] };
    const statusCap = { patchedStatuses: [] as string[] };
    const vendor = { calls: 0, bodies: [] as Record<string, unknown>[] };
    routes.push(
      mockPlatformKey(),
      mockPlatformRunCreate(runCap),
      mockPlatformRunCosts(costCap),
      mockPlatformRunStatus(statusCap),
      mockTypeSafe(vendor),
    );

    const res = await request(app).post("/internal/platform-judgments").set(AUTH).send(BODY);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.answers).sort()).toEqual(["severity", "team", "urgent"]);
    expect(res.body.answers.urgent).toEqual({ type: "noul", noul: 0.92 });
    expect(res.body.answers.team.confidence).toBe(0.81);
    expect(res.body.answers.team.probabilities).toEqual({ billing: 0.81, support: 0.19 });
    expect(res.body.answers.severity.probabilities).toEqual({ "1": 0.7, "2": 0.3 });
    expect(res.body.usage).toEqual({ inputTokens: 137, outputTokens: 9 });

    // Platform auth only — no org/user/run identity on the runs-service call.
    const runHeaders = runCap.headers[0] as Record<string, string>;
    expect(runHeaders["x-service-name"]).toBe("chat-service");
    expect(runHeaders["x-org-id"]).toBeUndefined();
    expect(runHeaders["x-user-id"]).toBeUndefined();
    expect(runHeaders["x-run-id"]).toBeUndefined();
    expect(runCap.bodies[0]).toMatchObject({ serviceName: "chat-service", taskName: "platform-judgments" });

    // The wire always carries the pinned release, never the alias.
    expect(vendor.bodies[0]!.model).toBe("jev-1.13.0");

    // Exactly one cost row, `actual`, at the vendor's own input-token count.
    expect(costCap.postedItems).toHaveLength(1);
    expect(costCap.postedItems[0]).toEqual([
      { costName: "typesafe-jev-1.13-tokens-input", quantity: 137, costSource: "platform" },
    ]);
    expect(statusCap.patchedStatuses).toEqual(["completed"]);
  });

  it("declares no output cost — output is free at this vendor", async () => {
    const costCap = { postedItems: [] as PostedCost[][] };
    routes.push(
      mockPlatformKey(),
      mockPlatformRunCreate({ headers: [], bodies: [] }),
      mockPlatformRunCosts(costCap),
      mockPlatformRunStatus({ patchedStatuses: [] }),
      mockTypeSafe({ calls: 0, bodies: [] }),
    );

    await request(app).post("/internal/platform-judgments").set(AUTH).send(BODY);

    const names = costCap.postedItems.flat().map((c) => c.costName);
    expect(names).toEqual(["typesafe-jev-1.13-tokens-input"]);
    expect(names.some((n) => n.includes("output"))).toBe(false);
  });

  it("names the missing credential when the platform TypeSafe key cannot be resolved", async () => {
    routes.push(mockPlatformKey(undefined, { status: 404, body: { error: "No platform key for provider" } }));

    const res = await request(app).post("/internal/platform-judgments").set(AUTH).send(BODY);

    expect(res.status).toBe(502);
    expect(res.body.provider).toBe("typesafe");
    expect(res.body.error).toContain("platform typesafe API key");
    expect(res.body.error).toContain("key-service");
    expect(res.body.retryable).toBe(false);
    expect(res.body.error).not.toMatch(/internal server error/i);
  });

  it("does not create a run — and therefore never spends — when the key is missing", async () => {
    const runCap = { headers: [] as Array<Record<string, unknown>>, bodies: [] as unknown[] };
    const vendor = { calls: 0, bodies: [] as Record<string, unknown>[] };
    routes.push(
      mockPlatformKey(undefined, { status: 404, body: { error: "not found" } }),
      mockPlatformRunCreate(runCap),
      mockTypeSafe(vendor),
    );

    await request(app).post("/internal/platform-judgments").set(AUTH).send(BODY);

    expect(runCap.bodies).toHaveLength(0);
    expect(vendor.calls).toBe(0);
  });

  it("fails loud with 502 when the spend cannot be declared", async () => {
    const statusCap = { patchedStatuses: [] as string[] };
    routes.push(
      mockPlatformKey(),
      mockPlatformRunCreate({ headers: [], bodies: [] }),
      mockPlatformRunCosts({ postedItems: [], costStatus: 422 }),
      mockPlatformRunStatus(statusCap),
      mockTypeSafe({ calls: 0, bodies: [] }),
    );

    const res = await request(app).post("/internal/platform-judgments").set(AUTH).send(BODY);

    expect(res.status).toBe(502);
    expect(statusCap.patchedStatuses).toEqual(["failed"]);
  });

  it("surfaces a vendor refusal as a non-retryable 400 carrying its words", async () => {
    const statusCap = { patchedStatuses: [] as string[] };
    routes.push(
      mockPlatformKey(),
      mockPlatformRunCreate({ headers: [], bodies: [] }),
      mockPlatformRunCosts({ postedItems: [] }),
      mockPlatformRunStatus(statusCap),
      mockTypeSafe({
        calls: 0,
        bodies: [],
        status: 422,
        errorBody: { error: { message: "state exceeds the token budget" } },
      }),
    );

    const res = await request(app).post("/internal/platform-judgments").set(AUTH).send(BODY);

    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("state exceeds the token budget");
    expect(res.body.retryable).toBe(false);
    expect(statusCap.patchedStatuses).toEqual(["failed"]);
  });

  it("rejects a malformed body before touching the vendor", async () => {
    const vendor = { calls: 0, bodies: [] as Record<string, unknown>[] };
    routes.push(mockPlatformKey(), mockTypeSafe(vendor));

    const res = await request(app)
      .post("/internal/platform-judgments")
      .set(AUTH)
      .send({ state: "hello", questions: {} });

    expect(res.status).toBe(400);
    expect(vendor.calls).toBe(0);
  });

  it("requires service auth", async () => {
    const res = await request(app).post("/internal/platform-judgments").send(BODY);
    expect(res.status).toBe(401);
  });
});
