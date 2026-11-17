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
process.env.CRM_SERVICE_URL = process.env.CRM_SERVICE_URL || "https://crm.test.local";
process.env.CRM_SERVICE_API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
process.env.COPILOT_FOLLOWUP_ORG_ID = "11111111-1111-4111-8111-111111111111";
process.env.COPILOT_FOLLOWUP_BRAND_ID = "22222222-2222-4222-8222-222222222222";
process.env.COPILOT_FOLLOWUP_USER_ID = "33333333-3333-4333-8333-333333333333";

const ORG = "11111111-1111-4111-8111-111111111111";
const BRAND = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const ROW_ID = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";

const { state } = vi.hoisted(() => ({
  state: {
    channelRows: [] as Array<Record<string, unknown>>,
    session: {} as Record<string, unknown>,
    sessionUpdates: [] as Array<Record<string, unknown>>,
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
    allowedTools: ["list_workflows", "present_choices", "open_page"],
    provider: "google",
    model: "flash",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const rowsFor = (table: unknown): unknown[] => {
    if (is(table, "channel_inbound_messages")) return state.channelRows;
    if (is(table, "sessions")) return [state.session];
    if (is(table, "messages")) {
      return state.messageInserts.map((m, i) => ({ id: `msg-${i + 1}`, proactiveTrigger: false, choices: null, openPages: null, creditsRequired: null, buttons: null, toolCalls: null, createdAt: new Date(Date.UTC(2026, 10, 17, 18, 0, i)), ...m }));
    }
    if (is(table, "app_configs") || is(table, "platform_configs")) return [appConfig];
    return [];
  };
  const chain = (rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> & { orderBy: () => unknown; limit: () => Promise<unknown[]> };
    p.orderBy = () => {
      const q = Promise.resolve(rows) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
      q.limit = () => Promise.resolve(rows);
      return q;
    };
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
          if (is(table, "channel_inbound_messages")) {
            if (state.channelRows.some((r) => r.messageId === v.messageId)) {
              return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }) };
            }
            const row = { id: ROW_ID, sessionId: null, replyText: null, error: null, sentAt: null, createdAt: new Date(), updatedAt: new Date(), ...v };
            state.channelRows.push(row);
            return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: row.id }]) }) };
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
            if (is(table, "channel_inbound_messages") && state.channelRows[0]) Object.assign(state.channelRows[0], s);
            if (is(table, "sessions")) {
              state.sessionUpdates.push(s);
              Object.assign(state.session, s);
            }
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

const ANSWER = "Hi! **Two** of your campaigns ran today — see [your results](https://dashboard.distribute.you/r).";

function baseRoutes(gemini: { calls: number; bodies: Array<Record<string, unknown>>; script?: unknown[][] }, app: unknown, sends: Array<{ url: string; body: Record<string, unknown> }>): MockRoute[] {
  return [
    {
      match: (url) => url.startsWith("http://127.0.0.1:") && url.endsWith("/chat"),
      respond: async (_url, init) => {
        const headers = init!.headers as Record<string, string>;
        const r = await request(app as Parameters<typeof request>[0]).post("/chat").set(headers).send(JSON.parse(init!.body as string));
        return { ok: r.status === 200, status: r.status, body: r.text, text: r.text };
      },
    },
    {
      match: (url) => url === `${process.env.CRM_SERVICE_URL}/internal/copilot/web-conversations`,
      respond: (url, init) => {
        sends.push({ url, body: JSON.parse(init!.body as string) as Record<string, unknown> });
        return { ok: true, status: 202, body: { handoffId: "h1", stored: 2, duplicates: 0, duplicate: false, status: "pending" } };
      },
    },
    {
      match: (url) => url === `${process.env.CRM_SERVICE_URL}/orgs/whatsapp/reach`,
      respond: () => ({ ok: true, body: { reachable: true, fromAccount: "+33700000000", persona: { name: "Sophie", role: null, instructions: null } } }),
    },
    {
      match: (url) => url === `${process.env.CRM_SERVICE_URL}/orgs/whatsapp/messages`,
      respond: (url, init) => {
        sends.push({ url, body: JSON.parse(init!.body as string) as Record<string, unknown> });
        return { ok: true, body: { sent: true } };
      },
    },
    { match: (url) => url.includes("/internal/users/"), respond: () => ({ ok: true, body: { user: { email: "kevin@distribute.you" } } }) },
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
        const parts = gemini.script?.[gemini.calls - 1] ?? [{ text: ANSWER }];
        return {
          ok: true,
          body: sseStream([{ candidates: [{ content: { parts } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30, totalTokenCount: 50 } }]),
        };
      },
    },
  ];
}

const SERVICE = { "x-api-key": "svc" };
const VISITOR = "v_test_visitor_0001";

function freshSession(channelPhone: string | null = null) {
  state.session = { id: SESSION, orgId: ORG, userId: USER, configKey: "copilot", channelPhone, guest: true, leadThread: false, webVisitorId: VISITOR, brandIds: [BRAND], updatedAt: new Date() };
}

describe("POST /internal/copilot/web-messages: a visitor of our site talks with the Copilot in the page (DISTRY-WEB-CHAT-1117)", () => {
  beforeEach(() => {
    vi.resetModules();
    routes = [];
    fetchCalls = [];
    state.channelRows.length = 0;
    state.messageInserts.length = 0;
    state.sessionUpdates.length = 0;
    freshSession();
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  it("a visitor writes \"hi\": the Copilot answers in the page, as a guest, on a copilot-web run under our org, never filed in the staff Unibox", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
    routes.push(...baseRoutes(gemini, app, sends));

    const res = await request(app).post("/internal/copilot/web-messages").set(SERVICE).send({ visitorId: VISITOR, messageId: "m1", text: "hi" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "answered",
      reply: "Hi! Two of your campaigns ran today, see your results: https://dashboard.distribute.you/r.",
      handOff: null,
      continuedOn: null,
    });

    const chatCall = fetchCalls.find((c) => c.url.endsWith("/chat"))!;
    expect(JSON.parse(chatCall.init!.body as string)).toMatchObject({ configKey: "copilot", message: "hi", sessionId: SESSION, channelMessageId: ROW_ID, webVisitorId: VISITOR });
    const runCreate = fetchCalls.find((c) => c.url.endsWith("/v1/runs") && c.init?.method === "POST")!;
    expect(JSON.parse(runCreate.init!.body as string)).toMatchObject({ serviceName: "chat-service", taskName: "copilot-web" });
    expect((runCreate.init!.headers as Record<string, string>)["x-org-id"]).toBe(ORG);

    // The model writes for the page, sees no account tool, can hand over to WhatsApp.
    const sent = JSON.stringify(gemini.bodies[0]);
    expect(sent).toContain("Channel: our website");
    const declared = ((gemini.bodies[0].tools as Array<{ functionDeclarations?: Array<{ name: string }> }>) ?? []).flatMap((t) => t.functionDeclarations ?? []).map((d) => d.name);
    expect(declared).toEqual(["continue_on_channel"]);
    expect(fetchCalls.some((c) => c.url.includes("/internal/copilot/messages"))).toBe(false);
    expect(sends).toEqual([]);

    // A retry of the same message runs nothing twice.
    const retry = await request(app).post("/internal/copilot/web-messages").set(SERVICE).send({ visitorId: VISITOR, messageId: "m1", text: "hi" });
    expect(retry.body).toMatchObject({ status: "answered", reply: res.body.reply });
    expect(gemini.calls).toBe(1);
  }, 30_000);

  it("the visitor gives their WhatsApp number: it is tied to the conversation and the answer also leaves on WhatsApp from our line", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = {
      calls: 0,
      bodies: [] as Array<Record<string, unknown>>,
      script: [[{ functionCall: { name: "continue_on_channel", args: { phone: "+33 6 12 34 56 78" } }, thoughtSignature: "sig" }], [{ text: "Great, I am writing to you on WhatsApp now." }]],
    };
    const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
    routes.push(...baseRoutes(gemini, app, sends));

    const res = await request(app).post("/internal/copilot/web-messages").set(SERVICE).send({ visitorId: VISITOR, messageId: "m2", text: "my whatsapp is +33 6 12 34 56 78" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "answered", handOff: { channel: "whatsapp", delivered: true, reason: null }, continuedOn: "whatsapp", askForContact: false });
    expect(state.sessionUpdates.some((u) => u.channelPhone === "+33612345678")).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].body).toMatchObject({ phone: "+33612345678", fromAccount: "+33700000000", text: "Great, I am writing to you on WhatsApp now." });
  }, 30_000);

  it("the visitor gives their email: the page conversation goes to their thread in crm (a Lead event writes by email), nothing is emailed from here", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = {
      calls: 0,
      bodies: [] as Array<Record<string, unknown>>,
      script: [[{ functionCall: { name: "continue_on_channel", args: { email: "K.Lourd+webprobe@Example.com" } }, thoughtSignature: "sig" }], [{ text: "Thanks, our next message reaches you by email shortly." }]],
    };
    const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
    routes.push(...baseRoutes(gemini, app, sends));

    const res = await request(app).post("/internal/copilot/web-messages").set(SERVICE).send({ visitorId: VISITOR, messageId: "m3", text: "write me at K.Lourd+webprobe@Example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "answered", handOff: { channel: "email", delivered: true, reason: null }, continuedOn: "email", messagesLeft: null });
    expect(state.sessionUpdates.some((u) => u.channelEmail === "k.lourd+webprobe@example.com")).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].url).toBe(`${process.env.CRM_SERVICE_URL}/internal/copilot/web-conversations`);
    const body = sends[0].body as { conversationId: string; visitorId: string; email: string; messages: Array<{ role: string; text: string; messageId: string; at: string }> };
    expect(body).toMatchObject({ conversationId: SESSION, visitorId: VISITOR, email: "k.lourd+webprobe@example.com" });
    expect(body.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "write me at K.Lourd+webprobe@Example.com"],
      ["assistant", "Thanks, our next message reaches you by email shortly."],
    ]);
    expect(fetchCalls.some((c) => c.url.includes("/orgs/whatsapp/"))).toBe(false);
  }, 30_000);

  it("a visitor id that is not one is refused before anything runs", async () => {
    const app = (await import("../../src/index.js")).default;
    const res = await request(app).post("/internal/copilot/web-messages").set(SERVICE).send({ visitorId: "short", messageId: "m1", text: "hi" });
    expect(res.status).toBe(400);
    expect(fetchCalls).toEqual([]);
  });

  it("POST /chat refuses webVisitorId without the website message being answered", async () => {
    const app = (await import("../../src/index.js")).default;
    routes.push(...baseRoutes({ calls: 0, bodies: [] }, app, []));
    const res = await request(app)
      .post("/chat")
      .set({ "x-api-key": "k", "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN })
      .send({ configKey: "copilot", message: "hi", sessionId: SESSION, webVisitorId: VISITOR });
    expect(res.status).toBe(400);
    expect(state.messageInserts).toEqual([]);
  });
});
