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
process.env.COPILOT_FOLLOWUP_ORG_ID = process.env.COPILOT_FOLLOWUP_ORG_ID || "99999999-9999-4999-8999-999999999990";
process.env.COPILOT_FOLLOWUP_BRAND_ID = process.env.COPILOT_FOLLOWUP_BRAND_ID || "99999999-9999-4999-8999-999999999991";
process.env.COPILOT_FOLLOWUP_USER_ID = process.env.COPILOT_FOLLOWUP_USER_ID || "99999999-9999-4999-8999-999999999992";
process.env.TELEGRAM_BOT_TOKEN = "123:test";

const ORG = "11111111-1111-4111-8111-111111111111";
const BRAND = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const ROW_ID = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";

const { state } = vi.hoisted(() => ({
  state: {
    channelRows: [] as Array<Record<string, unknown>>,
    messageInserts: [] as Array<Record<string, unknown>>,
    tables: {} as Record<string, unknown>,
    /** The session the db serves (null = the linked member's own thread). */
    session: null as Record<string, unknown> | null,
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
  const session = { id: SESSION, orgId: ORG, userId: USER, channelPhone: null, guest: false, brandIds: [BRAND], updatedAt: new Date() };
  const rowsFor = (table: unknown): unknown[] => {
    if (is(table, "channel_inbound_messages")) return state.channelRows;
    if (is(table, "sessions")) return [state.session ?? session];
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

function baseRoutes(gemini: { calls: number; bodies: Array<Record<string, unknown>> }, app: unknown, sends: Array<{ url: string; body: Record<string, unknown> }>, linked: boolean): MockRoute[] {
  return [
    // DISTRY-GUEST-CAPS-1119: an account's turn asks billing whether the org pays (a paying client is never capped).
    { match: (url) => url.includes("/internal/accounts/by-org/") && url.endsWith("/cash"), respond: () => ({ ok: true, body: { cash_paid_cents: 5000, credited_cents: 5000, non_cash_credit_cents: 0 } }) },
    // SOLO-PLAN-1125: billing's solo-plan verdict, read on every Distry turn of an account (this one is not on the plan).
    { match: (url) => url.includes("/internal/accounts/by-org/") && url.endsWith("/solo-plan/ai-gate"), respond: () => ({ ok: true, body: { on_solo_plan: false, plan: null, may_use_our_keys: true, refused_reason: null, debt_cents: null, debt_limit_cents: null, upgrade_url: null, next_step: null } }) },
    {
      match: (url) => url.startsWith("http://127.0.0.1:") && url.endsWith("/chat"),
      respond: async (_url, init) => {
        const headers = init!.headers as Record<string, string>;
        const r = await request(app as Parameters<typeof request>[0]).post("/chat").set(headers).send(JSON.parse(init!.body as string));
        return { ok: r.status === 200, status: r.status, body: r.text, text: r.text };
      },
    },
    // client-service: which org this chat is linked to, then the reply to that org's chat.
    {
      match: (url) => url === `${process.env.CLIENT_SERVICE_URL}/internal/owner-telegram/chats/12345`,
      respond: () => ({ ok: true, body: { links: linked ? [{ orgId: ORG, orgName: "STAFF TEST", userId: USER, linkedAt: "2026-11-03T00:00:00.000Z" }] : [] } }),
    },
    // The reply goes to the chat that wrote, through the platform bot.
    {
      match: (url) => url === "https://api.telegram.org/bot123:test/sendMessage",
      respond: (url, init) => {
        sends.push({ url, body: JSON.parse(init!.body as string) as Record<string, unknown> });
        return { ok: true, body: { ok: true, result: { message_id: 9 } } };
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
        return {
          ok: true,
          body: sseStream([{ candidates: [{ content: { parts: [{ text: ANSWER }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30, totalTokenCount: 50 } }]),
        };
      },
    },
  ];
}

const WEBHOOK = { "x-api-key": "test-key" };

describe("POST /internal/copilot/telegram-messages: a linked client talks with the Copilot in Telegram (SOPHIE-TELEGRAM-1103)", () => {
  beforeEach(() => {
    vi.resetModules();
    routes = [];
    fetchCalls = [];
    state.channelRows.length = 0;
    state.messageInserts.length = 0;
    state.session = null;
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  it("a linked chat writes \"hi\": the Copilot answers as the member who linked it, in their thread, and the answer reaches the chat in plain text", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
    routes.push(...baseRoutes(gemini, app, sends, true));

    const res = await request(app).post("/internal/copilot/telegram-messages").set(WEBHOOK).send({ chatId: 12345, messageId: 7, text: "hi" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted" });
    await vi.waitFor(() => expect(state.channelRows[0].status).toBe("answered"), { timeout: 20_000 });

    // The turn ran as the linker, in the person's own Copilot thread, billed to their org.
    const chatCall = fetchCalls.find((c) => c.url.endsWith("/chat"))!;
    const h = chatCall.init!.headers as Record<string, string>;
    expect(h["x-org-id"]).toBe(ORG);
    expect(h["x-user-id"]).toBe(USER);
    expect(JSON.parse(chatCall.init!.body as string)).toMatchObject({ configKey: "copilot", message: "hi", sessionId: SESSION, channelMessageId: ROW_ID });
    const runCreate = fetchCalls.find((c) => c.url.endsWith("/v1/runs") && c.init?.method === "POST")!;
    expect(JSON.parse(runCreate.init!.body as string)).toMatchObject({ serviceName: "chat-service", taskName: "copilot-telegram" });
    expect((runCreate.init!.headers as Record<string, string>)["x-org-id"]).toBe(ORG);

    // The model was told it writes in Telegram (plain text), and the person's words are stored as theirs.
    expect(JSON.stringify(gemini.bodies[0])).toContain("Channel: Telegram");
    const userMsg = state.messageInserts.find((m) => m.role === "user")!;
    expect(userMsg.content).toBe("hi");
    expect(userMsg.proactiveTrigger ?? false).toBe(false);

    // One reply to the org's linked chat, no markup, no long dash.
    expect(sends).toHaveLength(1);
    expect(sends[0].body.text).toBe("Hi! Two of your campaigns ran today, see your results: https://dashboard.distribute.you/r.");
    expect(state.channelRows[0].sentAt).toBeInstanceOf(Date);

    // A webhook retry of the same message runs nothing twice.
    const retry = await request(app).post("/internal/copilot/telegram-messages").set(WEBHOOK).send({ chatId: 12345, messageId: 7, text: "hi" });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ status: "duplicate" });
    expect(gemini.calls).toBe(1);
  }, 30_000);

  it("a chat linked to no account opens the bot: Distry answers it as a guest on our line, ready to sign them up (DISTRY-START-DOOR-1125)", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
    routes.push(...baseRoutes(gemini, app, sends, false));
    const LINE_ORG = process.env.COPILOT_FOLLOWUP_ORG_ID!;
    const LINE_USER = process.env.COPILOT_FOLLOWUP_USER_ID!;
    // The chat's own conversation: a guest under our line, tied to the chat.
    state.session = { id: SESSION, orgId: LINE_ORG, userId: LINE_USER, channelPhone: null, guest: true, telegramChatId: "12345", leadThread: false, planOrgId: null, brandIds: [BRAND], updatedAt: new Date() };
    const res = await request(app).post("/internal/copilot/telegram-messages").set(WEBHOOK).send({ chatId: "12345", messageId: "8", text: "/start" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(["answered", "failed"]).toContain(state.channelRows[0].status), { timeout: 20_000 });
    expect(state.channelRows[0].error ?? null).toBeNull();
    expect(state.channelRows[0].status).toBe("answered");

    const chatCall = fetchCalls.find((c) => c.url.endsWith("/chat"))!;
    expect((chatCall.init!.headers as Record<string, string>)["x-org-id"]).toBe(LINE_ORG);
    // The model reads the guest door: not tied to any account, the sign-in right in this chat.
    const prompt = JSON.stringify(gemini.bodies[0]);
    expect(prompt).toContain("in the chat this person opened with our bot");
    expect(prompt).toContain("This Telegram chat is NOT tied to any distribute.you account yet");
    expect(prompt).toContain("start_sign_in");
    // /start is our opening trigger, stored hidden, never their words.
    const userMsg = state.messageInserts.find((m) => m.role === "user")!;
    expect(String(userMsg.content)).toContain("they just opened this chat from distribute.you");
    expect(userMsg.proactiveTrigger).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].body.chat_id).toBe("12345");
  }, 30_000);

  it("POST /chat refuses a channelMessageId that names no Telegram message being answered", async () => {
    const app = (await import("../../src/index.js")).default;
    routes.push(...baseRoutes({ calls: 0, bodies: [] }, app, [], true));
    const res = await request(app)
      .post("/chat")
      .set({ "x-api-key": "test-key", "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN })
      .send({ configKey: "copilot", message: "hi", sessionId: SESSION, channelMessageId: ROW_ID });
    expect(res.status).toBe(400);
    expect(state.messageInserts).toEqual([]);
  });
});
