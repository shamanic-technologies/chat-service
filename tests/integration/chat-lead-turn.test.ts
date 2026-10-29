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
    leadTurns: [] as Array<Record<string, unknown>>,
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
    // Read tools, write tools and UI tools mixed: a lead turn never gets the UI tools.
    allowedTools: ["list_workflows", "launch_campaign", "propose_switch_on", "confirm_switch_on", "create_followup", "present_choices", "open_page"],
    provider: "google",
    model: "flash",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const session = { id: SESSION, orgId: ORG, userId: USER, channelPhone: null, guest: false, brandIds: [BRAND], updatedAt: new Date() };
  const rowsFor = (table: unknown): unknown[] => {
    if (is(table, "copilot_proactive_turns")) return state.turns;
    if (is(table, "copilot_lead_turns")) return state.leadTurns;
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
          if (is(table, "copilot_lead_turns")) {
            const row = { id: TURN_ID, sessionId: null, accountOrgId: null, accountUserId: null, signedIn: false, answer: null, model: null, error: null, createdAt: new Date(), updatedAt: new Date(), ...v };
            state.leadTurns.push(row);
            return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: row.id }]) }) };
          }
          if (is(table, "sessions")) {
            const p = Promise.resolve() as Promise<void> & { returning: () => Promise<Array<{ id: string }>> };
            p.returning = () => Promise.resolve([{ id: SESSION }]);
            return p;
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
            if (is(table, "copilot_lead_turns") && state.leadTurns[0]) Object.assign(state.leadTurns[0], s);
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


const OUR_BRAND = "77777777-7777-4777-8777-777777777777";
const PHONE = "+33600000001";

type GeminiReply = { text?: string; call?: { name: string; args: Record<string, unknown> } };

function baseRoutes(gemini: { bodies: Array<Record<string, unknown>>; replies: GeminiReply[] }, app: unknown, account: { orgId: string; userId: string } | null): MockRoute[] {
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
      match: (url) => url.includes("/internal/phone-accounts"),
      respond: () => (account ? { ok: true, body: account } : { ok: false, status: 404, body: { error: "none" } }),
    },
    { match: (url) => url.includes("/internal/users?email="), respond: () => ({ ok: true, body: { users: [] } }) },
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
        gemini.bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        const reply = gemini.replies.shift() ?? { text: "I would write something." };
        const part = reply.call ? { functionCall: reply.call } : { text: reply.text };
        return {
          ok: true,
          body: sseStream([{ candidates: [{ content: { parts: [part] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30, totalTokenCount: 50 } }]),
        };
      },
    },
  ];
}

const HEADERS = { "x-api-key": "svc", "x-run-id": RUN, "x-org-id": ORG, "x-user-id": USER, "x-campaign-id": "camp-1", "x-workflow-slug": "lead-follow-up-v3" };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { decision: { type: "string", enum: ["write", "later", "stop"] }, message: { type: "string" } },
  required: ["decision", "message"],
};
const BODY = {
  idempotencyKey: "occ-1",
  brandId: BRAND,
  medium: "whatsapp",
  recipient: { email: "lead@acme.example", phone: PHONE, name: "Aakash" },
  assistant: { name: "Sophie", role: "Assistant", instructions: null },
  systemPrompt: "THE GAME: answer what they said, one step forward.",
  message: "Thread: them: is there a free trial?",
  responseSchema: SCHEMA,
  messageField: "message",
};
const ANSWER = { decision: "write", message: "Yes: you start with free credit, no card." };
const declaredNames = (b: Record<string, unknown>) =>
  (b.tools as Array<{ function_declarations?: Array<{ name: string }>; functionDeclarations?: Array<{ name: string }> }>)
    .flatMap((t) => t.function_declarations ?? t.functionDeclarations ?? [])
    .map((d) => d.name);

describe("POST /internal/copilot/lead-turns: the Copilot writes the Lead event answer (ONE-AI-CONVERSES-1029)", () => {
  beforeEach(() => {
    vi.resetModules();
    routes = [];
    fetchCalls = [];
    state.turns.length = 0;
    state.leadTurns.length = 0;
    state.messageInserts.length = 0;
    delete process.env.COPILOT_FOLLOWUP_BRAND_ID;
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  it("another brand's lead: the answer only, the game in the prompt, re-asked once when it answers in text; a retry runs nothing", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = { bodies: [] as Array<Record<string, unknown>>, replies: [{ text: "Sure, here is my answer." }, { call: { name: "answer_person", args: ANSWER } }] as GeminiReply[] };
    routes.push(...baseRoutes(gemini, app, { orgId: ORG, userId: USER }));

    const res = await request(app).post("/internal/copilot/lead-turns").set(HEADERS).send(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ json: ANSWER, account: null, signedIn: false, duplicate: false });
    expect(gemini.bodies).toHaveLength(2);
    expect(declaredNames(gemini.bodies[0])).toEqual(["answer_person"]);
    const system = JSON.stringify(gemini.bodies[0].systemInstruction);
    expect(system).toContain("THE GAME: answer what they said");
    expect(system).toContain("is there a free trial?");
    expect(system).toContain("not as distribute.you");
    // Another brand's lead: no account of ours is looked up.
    expect(fetchCalls.some((c) => c.url.includes("/internal/phone-accounts"))).toBe(false);
    // The caller's work: the turn rides the writer's run.
    const chatCall = fetchCalls.find((c) => c.url.endsWith("/chat"))!;
    expect((chatCall.init!.headers as Record<string, string>)["x-run-id"]).toBe(RUN);
    // Hidden trigger, and the stored answer is the text they receive.
    expect(state.messageInserts.find((m) => m.role === "user")!.proactiveTrigger).toBe(true);
    expect(state.messageInserts.find((m) => m.role === "assistant")!.content).toBe(ANSWER.message);
    expect(state.leadTurns[0]).toMatchObject({ status: "answered", answer: ANSWER });

    const calls = gemini.bodies.length;
    const retry = await request(app).post("/internal/copilot/lead-turns").set(HEADERS).send(BODY);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ json: ANSWER, duplicate: true });
    expect(gemini.bodies.length).toBe(calls);
  }, 30_000);

  it("our brand, a person with an account: their tools (no UI tools) plus the answer, as them", async () => {
    process.env.COPILOT_FOLLOWUP_BRAND_ID = BRAND;
    const app = (await import("../../src/index.js")).default;
    const gemini = { bodies: [] as Array<Record<string, unknown>>, replies: [{ call: { name: "answer_person", args: ANSWER } }] as GeminiReply[] };
    routes.push(...baseRoutes(gemini, app, { orgId: ORG, userId: USER }));

    const res = await request(app).post("/internal/copilot/lead-turns").set(HEADERS).send(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ json: ANSWER, account: { orgId: ORG, userId: USER } });
    expect(declaredNames(gemini.bodies[0])).toEqual(["list_workflows", "launch_campaign", "propose_switch_on", "confirm_switch_on", "create_followup", "answer_person"]);
  }, 30_000);

  it("a turn that never answers fails loud (502), the key can run again", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = { bodies: [] as Array<Record<string, unknown>>, replies: [{ text: "a" }, { text: "b" }] as GeminiReply[] };
    routes.push(...baseRoutes(gemini, app, null));
    const res = await request(app).post("/internal/copilot/lead-turns").set(HEADERS).send(BODY);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("answer_person");
    expect(state.leadTurns[0].status).toBe("failed");
  }, 30_000);

  it("refuses a body whose messageField is not a string property, and a /chat leadTurnId with no turn in progress", async () => {
    const app = (await import("../../src/index.js")).default;
    const bad = await request(app).post("/internal/copilot/lead-turns").set(HEADERS).send({ ...BODY, messageField: "decisionx" });
    expect(bad.status).toBe(400);
    const noHeaders = await request(app).post("/internal/copilot/lead-turns").set({ "x-api-key": "svc" }).send(BODY);
    expect(noHeaders.status).toBe(400);
    const chat = await request(app)
      .post("/chat")
      .set({ "x-api-key": "k", "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN })
      .send({ configKey: "copilot", message: "hi", sessionId: SESSION, leadTurnId: TURN_ID });
    expect(chat.status).toBe(400);
    expect(state.leadTurns).toEqual([]);
  });
});
