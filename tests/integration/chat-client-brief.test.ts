import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";
process.env.BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY || "test-billing-key";
process.env.BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "https://billing.test.local";
process.env.CLIENT_SERVICE_URL = process.env.CLIENT_SERVICE_URL || "https://client.test.local";
process.env.CLIENT_SERVICE_API_KEY = process.env.CLIENT_SERVICE_API_KEY || "test-client-key";

// SOPHIE-JCURVE-1102 (prod 2026-11-01): a returning signup asked "what should I
// do next?" and was asked what his company sells, its website on file. A turn
// of a chat that speaks for us now starts with the client brief. Staff test org
// fixtures only (STAFF TEST - Email Sending E2E, brand Reed).
const SESSION = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const REED = "00000000-0000-4000-8000-0000000000a1";

vi.mock("../../src/lib/skills.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/skills.js")>("../../src/lib/skills.js");
  return { ...actual, buildSkillIndexBlock: vi.fn(async () => "\n\n---\n## Skills (test index)") };
});

vi.mock("../../src/db/index.js", () => {
  const appConfig = {
    id: "cfg-1",
    orgId: "org-1",
    key: "copilot",
    systemPrompt: "Be useful.",
    allowedTools: ["read_skill", "list_brands"],
    provider: "google",
    model: "flash",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([appConfig])),
          limit: vi.fn(() => Promise.resolve([appConfig])),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => {
          const p = Promise.resolve() as Promise<void> & { returning: () => Promise<Array<{ id: string; createdAt: Date }>> };
          p.returning = () => Promise.resolve([{ id: SESSION, createdAt: new Date() }]);
          return p;
        }),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      query: { messages: { findMany: vi.fn(() => Promise.resolve([])) } },
    },
  };
});

interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown };
}
let routes: MockRoute[] = [];
const geminiBodies: string[] = [];
const extractBodies: unknown[] = [];

function sse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const payload = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(payload)); c.close(); } });
}

function installFetchMock() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const r of routes) {
      if (!r.match(url, init)) continue;
      const out = r.respond(url, init);
      const text = typeof out.body === "string" ? out.body : JSON.stringify(out.body);
      return {
        ok: out.ok, status: out.status ?? (out.ok ? 200 : 500), headers: new Headers(),
        json: () => Promise.resolve(out.body), text: () => Promise.resolve(text),
        body: out.body instanceof ReadableStream ? out.body : undefined,
      } as unknown as Response;
    }
    throw new Error(`[test] Unmocked fetch: ${url}`);
  }));
}

function routesFor(site: { ok: boolean; body: unknown }): MockRoute[] {
  return [
    { match: (u) => u.includes("/keys/google/decrypt"), respond: () => ({ ok: true, body: { provider: "google", key: "k", keySource: "platform" } }) },
    { match: (u, i) => u.endsWith("/v1/runs") && i?.method === "POST", respond: () => ({ ok: true, status: 201, body: { id: RUN, status: "running" } }) },
    { match: (u, i) => /\/v1\/runs\/[^/]+$/.test(u) && i?.method === "PATCH", respond: () => ({ ok: true, body: {} }) },
    { match: (u) => /\/v1\/runs\/[^/]+\/events$/.test(u), respond: () => ({ ok: true, status: 201, body: { id: "e" } }) },
    {
      match: (u, i) => /\/v1\/runs\/[^/]+\/costs$/.test(u) && i?.method === "POST",
      respond: (_u, i) => {
        const body = JSON.parse(i!.body as string) as { items: unknown[] };
        return { ok: true, status: 201, body: { costs: body.items.map((it, n) => ({ id: `c-${n}`, ...(it as object) })) } };
      },
    },
    { match: (u, i) => /\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(u) && i?.method === "PATCH", respond: () => ({ ok: true, body: {} }) },
    { match: (u) => u.includes("/v1/customer_balance/authorize"), respond: () => ({ ok: true, body: { sufficient: true, balance_cents: "100000", required_cents: "1" } }) },
    { match: (u) => u.includes("/internal/copilot/messages") || u.includes("/internal/users/"), respond: () => ({ ok: true, body: {} }) },
    {
      match: (u, i) => u === "https://api.test.local/v1/brands" && (i?.method ?? "GET") === "GET",
      respond: () => ({ ok: true, body: { brands: [{ id: REED, name: "Reed", domain: "reed.example", brandUrl: "https://reed.example" }] } }),
    },
    {
      match: (u) => u.startsWith(`https://api.test.local/v1/brands/${REED}/offers`),
      respond: () => ({ ok: true, body: { offers: [{ name: "Default Offer", status: "active", description: null }] } }),
    },
    {
      match: (u, i) => u === "https://api.test.local/v1/brands/extract-fields" && i?.method === "POST",
      respond: (_u, i) => {
        extractBodies.push(JSON.parse(i!.body as string));
        return site;
      },
    },
    {
      match: (u) => u.includes(":streamGenerateContent"),
      respond: (_u, i) => {
        geminiBodies.push(String(i?.body ?? ""));
        return { ok: true, body: sse([{ candidates: [{ content: { parts: [{ text: "Reed sells ERP to finance teams: let us pick who to reach." }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }]) };
      },
    },
  ];
}

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "parent-run-1" };

describe("POST /chat: the client brief (SOPHIE-JCURVE-1102)", () => {
  beforeEach(() => {
    vi.resetModules();
    routes = [];
    geminiBodies.length = 0;
    extractBodies.length = 0;
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  it("the model starts knowing what the client sells and who buys, read from their website", async () => {
    routes.push(...routesFor({ ok: true, body: { fields: { whatTheySell: { value: "An ERP for growing companies." }, whoBuys: { value: "Finance teams of mid-sized firms." } } } }));
    const app = (await import("../../src/index.js")).default;
    const res = await request(app).post("/chat").set(AUTH).send({ configKey: "copilot", message: "what should I do next?" });
    expect(res.status).toBe(200);
    expect(extractBodies).toEqual([{ brandIds: [REED], fields: expect.arrayContaining([expect.objectContaining({ key: "whatTheySell" })]) }]);
    const prompt = geminiBodies[0];
    expect(prompt).toContain("Your client's business");
    expect(prompt).toContain("What they sell: An ERP for growing companies.");
    expect(prompt).toContain("Who buys from them: Finance teams of mid-sized firms.");
    expect(prompt).toContain("Offer \\\"Default Offer\\\": no description yet");
  }, 30_000);

  it("a website read that fails is stated to the model, and the turn still answers", async () => {
    routes.push(...routesFor({ ok: false, body: { error: "scrape failed" } }));
    const app = (await import("../../src/index.js")).default;
    const res = await request(app).post("/chat").set(AUTH).send({ configKey: "copilot", message: "hi" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Reed sells ERP");
    expect(geminiBodies[0]).toContain("Their website could not be read for this turn");
  }, 30_000);
});
