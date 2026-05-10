import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import crypto from "crypto";

// Force test mode so app.listen() does not run
process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";

interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) =>
    | Promise<{ ok: boolean; status?: number; body: unknown }>
    | { ok: boolean; status?: number; body: unknown };
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
          const out = await route.respond(url, init);
          return {
            ok: out.ok,
            status: out.status ?? (out.ok ? 200 : 500),
            json: () => Promise.resolve(out.body),
            text: () =>
              Promise.resolve(
                typeof out.body === "string" ? out.body : JSON.stringify(out.body),
              ),
            headers: new Headers(),
          } as unknown as Response;
        }
      }
      throw new Error(`[test] Unmocked fetch: ${url}`);
    }),
  );
}

function mockRunsCreate(returnRunId: string, capture?: { headers?: Record<string, string> }) {
  return {
    match: (url: string, init?: RequestInit) =>
      url.endsWith("/v1/runs") && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      if (capture && init?.headers) {
        const h = init.headers as Record<string, string>;
        capture.headers = { ...h };
      }
      return {
        ok: true,
        status: 201,
        body: {
          id: returnRunId,
          organizationId: "org",
          serviceName: "chat-service",
          taskName: "rag-embed",
          status: "running",
          startedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      };
    },
  } satisfies MockRoute;
}

function mockRunsPatch() {
  return {
    match: (url: string, init?: RequestInit) =>
      /\/v1\/runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: () => ({ ok: true, body: { id: "ok" } }),
  } satisfies MockRoute;
}

function mockKeyServiceDecrypt() {
  return {
    match: (url: string) => url.includes("/keys/google/decrypt"),
    respond: () => ({
      ok: true,
      body: { provider: "google", key: "fake-google-key", keySource: "platform" },
    }),
  } satisfies MockRoute;
}

function mockKeyServiceDecrypt502() {
  return {
    match: (url: string) => url.includes("/keys/google/decrypt"),
    respond: () => ({ ok: false, status: 502, body: "key-service down" }),
  } satisfies MockRoute;
}

function mockGeminiBatchEmbed(
  vectorsByRequest: number[][],
  capture?: { calls: number; bodies: unknown[] },
) {
  return {
    match: (url: string) =>
      url.includes(":batchEmbedContents") &&
      url.includes("generativelanguage.googleapis.com"),
    respond: (_url: string, init?: RequestInit) => {
      if (capture) {
        capture.calls += 1;
        if (init?.body) capture.bodies.push(JSON.parse(init.body as string));
      }
      return {
        ok: true,
        body: { embeddings: vectorsByRequest.map((v) => ({ values: v })) },
      };
    },
  } satisfies MockRoute;
}

beforeEach(() => {
  routes = [];
  fetchCalls = [];
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /orgs/rag/embed", { timeout: 30_000 }, () => {
  let app: Awaited<ReturnType<typeof loadApp>>;

  async function loadApp() {
    vi.resetModules();
    const mod = await import("../../src/index.js");
    return mod.default;
  }

  beforeAll(async () => {
    app = await loadApp();
  });

  function authHeaders(orgId: string, runId: string) {
    return {
      "x-api-key": "test-api-key",
      "x-org-id": orgId,
      "x-user-id": crypto.randomUUID(),
      "x-run-id": runId,
    };
  }

  it("returns 3 embeddings in input order, ids preserved 1:1, dimensionality matches mock", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const ownRunId = crypto.randomUUID();
    const parentRunId = crypto.randomUUID();

    const docVectors = [
      [0.1, 0.2, 0.3, 0.4],
      [0.5, 0.6, 0.7, 0.8],
      [0.9, 1.0, 1.1, 1.2],
    ];

    const embedCapture = { calls: 0, bodies: [] as unknown[] };
    const runsCapture = { headers: undefined as Record<string, string> | undefined };

    routes.push(mockRunsCreate(ownRunId, runsCapture));
    routes.push(mockRunsPatch());
    routes.push(mockKeyServiceDecrypt());
    routes.push(mockGeminiBatchEmbed(docVectors, embedCapture));

    const res = await request(app)
      .post("/orgs/rag/embed")
      .set(authHeaders(orgId, parentRunId))
      .send({
        documents: [
          { id: "alpha", text: "first text" },
          { id: "beta", text: "second text" },
          { id: "gamma", text: "third text" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe("gemini-embedding-001");
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    for (let i = 0; i < 3; i++) {
      expect(res.body.results[i].embedding).toEqual(docVectors[i]);
      expect(res.body.results[i].embedding).toHaveLength(4);
    }

    expect(embedCapture.calls).toBe(1);
    expect((embedCapture.bodies[0] as { requests: unknown[] }).requests).toHaveLength(3);

    expect(runsCapture.headers?.["x-run-id"]).toBe(parentRunId);
  });

  it("same input twice returns identical vectors when provider is deterministic", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const fixedVector = [0.42, 0.84, 0.21];

    const setup = () => {
      routes = [];
      fetchCalls = [];
      installFetchMock();
      routes.push(mockRunsCreate(crypto.randomUUID()));
      routes.push(mockRunsPatch());
      routes.push(mockKeyServiceDecrypt());
      routes.push(mockGeminiBatchEmbed([fixedVector]));
    };

    const send = () =>
      request(app)
        .post("/orgs/rag/embed")
        .set(authHeaders(orgId, crypto.randomUUID()))
        .send({ documents: [{ id: "x", text: "deterministic input" }] });

    setup();
    const r1 = await send();
    expect(r1.status).toBe(200);
    expect(r1.body.results[0].embedding).toEqual(fixedVector);

    setup();
    const r2 = await send();
    expect(r2.status).toBe(200);
    expect(r2.body.results[0].embedding).toEqual(r1.body.results[0].embedding);
  });

  it("returns 401 when x-api-key is missing", async () => {
    const res = await request(app)
      .post("/orgs/rag/embed")
      .set("x-org-id", `org-${crypto.randomUUID()}`)
      .set("x-user-id", crypto.randomUUID())
      .set("x-run-id", crypto.randomUUID())
      .send({ documents: [{ id: "x", text: "hello" }] });

    expect(res.status).toBe(401);
  });

  it("returns 400 when documents.length exceeds the cap", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsPatch());

    const docs = Array.from({ length: 101 }, (_, i) => ({ id: `d-${i}`, text: "x" }));
    const res = await request(app)
      .post("/orgs/rag/embed")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({ documents: docs });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/at most/);
  });

  it("returns 400 when a document.text exceeds the per-text char cap", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsPatch());

    const res = await request(app)
      .post("/orgs/rag/embed")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({ documents: [{ id: "x", text: "y".repeat(8001) }] });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/at most/);
  });

  it("returns 502 when key-service fails to decrypt the google key", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsPatch());
    routes.push(mockKeyServiceDecrypt502());

    const res = await request(app)
      .post("/orgs/rag/embed")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({ documents: [{ id: "x", text: "hello" }] });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/google API key/);
  });
});
