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
process.env.BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY || "test-billing-key";
process.env.BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "https://billing.test.local";

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

// Run-status PATCH /v1/runs/:id AND cost-status PATCH /v1/runs/:id/costs/:costId
// (actualize/cancel). Absorbs both so tests that don't assert them don't hit an
// unmocked fetch.
function mockRunsPatch() {
  return {
    match: (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      return (
        (/\/v1\/runs\/[^/]+$/.test(url) && method === "PATCH") ||
        (/\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(url) && method === "PATCH")
      );
    },
    respond: () => ({ ok: true, body: { id: "ok", status: "actual" } }),
  } satisfies MockRoute;
}

// PROVISION: POST /v1/runs/:id/costs. Returns created cost row(s) WITH an id so the
// handler can actualize/cancel later. Captures the provisioned items. `status` lets a
// test force a runs-service rejection (e.g. 422 unknown cost name).
function mockRunsProvision(capture?: { items?: unknown[]; calls: number }, opts?: { status?: number; body?: unknown }) {
  return {
    match: (url: string, init?: RequestInit) =>
      /\/v1\/runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      const items = init?.body ? (JSON.parse(init.body as string) as { items: unknown[] }).items : [];
      if (capture) {
        capture.calls += 1;
        capture.items = items;
      }
      if (opts?.status && opts.status >= 400) {
        return { ok: false, status: opts.status, body: opts.body ?? { error: "Unknown cost name" } };
      }
      return {
        ok: true,
        status: 201,
        body: { costs: items.map((it, i) => ({ id: `cost-${i}`, ...(it as object) })) },
      };
    },
  } satisfies MockRoute;
}

// PATCH /v1/runs/:id/costs/:costId — capture actualize/cancel status transitions.
function mockRunsCostStatus(capture: { statuses: string[] }) {
  return {
    match: (url: string, init?: RequestInit) =>
      /\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: (_url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { status: string }) : { status: "?" };
      capture.statuses.push(body.status);
      return { ok: true, body: { id: "cost-0", status: body.status } };
    },
  } satisfies MockRoute;
}

// Billing affordability check (platform keys). Defaults to sufficient.
function mockBillingAuthorize(opts?: { sufficient?: boolean; capture?: { calls: number } }) {
  const sufficient = opts?.sufficient ?? true;
  return {
    match: (url: string, init?: RequestInit) =>
      url.includes("/v1/customer_balance/authorize") && (init?.method ?? "GET") === "POST",
    respond: () => {
      if (opts?.capture) opts.capture.calls += 1;
      return { ok: true, body: { sufficient, balance_cents: "100000", required_cents: "1" } };
    },
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

  it("provisions → authorizes → embeds → actualizes; returns 3 embeddings in input order", async () => {
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
    const costCapture = { items: undefined as unknown[] | undefined, calls: 0 };
    const billingCapture = { calls: 0 };
    const statusCapture = { statuses: [] as string[] };

    routes.push(mockRunsCreate(ownRunId, runsCapture));
    routes.push(mockRunsProvision(costCapture));
    routes.push(mockRunsCostStatus(statusCapture));
    routes.push(mockRunsPatch());
    routes.push(mockBillingAuthorize({ capture: billingCapture }));
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
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual(["alpha", "beta", "gamma"]);
    for (let i = 0; i < 3; i++) {
      expect(res.body.results[i].embedding).toEqual(docVectors[i]);
    }

    expect(embedCapture.calls).toBe(1);
    expect(runsCapture.headers?.["x-run-id"]).toBe(parentRunId);

    // PROVISION: cost reserved with status "provisioned", google-* catalog name,
    // costSource from the (platform) key, quantity from input tokens.
    expect(costCapture.items).toHaveLength(1);
    const costItem = costCapture.items![0] as {
      costName: string;
      quantity: number;
      costSource: string;
      status: string;
    };
    expect(costItem.costName).toBe("google-embedding-001-tokens-input");
    expect(costItem.costSource).toBe("platform");
    expect(costItem.quantity).toBeGreaterThan(0);
    expect(costItem.status).toBe("provisioned");

    // AUTHORIZE: billing called once (platform key).
    expect(billingCapture.calls).toBe(1);

    // ACTUALIZE: the provisioned cost is realized to "actual" (no cancel).
    expect(statusCapture.statuses).toEqual(["actual"]);

    // ORDER: provision happens BEFORE the Gemini embed (never spend on an undeclarable cost).
    const provisionIdx = fetchCalls.findIndex(
      (c) => /\/v1\/runs\/[^/]+\/costs$/.test(c.url) && (c.init?.method ?? "GET") === "POST",
    );
    const embedIdx = fetchCalls.findIndex((c) => c.url.includes(":batchEmbedContents"));
    expect(provisionIdx).toBeGreaterThanOrEqual(0);
    expect(embedIdx).toBeGreaterThan(provisionIdx);
  });

  it("same input twice returns identical vectors when provider is deterministic", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const fixedVector = [0.42, 0.84, 0.21];

    const setup = () => {
      routes = [];
      fetchCalls = [];
      installFetchMock();
      routes.push(mockRunsCreate(crypto.randomUUID()));
      routes.push(mockRunsProvision());
      routes.push(mockRunsPatch());
      routes.push(mockBillingAuthorize());
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
    const costCapture = { items: undefined as unknown[] | undefined, calls: 0 };
    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsProvision(costCapture));
    routes.push(mockRunsPatch());

    const docs = Array.from({ length: 101 }, (_, i) => ({ id: `d-${i}`, text: "x" }));
    const res = await request(app)
      .post("/orgs/rag/embed")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({ documents: docs });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/at most/);
    // Validation fails before provisioning → no cost reserved.
    expect(costCapture.calls).toBe(0);
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

  it("fails loud (502) and does NOT embed when provision is rejected (unknown cost name)", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const embedCapture = { calls: 0, bodies: [] as unknown[] };
    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsProvision(undefined, { status: 422, body: { error: "Unknown cost name" } }));
    routes.push(mockRunsPatch());
    routes.push(mockBillingAuthorize());
    routes.push(mockKeyServiceDecrypt());
    routes.push(mockGeminiBatchEmbed([[1, 0]], embedCapture));

    const res = await request(app)
      .post("/orgs/rag/embed")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({ documents: [{ id: "x", text: "hello" }] });

    expect(res.status).toBe(502);
    // The costly Gemini call must NOT happen when the cost can't be declared.
    expect(embedCapture.calls).toBe(0);
  });

  it("returns 402 and does NOT embed when billing reports insufficient credits", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const embedCapture = { calls: 0, bodies: [] as unknown[] };
    const statusCapture = { statuses: [] as string[] };
    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsProvision());
    routes.push(mockRunsCostStatus(statusCapture));
    routes.push(mockRunsPatch());
    routes.push(mockBillingAuthorize({ sufficient: false }));
    routes.push(mockKeyServiceDecrypt());
    routes.push(mockGeminiBatchEmbed([[1, 0]], embedCapture));

    const res = await request(app)
      .post("/orgs/rag/embed")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({ documents: [{ id: "x", text: "hello" }] });

    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/Insufficient credits/);
    // No spend, and the provisioned reservation is released.
    expect(embedCapture.calls).toBe(0);
    expect(statusCapture.statuses).toContain("cancelled");
  });

  it("cancels the provisioned cost when the embedding call fails", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const statusCapture = { statuses: [] as string[] };
    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsProvision());
    routes.push(mockRunsCostStatus(statusCapture));
    routes.push(mockRunsPatch());
    routes.push(mockBillingAuthorize());
    routes.push(mockKeyServiceDecrypt());
    // Gemini returns a non-retryable 400 → embedTexts throws → handler cancels + 502.
    routes.push({
      match: (url: string) => url.includes(":batchEmbedContents"),
      respond: () => ({ ok: false, status: 400, body: "bad request" }),
    });

    const res = await request(app)
      .post("/orgs/rag/embed")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({ documents: [{ id: "x", text: "hello" }] });

    expect(res.status).toBe(502);
    expect(statusCapture.statuses).toContain("cancelled");
  });
});
