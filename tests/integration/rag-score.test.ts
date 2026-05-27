import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";

// Force test mode so app.listen() does not run
process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;

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

const RUN_ID_REGEX = /^[0-9a-f-]{36}$/;

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
          taskName: "rag-score",
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

function mockBrandExtract(
  fields: Record<string, string>,
  capture?: { headers?: Record<string, string>; body?: unknown },
) {
  return {
    match: (url: string, init?: RequestInit) =>
      url.endsWith("/v1/brands/extract-fields") && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      if (capture && init?.headers) {
        capture.headers = { ...(init.headers as Record<string, string>) };
      }
      if (capture && init?.body) {
        capture.body = JSON.parse(init.body as string);
      }
      const domain = "fake-brand.example";
      const fieldsObj: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        fieldsObj[key] = {
          value,
          byBrand: {
            [domain]: {
              value,
              cached: false,
              extractedAt: new Date().toISOString(),
              expiresAt: null,
              sourceUrls: null,
            },
          },
        };
      }
      return {
        ok: true,
        body: {
          brands: [
            {
              brandId: "fake-brand",
              domain,
              name: "Fake Brand",
              brandUrl: `https://${domain}`,
            },
          ],
          fields: fieldsObj,
        },
      };
    },
  } satisfies MockRoute;
}

function mockBrandExtract404() {
  return {
    match: (url: string) => url.endsWith("/v1/brands/extract-fields"),
    respond: () => ({ ok: false, status: 404, body: "brand not found" }),
  } satisfies MockRoute;
}

function mockGeminiBatchEmbed(
  vectors: number[][],
  capture?: { calls: number; bodies: unknown[] },
) {
  return {
    match: (url: string) =>
      url.includes(":batchEmbedContents") && url.includes("generativelanguage.googleapis.com"),
    respond: (_url: string, init?: RequestInit) => {
      if (capture) {
        capture.calls += 1;
        if (init?.body) capture.bodies.push(JSON.parse(init.body as string));
      }
      return {
        ok: true,
        body: { embeddings: vectors.map((v) => ({ values: v })) },
      };
    },
  } satisfies MockRoute;
}

beforeAll(() => {
  if (!connectionString) {
    throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
  }
});

beforeEach(() => {
  routes = [];
  fetchCalls = [];
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /orgs/rag/score", { timeout: 30_000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: Awaited<ReturnType<typeof loadApp>>;

  async function loadApp() {
    vi.resetModules();
    const mod = await import("../../src/index.js");
    return mod.default;
  }

  beforeAll(async () => {
    client = postgres(connectionString!);
    db = drizzle(client, { schema });
    app = await loadApp();
  });

  afterAll(async () => {
    await client?.end();
  });

  function authHeaders(orgId: string, runId: string) {
    return {
      "x-api-key": "test-api-key",
      "x-org-id": orgId,
      "x-user-id": crypto.randomUUID(),
      "x-run-id": runId,
    };
  }

  async function cleanupBrandCache(orgId: string, brandId: string) {
    await db
      .delete(schema.brandProfileEmbeddings)
      .where(
        and(
          eq(schema.brandProfileEmbeddings.orgId, orgId),
          eq(schema.brandProfileEmbeddings.brandId, brandId),
        ),
      );
  }

  it("returns sorted results, preserves ids, hits Gemini once for query + once for docs", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const brandId = crypto.randomUUID();
    await cleanupBrandCache(orgId, brandId);

    const queryVector = [1, 0, 0];
    const docVectors = [
      [-1, 0, 0], // doc-c — opposite, lowest
      [0.1, 0.99, 0], // doc-a — orthogonal-ish
      [0.99, 0.1, 0], // doc-b — close, highest
    ];

    const embedCapture = { calls: 0, bodies: [] as unknown[] };
    const brandCapture = { headers: undefined as Record<string, string> | undefined, body: undefined as unknown };
    const runsCapture = { headers: undefined as Record<string, string> | undefined };
    const ownRunId = crypto.randomUUID();

    routes.push(mockRunsCreate(ownRunId, runsCapture));
    routes.push(mockRunsPatch());
    routes.push(
      mockBrandExtract(
        { industry: "B2B SaaS", expertise: "pricing experiments", target_audience: "founders", voice: "data-driven" },
        brandCapture,
      ),
    );
    routes.push(mockKeyServiceDecrypt());
    // Two batchEmbed calls expected: 1 for query (cache miss), 1 for docs.
    let embedCallIdx = 0;
    routes.push({
      match: (url: string) =>
        url.includes(":batchEmbedContents") && url.includes("generativelanguage.googleapis.com"),
      respond: (_url: string, init?: RequestInit) => {
        embedCapture.calls += 1;
        if (init?.body) embedCapture.bodies.push(JSON.parse(init.body as string));
        const idx = embedCallIdx++;
        const body = idx === 0
          ? { embeddings: [{ values: queryVector }] }
          : { embeddings: docVectors.map((v) => ({ values: v })) };
        return { ok: true, body };
      },
    });

    const parentRunId = crypto.randomUUID();
    const res = await request(app)
      .post("/orgs/rag/score")
      .set(authHeaders(orgId, parentRunId))
      .send({
        brandId,
        documents: [
          { id: "doc-c", text: "irrelevant" },
          { id: "doc-a", text: "tangential" },
          { id: "doc-b", text: "perfect match" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.brandId).toBe(brandId);
    expect(res.body.cacheHit).toBe(false);
    expect(res.body.model).toBe("gemini-embedding-001");
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual(["doc-b", "doc-a", "doc-c"]);
    expect(res.body.results[0].score).toBeGreaterThan(res.body.results[1].score);
    expect(res.body.results[1].score).toBeGreaterThan(res.body.results[2].score);
    // All scores in [0, 1]
    for (const r of res.body.results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }

    // Expect 2 embed calls (one for query, one batch for docs)
    expect(embedCapture.calls).toBe(2);
    // First call is the query, single-text
    expect((embedCapture.bodies[0] as { requests: unknown[] }).requests).toHaveLength(1);
    // Second call is the docs batch
    expect((embedCapture.bodies[1] as { requests: unknown[] }).requests).toHaveLength(3);

    // brand-service got our own runId (not the parent), and our own brandId in headers
    expect(brandCapture.headers?.["x-run-id"]).toBe(ownRunId);
    expect(brandCapture.headers?.["x-brand-id"]).toBe(brandId);
    // Outbound body to api-service must include brandIds (non-empty array) — regression for rag-score 502
    expect(brandCapture.body).toMatchObject({
      brandIds: [brandId],
      fields: expect.any(Array),
    });
    // runs-service create was called with the parent runId from the request
    expect(runsCapture.headers?.["x-run-id"]).toBe(parentRunId);

    // Cache row was written
    const cached = await db
      .select()
      .from(schema.brandProfileEmbeddings)
      .where(
        and(
          eq(schema.brandProfileEmbeddings.orgId, orgId),
          eq(schema.brandProfileEmbeddings.brandId, brandId),
        ),
      );
    expect(cached).toHaveLength(1);
    expect(cached[0].embedding).toEqual(queryVector);

    await cleanupBrandCache(orgId, brandId);
  });

  it("hits the cache on second call with unchanged brand context (no second query embed)", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const brandId = crypto.randomUUID();
    await cleanupBrandCache(orgId, brandId);

    const queryVector = [1, 0];
    const docVectors = [[1, 0], [0, 1]];

    type EmbedCapture = { bodies: unknown[] };
    const setup = (capture: EmbedCapture) => {
      routes = [];
      fetchCalls = [];
      installFetchMock();
      routes.push(mockRunsCreate(crypto.randomUUID()));
      routes.push(mockRunsPatch());
      routes.push(
        mockBrandExtract({
          industry: "SaaS",
          expertise: "pricing",
          target_audience: "founders",
          voice: "data-driven",
        }),
      );
      routes.push(mockKeyServiceDecrypt());
      routes.push({
        match: (url: string) => url.includes(":batchEmbedContents"),
        respond: (_url: string, init?: RequestInit) => {
          const body = JSON.parse(init!.body as string) as { requests: unknown[] };
          capture.bodies.push(body);
          return {
            ok: true,
            body:
              body.requests.length === 1
                ? { embeddings: [{ values: queryVector }] }
                : { embeddings: docVectors.map((v) => ({ values: v })) },
          };
        },
      });
    };

    const send = () =>
      request(app)
        .post("/orgs/rag/score")
        .set(authHeaders(orgId, crypto.randomUUID()))
        .send({
          brandId,
          documents: [
            { id: "x", text: "hello" },
            { id: "y", text: "world" },
          ],
        });

    const cap1: EmbedCapture = { bodies: [] };
    setup(cap1);
    const r1 = await send();
    expect(r1.status).toBe(200);
    expect(r1.body.cacheHit).toBe(false);
    const queryCalls1 = cap1.bodies.filter(
      (b) => (b as { requests: unknown[] }).requests.length === 1,
    ).length;
    expect(queryCalls1).toBe(1);

    const cap2: EmbedCapture = { bodies: [] };
    setup(cap2);
    const r2 = await send();
    expect(r2.status).toBe(200);
    expect(r2.body.cacheHit).toBe(true);
    const queryCalls2 = cap2.bodies.filter(
      (b) => (b as { requests: unknown[] }).requests.length === 1,
    ).length;
    expect(queryCalls2).toBe(0);

    await cleanupBrandCache(orgId, brandId);
  });

  it("invalidates cache when brand context changes", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const brandId = crypto.randomUUID();
    await cleanupBrandCache(orgId, brandId);

    const queryVector1 = [1, 0];
    const queryVector2 = [0, 1];
    const docVectors = [[1, 0]];

    const setup = (brandFields: Record<string, string>, queryVec: number[]) => {
      routes = [];
      fetchCalls = [];
      installFetchMock();
      routes.push(mockRunsCreate(crypto.randomUUID()));
      routes.push(mockRunsPatch());
      routes.push(mockBrandExtract(brandFields));
      routes.push(mockKeyServiceDecrypt());
      routes.push({
        match: (url: string) => url.includes(":batchEmbedContents"),
        respond: (_url: string, init?: RequestInit) => {
          const body = JSON.parse(init!.body as string) as { requests: unknown[] };
          return {
            ok: true,
            body:
              body.requests.length === 1
                ? { embeddings: [{ values: queryVec }] }
                : { embeddings: docVectors.map((v) => ({ values: v })) },
          };
        },
      });
    };

    const send = () =>
      request(app)
        .post("/orgs/rag/score")
        .set(authHeaders(orgId, crypto.randomUUID()))
        .send({
          brandId,
          documents: [{ id: "x", text: "hello" }],
        });

    setup({ industry: "SaaS", expertise: "pricing", target_audience: "founders", voice: "data-driven" }, queryVector1);
    const r1 = await send();
    expect(r1.status).toBe(200);
    expect(r1.body.cacheHit).toBe(false);

    // Same content → cache hit
    setup({ industry: "SaaS", expertise: "pricing", target_audience: "founders", voice: "data-driven" }, queryVector1);
    const r2 = await send();
    expect(r2.body.cacheHit).toBe(true);

    // Brand voice changed → cache miss → re-embed
    setup({ industry: "SaaS", expertise: "pricing", target_audience: "founders", voice: "founder-led" }, queryVector2);
    const r3 = await send();
    expect(r3.body.cacheHit).toBe(false);

    // Two distinct cache rows now exist (one per content hash)
    const rows = await db
      .select()
      .from(schema.brandProfileEmbeddings)
      .where(
        and(
          eq(schema.brandProfileEmbeddings.orgId, orgId),
          eq(schema.brandProfileEmbeddings.brandId, brandId),
        ),
      );
    expect(rows).toHaveLength(2);

    await cleanupBrandCache(orgId, brandId);
  });

  it("returns 400 when documents.length exceeds the cap", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const brandId = crypto.randomUUID();
    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsPatch());

    const docs = Array.from({ length: 101 }, (_, i) => ({ id: `d-${i}`, text: "x" }));
    const res = await request(app)
      .post("/orgs/rag/score")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({ brandId, documents: docs });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/at most/);
  });

  it("returns 404 when brand-service reports the brand is missing", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const brandId = crypto.randomUUID();
    await cleanupBrandCache(orgId, brandId);

    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsPatch());
    routes.push(mockBrandExtract404());

    const res = await request(app)
      .post("/orgs/rag/score")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({
        brandId,
        documents: [{ id: "x", text: "hello" }],
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Brand not found/);
  });

  // --- Multi-brand (brandIds: string[]) ---

  it("legacy single-brand response includes both brandId and brandIds", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const brandId = crypto.randomUUID();
    await cleanupBrandCache(orgId, brandId);

    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsPatch());
    routes.push(
      mockBrandExtract({
        industry: "SaaS",
        expertise: "pricing",
        target_audience: "founders",
        voice: "data-driven",
      }),
    );
    routes.push(mockKeyServiceDecrypt());
    routes.push(mockGeminiBatchEmbed([[1, 0]]));

    const res = await request(app)
      .post("/orgs/rag/score")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({
        brandId,
        documents: [{ id: "x", text: "hello" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.brandId).toBe(brandId);
    expect(res.body.brandIds).toEqual([brandId]);

    await cleanupBrandCache(orgId, brandId);
  });

  it("multi-brand happy path: ONE query embed, ONE doc batch, canonical-sorted brandIds", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    // Pick two UUIDs and submit in REVERSE ASCII order so we can prove canonical-sort.
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const cacheKey = `${a},${b}`;
    await cleanupBrandCache(orgId, cacheKey);
    await cleanupBrandCache(orgId, a);
    await cleanupBrandCache(orgId, b);

    const queryVector = [1, 0, 0];
    const docVectors = [
      [0.99, 0.1, 0],
      [-1, 0, 0],
    ];

    const brandCapture = { headers: undefined as Record<string, string> | undefined, body: undefined as unknown };
    const embedCapture = { calls: 0, bodies: [] as unknown[] };

    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsPatch());
    routes.push(
      mockBrandExtract(
        {
          industry: "B2B SaaS",
          expertise: "pricing experiments",
          target_audience: "founders",
          voice: "data-driven",
        },
        brandCapture,
      ),
    );
    routes.push(mockKeyServiceDecrypt());
    let embedCallIdx = 0;
    routes.push({
      match: (url: string) => url.includes(":batchEmbedContents"),
      respond: (_url: string, init?: RequestInit) => {
        embedCapture.calls += 1;
        if (init?.body) embedCapture.bodies.push(JSON.parse(init.body as string));
        const idx = embedCallIdx++;
        const body = idx === 0
          ? { embeddings: [{ values: queryVector }] }
          : { embeddings: docVectors.map((v) => ({ values: v })) };
        return { ok: true, body };
      },
    });

    const res = await request(app)
      .post("/orgs/rag/score")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({
        brandIds: [b, a],
        documents: [
          { id: "doc-good", text: "perfect match" },
          { id: "doc-bad", text: "irrelevant" },
        ],
      });

    expect(res.status).toBe(200);
    // Response shape: brandIds canonical-sorted; brandId omitted on multi-brand.
    expect(res.body.brandIds).toEqual([a, b]);
    expect(res.body.brandId).toBeUndefined();
    expect(res.body.cacheHit).toBe(false);
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual(["doc-good", "doc-bad"]);

    // Exactly ONE query embed + ONE doc batch (not N per-brand).
    expect(embedCapture.calls).toBe(2);
    expect((embedCapture.bodies[0] as { requests: unknown[] }).requests).toHaveLength(1);
    expect((embedCapture.bodies[1] as { requests: unknown[] }).requests).toHaveLength(2);

    // Outbound brand-service body carries canonical-sorted brandIds.
    expect(brandCapture.body).toMatchObject({
      brandIds: [a, b],
      fields: expect.any(Array),
    });
    // Outbound x-brand-id header carries canonical CSV.
    expect(brandCapture.headers?.["x-brand-id"]).toBe(cacheKey);

    // Cache row written under canonical CSV key.
    const cached = await db
      .select()
      .from(schema.brandProfileEmbeddings)
      .where(
        and(
          eq(schema.brandProfileEmbeddings.orgId, orgId),
          eq(schema.brandProfileEmbeddings.brandId, cacheKey),
        ),
      );
    expect(cached).toHaveLength(1);
    expect(cached[0].embedding).toEqual(queryVector);

    await cleanupBrandCache(orgId, cacheKey);
  });

  it("cross-order brandIds hit the same cache row", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const a = "33333333-3333-4333-8333-333333333333";
    const b = "44444444-4444-4444-8444-444444444444";
    const cacheKey = `${a},${b}`;
    await cleanupBrandCache(orgId, cacheKey);

    const queryVector = [1, 0];
    const docVectors = [[1, 0]];

    const setup = () => {
      routes = [];
      fetchCalls = [];
      installFetchMock();
      routes.push(mockRunsCreate(crypto.randomUUID()));
      routes.push(mockRunsPatch());
      routes.push(
        mockBrandExtract({
          industry: "SaaS",
          expertise: "pricing",
          target_audience: "founders",
          voice: "data-driven",
        }),
      );
      routes.push(mockKeyServiceDecrypt());
      routes.push({
        match: (url: string) => url.includes(":batchEmbedContents"),
        respond: (_url: string, init?: RequestInit) => {
          const body = JSON.parse(init!.body as string) as { requests: unknown[] };
          return {
            ok: true,
            body:
              body.requests.length === 1
                ? { embeddings: [{ values: queryVector }] }
                : { embeddings: docVectors.map((v) => ({ values: v })) },
          };
        },
      });
    };

    // First call: [a, b]
    setup();
    const r1 = await request(app)
      .post("/orgs/rag/score")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({ brandIds: [a, b], documents: [{ id: "x", text: "hello" }] });
    expect(r1.status).toBe(200);
    expect(r1.body.cacheHit).toBe(false);
    expect(r1.body.brandIds).toEqual([a, b]);

    // Second call: [b, a] — reversed input must hit the same canonical cache row.
    setup();
    const r2 = await request(app)
      .post("/orgs/rag/score")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({ brandIds: [b, a], documents: [{ id: "x", text: "hello" }] });
    expect(r2.status).toBe(200);
    expect(r2.body.cacheHit).toBe(true);
    expect(r2.body.brandIds).toEqual([a, b]);

    await cleanupBrandCache(orgId, cacheKey);
  });

  it("when both brandIds and brandId are provided, brandIds wins", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const a = "55555555-5555-4555-8555-555555555555";
    const b = "66666666-6666-4666-8666-666666666666";
    const stray = "77777777-7777-4777-8777-777777777777";
    const cacheKey = `${a},${b}`;
    await cleanupBrandCache(orgId, cacheKey);
    await cleanupBrandCache(orgId, stray);

    const brandCapture = { headers: undefined as Record<string, string> | undefined, body: undefined as unknown };

    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsPatch());
    routes.push(
      mockBrandExtract(
        { industry: "SaaS", expertise: "pricing", target_audience: "founders", voice: "data-driven" },
        brandCapture,
      ),
    );
    routes.push(mockKeyServiceDecrypt());
    routes.push(mockGeminiBatchEmbed([[1, 0]]));

    const res = await request(app)
      .post("/orgs/rag/score")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({
        brandIds: [b, a],
        brandId: stray,
        documents: [{ id: "x", text: "hello" }],
      });

    expect(res.status).toBe(200);
    // Response reflects brandIds, ignores stray legacy brandId.
    expect(res.body.brandIds).toEqual([a, b]);
    expect(res.body.brandId).toBeUndefined();
    // Outbound brand-service body uses brandIds, not the stray legacy field.
    expect(brandCapture.body).toMatchObject({ brandIds: [a, b] });

    await cleanupBrandCache(orgId, cacheKey);
  });

  it("returns 400 when neither brandIds nor brandId is provided", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    routes.push(mockRunsCreate(crypto.randomUUID()));
    routes.push(mockRunsPatch());

    const res = await request(app)
      .post("/orgs/rag/score")
      .set(authHeaders(orgId, crypto.randomUUID()))
      .send({ documents: [{ id: "x", text: "hello" }] });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/brandIds.*brandId/);
  });
});
