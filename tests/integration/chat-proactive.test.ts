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
process.env.CAMPAIGN_SERVICE_URL = process.env.CAMPAIGN_SERVICE_URL || "https://campaign.test.local";
process.env.CAMPAIGN_SERVICE_API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-campaign-key";

const ORG = "11111111-1111-4111-8111-111111111111";
const BRAND = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TURN_ID = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";

const { state } = vi.hoisted(() => ({
  state: {
    turns: [] as Array<Record<string, unknown>>,
    messageInserts: [] as Array<Record<string, unknown>>,
    tables: {} as Record<string, unknown>,
  },
}));

vi.mock("../../src/db/index.js", async () => {
  const { getTableName } = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  // Tables are compared by NAME: vi.resetModules gives each test a fresh schema module.
  const is = (table: unknown, name: string) => getTableName(table as Parameters<typeof getTableName>[0]) === name;
  const appConfig = {
    id: "cfg-1",
    orgId: ORG,
    key: "copilot",
    systemPrompt: "Be useful.",
    // Read tools, write tools, starting tools and UI tools mixed: the proactive turn keeps the reads only.
    allowedTools: ["list_workflows", "launch_campaign", "propose_switch_on", "confirm_switch_on", "create_followup", "present_choices", "open_page"],
    provider: "google",
    model: "flash",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const session = { id: SESSION, orgId: ORG, userId: USER, channelPhone: null, guest: false, brandIds: [BRAND], updatedAt: new Date() };
  const rowsFor = (table: unknown): unknown[] => {
    if (is(table, "copilot_proactive_turns")) return state.turns;
    if (is(table, "sessions")) return [session];
    if (is(table, "app_configs") || is(table, "platform_configs")) return [appConfig];
    return [];
  };
  const chain = (rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> & { orderBy: () => unknown; limit: () => Promise<unknown[]> };
    p.orderBy = () => ({ limit: () => Promise.resolve(rows) });
    p.limit = () => Promise.resolve(rows);
    return p;
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({ where: vi.fn(() => chain(rowsFor(table))), limit: vi.fn(() => Promise.resolve(rowsFor(table))) })),
      })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((v: Record<string, unknown>) => {
          if (is(table, "copilot_proactive_turns")) {
            const row = { id: TURN_ID, replyText: null, error: null, createdAt: new Date(), updatedAt: new Date(), ...v };
            state.turns.push(row);
            return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([row]) }) };
          }
          if (is(table, "messages")) state.messageInserts.push(v);
          const p = Promise.resolve() as Promise<void> & { returning: () => Promise<Array<{ id: string; createdAt: Date }>> };
          p.returning = () => Promise.resolve([{ id: `msg-${state.messageInserts.length}`, createdAt: new Date() }]);
          return p;
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((s: Record<string, unknown>) => ({
          where: vi.fn(() => {
            if (is(table, "copilot_proactive_turns") && state.turns[0]) Object.assign(state.turns[0], s);
            const p = Promise.resolve() as Promise<void> & { returning: () => Promise<unknown[]> };
            p.returning = () => Promise.resolve([]);
            return p;
          }),
        })),
      })),
      query: { messages: { findMany: vi.fn(() => Promise.resolve([])) } },
    },
  };
});

interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status?: number; body: unknown; text?: string }> | { ok: boolean; status?: number; body: unknown; text?: string };
}
let routes: MockRoute[] = [];
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function sseStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const payload = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(payload)); c.close(); } });
}

function installFetchMock() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });
    for (const r of routes) {
      if (!r.match(url, init)) continue;
      const out = await r.respond(url, init);
      const text = out.text ?? (typeof out.body === "string" ? out.body : JSON.stringify(out.body));
      return {
        ok: out.ok, status: out.status ?? (out.ok ? 200 : 500),
        json: () => Promise.resolve(out.body), text: () => Promise.resolve(text), headers: new Headers(),
        body: out.body instanceof ReadableStream ? out.body : undefined,
      } as unknown as Response;
    }
    throw new Error(`[test] Unmocked fetch: ${url}`);
  }));
}

const PROPOSAL = "Marie Dupont from Acme wrote on email: \"Can you run our outbound?\" I suggest the Outbound offer with a $10/day cap. Go?";

function baseRoutes(gemini: { calls: number; bodies: Array<Record<string, unknown>> }, app: unknown): MockRoute[] {
  return [
    // The turn runs through POST /chat on this same process.
    {
      match: (url) => url.startsWith("http://127.0.0.1:") && url.endsWith("/chat"),
      respond: async (_url, init) => {
        const headers = init!.headers as Record<string, string>;
        const r = await request(app as Parameters<typeof request>[0]).post("/chat").set(headers).send(JSON.parse(init!.body as string));
        return { ok: r.status === 200, status: r.status, body: r.text, text: r.text };
      },
    },
    // campaign-service: the asking STEP (x-campaign-id) and its funnel campaign, as list_campaigns names it.
    {
      match: (url) => url === `${process.env.CAMPAIGN_SERVICE_URL}/campaigns/camp-1`,
      respond: () => ({ ok: true, body: { campaign: { id: "camp-1", name: "Lead Proposal Deals sfc-1 - ai-lead-proposal", featureSlug: "ai-lead-proposal", salesFunnelCampaignId: "sfc-1" } } }),
    },
    {
      match: (url) => url === `${process.env.CAMPAIGN_SERVICE_URL}/sales-funnel-campaigns/sfc-1`,
      respond: () => ({ ok: true, body: { salesFunnelCampaign: { id: "sfc-1", salesFunnelId: "start_to_paid_client@ai-lead-proposal", salesFunnelName: "Lead Proposal Deals" } } }),
    },
    { match: (url) => url.includes("/internal/users/"), respond: () => ({ ok: true, body: { user: { email: "owner@acme.example" } } }) },
    { match: (url) => url.includes("/keys/google/decrypt"), respond: () => ({ ok: true, body: { provider: "google", key: "fake", keySource: "platform" } }) },
    { match: (url, init) => url.endsWith("/v1/runs") && init?.method === "POST", respond: () => ({ ok: true, status: 201, body: { id: RUN, status: "running" } }) },
    { match: (url, init) => /\/v1\/runs\/[^/]+$/.test(url) && init?.method === "PATCH", respond: () => ({ ok: true, body: {} }) },
    { match: (url) => /\/v1\/runs\/[^/]+\/events$/.test(url), respond: () => ({ ok: true, status: 201, body: { id: "e" } }) },
    {
      match: (url, init) => /\/v1\/runs\/[^/]+\/costs$/.test(url) && init?.method === "POST",
      respond: (_url, init) => {
        const body = JSON.parse(init!.body as string) as { items: unknown[] };
        return { ok: true, status: 201, body: { costs: body.items.map((it, i) => ({ id: `c-${i}`, ...(it as object) })) } };
      },
    },
    { match: (url, init) => /\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(url) && init?.method === "PATCH", respond: () => ({ ok: true, body: {} }) },
    { match: (url) => url.includes("/v1/customer_balance/authorize"), respond: () => ({ ok: true, body: { sufficient: true, balance_cents: "100000", required_cents: "1" } }) },
    { match: (url) => url.includes("/internal/copilot/messages"), respond: () => ({ ok: true, body: {} }) },
    {
      match: (url) => url.includes(":streamGenerateContent"),
      respond: (_url, init) => {
        gemini.calls += 1;
        gemini.bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        return {
          ok: true,
          body: sseStream([{ candidates: [{ content: { parts: [{ text: PROPOSAL }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30, totalTokenCount: 50 } }]),
        };
      },
    },
  ];
}

const HEADERS = { "x-api-key": "svc", "x-run-id": RUN, "x-org-id": ORG, "x-campaign-id": "camp-1", "x-workflow-slug": "hot-lead-proposal-v1" };
const BODY = {
  kind: "hot_lead",
  idempotencyKey: "fact-123",
  orgId: ORG,
  brandId: BRAND,
  lead: { leadId: "lead-9", email: "marie@acme.example", name: "Marie Dupont", company: "Acme" },
  inbound: { channel: "email", text: "Can you run our outbound?", at: "2026-10-19T09:00:00Z" },
};

describe("POST /internal/copilot/proactive-turns — the Copilot writes first to the brand's team", () => {
  beforeEach(() => {
    vi.resetModules();
    routes = [];
    fetchCalls = [];
    state.turns.length = 0;
    state.messageInserts.length = 0;
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes exactly one assistant turn ending on a request for go, with read tools only; a retry writes nothing", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    routes.push(...baseRoutes(gemini, app));

    const first = await request(app).post("/internal/copilot/proactive-turns").set(HEADERS).send(BODY);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ id: TURN_ID, status: "processing", duplicate: false, recipientUserId: USER, sessionId: SESSION, delivery: "web" });
    await vi.waitFor(() => expect(state.turns[0].status).toBe("delivered"), { timeout: 20_000 });

    // One hidden trigger + one assistant answer in the recipient's thread.
    const assistant = state.messageInserts.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(String(assistant[0].content).trim().endsWith("?")).toBe(true);
    expect(state.turns[0].replyText).toBe(PROPOSAL);
    const trigger = state.messageInserts.find((m) => m.role === "user")!;
    expect(trigger.proactiveTrigger).toBe(true);
    expect(trigger.content).toContain("Marie Dupont");
    expect(trigger.content).toContain("asking the team for their go");
    // The asking campaign is named the way the team (and list_campaigns) sees it.
    expect(trigger.content).toContain('The campaign that asked you is "Lead Proposal Deals" (funnel start_to_paid_client@ai-lead-proposal, channel ai-lead-proposal): it IS this notification');

    // The model was offered reads only: no create/start/send tool, no cards.
    const declared = (gemini.bodies[0].tools as Array<{ function_declarations?: Array<{ name: string }>; functionDeclarations?: Array<{ name: string }> }>)
      .flatMap((t) => t.function_declarations ?? t.functionDeclarations ?? [])
      .map((d) => d.name);
    expect(declared).toEqual(["list_workflows"]);

    // The turn is billed as a child of the step's run, attributed to its campaign.
    const chatCall = fetchCalls.find((c) => c.url.endsWith("/chat"))!;
    expect((chatCall.init!.headers as Record<string, string>)["x-run-id"]).toBe(RUN);
    expect((chatCall.init!.headers as Record<string, string>)["x-campaign-id"]).toBe("camp-1");
    expect((chatCall.init!.headers as Record<string, string>)["x-user-id"]).toBe(USER);

    // The campaign that woke the Copilot is not read as one the user launched.
    expect(fetchCalls.some((c) => c.url.includes("/v1/campaigns/camp-1"))).toBe(false);
    // Resolved twice: once to name it in the trigger, once by /chat to hide it from the turn's reads.
    expect(fetchCalls.filter((c) => c.url === `${process.env.CAMPAIGN_SERVICE_URL}/campaigns/camp-1`)).toHaveLength(2);

    const geminiCalls = gemini.calls;
    const inserted = state.messageInserts.length;
    const retry = await request(app).post("/internal/copilot/proactive-turns").set(HEADERS).send(BODY);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ id: TURN_ID, duplicate: true, status: "delivered" });
    expect(gemini.calls).toBe(geminiCalls);
    expect(state.messageInserts.length).toBe(inserted);
    expect(state.turns).toHaveLength(1);
  }, 30_000);

  it("POST /chat refuses a proactiveTurnId that names no turn in progress for this session", async () => {
    const app = (await import("../../src/index.js")).default;
    routes.push(...baseRoutes({ calls: 0, bodies: [] }, app));
    const res = await request(app)
      .post("/chat")
      .set({ "x-api-key": "k", "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN })
      .send({ configKey: "copilot", message: "hi", sessionId: SESSION, proactiveTurnId: TURN_ID });
    expect(res.status).toBe(400);
    expect(state.messageInserts).toEqual([]);
  });

  it("refuses a mismatched x-org-id and a lead with no id", async () => {
    const app = (await import("../../src/index.js")).default;
    const wrongOrg = await request(app).post("/internal/copilot/proactive-turns").set({ ...HEADERS, "x-org-id": BRAND }).send(BODY);
    expect(wrongOrg.status).toBe(400);
    const noLead = await request(app).post("/internal/copilot/proactive-turns").set(HEADERS).send({ ...BODY, lead: { name: "x" } });
    expect(noLead.status).toBe(400);
    expect(state.turns).toEqual([]);
  });
});
