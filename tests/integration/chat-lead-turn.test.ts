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
    executes: [] as unknown[],
    tables: {} as Record<string, unknown>,
    /** The session row's owner (default: the caller's org and user). */
    sessionOwner: null as { orgId: string; userId: string } | null,
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
    if (is(table, "sessions") && state.sessionOwner) return [{ ...session, ...state.sessionOwner }];
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
      execute: vi.fn((q: unknown) => {
        state.executes.push(q);
        return Promise.resolve([]);
      }),
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
    // DISTRY-GUEST-CAPS-1119: an account's turn asks billing whether the org pays (a paying client is never capped).
    { match: (url) => url.includes("/internal/accounts/by-org/") && url.endsWith("/cash"), respond: () => ({ ok: true, body: { cash_paid_cents: 5000, credited_cents: 5000, non_cash_credit_cents: 0 } }) },
    // SOLO-PLAN-1125: billing's solo-plan verdict, read on every Distry turn of an account (this one is not on the plan).
    { match: (url) => url.includes("/internal/accounts/by-org/") && url.endsWith("/solo-plan/ai-gate"), respond: () => ({ ok: true, body: { on_solo_plan: false, plan: null, may_use_our_keys: true, refused_reason: null, debt_cents: null, debt_limit_cents: null, upgrade_url: null, next_step: null } }) },
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

const HEADERS = { "x-api-key": "test-key", "x-run-id": RUN, "x-org-id": ORG, "x-user-id": USER, "x-campaign-id": "camp-1", "x-workflow-slug": "lead-follow-up-v3" };
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
    state.executes.length = 0;
    state.sessionOwner = null;
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
    expect(declaredNames(gemini.bodies[0])).toEqual(["reach_person_elsewhere", "answer_person"]);
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
    expect(declaredNames(gemini.bodies[0])).toEqual(["list_workflows", "launch_campaign", "propose_switch_on", "confirm_switch_on", "create_followup", "reach_person_elsewhere", "answer_person"]);
    // SOPHIE-JCURVE-1102: the answer is the campaign's, stored hidden, never a line of their chat.
    expect(state.messageInserts.filter((m) => m.role === "assistant")).toEqual([expect.objectContaining({ content: ANSWER.message, proactiveTrigger: true })]);
  }, 30_000);

  // MODEL-TAG-EVERY-AI-MESSAGE-1126 (prod 2026-11-25: two WhatsApp messages written for a writer in org
  // f0420eb5 by the account of org 17ee7081 carried no model on the Unibox): the turn reads and acts as the
  // person in their org, but its model spend sits in the CALLER's run tree, billed to the caller's org.
  it("an account in another org than the caller: the model's cost lines sit under the writer's run, in the caller's org", async () => {
    process.env.COPILOT_FOLLOWUP_BRAND_ID = BRAND;
    const PERSON_ORG = "88888888-8888-4888-8888-888888888888";
    const PERSON_USER = "99999999-9999-4999-8999-999999999999";
    state.sessionOwner = { orgId: PERSON_ORG, userId: PERSON_USER };
    const app = (await import("../../src/index.js")).default;
    const gemini = { bodies: [] as Array<Record<string, unknown>>, replies: [{ call: { name: "answer_person", args: ANSWER } }] as GeminiReply[] };
    // Every run gets its own id; its org, parent and task are recorded.
    const runs = new Map<string, { org: string; parent: string | null; task: string }>();
    routes.push({
      match: (url, init) => url.endsWith("/v1/runs") && init?.method === "POST",
      respond: (_url, init) => {
        const h = init!.headers as Record<string, string>;
        const id = `run-${runs.size + 1}`;
        runs.set(id, { org: h["x-org-id"], parent: h["x-run-id"] ?? null, task: (JSON.parse(init!.body as string) as { taskName: string }).taskName });
        return { ok: true, status: 201, body: { id, status: "running" } };
      },
    });
    routes.push(...baseRoutes(gemini, app, { orgId: PERSON_ORG, userId: PERSON_USER }));

    const res = await request(app).post("/internal/copilot/lead-turns").set(HEADERS).send(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ json: ANSWER, account: { orgId: PERSON_ORG, userId: PERSON_USER } });

    const costPosts = fetchCalls.filter((c) => /\/v1\/runs\/[^/]+\/costs$/.test(c.url) && c.init?.method === "POST");
    expect(costPosts.length).toBeGreaterThan(0);
    const rootOf = (id: string): string => {
      const r = runs.get(id);
      return r?.parent ? rootOf(r.parent) : id;
    };
    for (const post of costPosts) {
      const runId = post.url.match(/\/v1\/runs\/([^/]+)\/costs$/)![1];
      // Under the writer's run, in the caller's org, carrying the writer's campaign.
      expect(runs.get(runId)?.org).toBe(ORG);
      expect(rootOf(runId)).toBe(RUN);
      const h = post.init!.headers as Record<string, string>;
      expect(h["x-org-id"]).toBe(ORG);
      expect(h["x-campaign-id"]).toBe("camp-1");
    }
    // The turn itself still runs as the person, on a Copilot-support run of their own org.
    expect([...runs.values()]).toEqual(expect.arrayContaining([{ org: PERSON_ORG, parent: null, task: "copilot-lead-turn" }, expect.objectContaining({ org: PERSON_ORG, task: "chat" })]));
    // Nothing is billed on a run of the person's org.
    expect(costPosts.every((c) => (c.init!.headers as Record<string, string>)["x-org-id"] !== PERSON_ORG)).toBe(true);
  }, 30_000);

  // SCHEMA-HONOURED-1115: whether the answer follows the writer's schema is MEASURED (one counted row), never
  // refused yet: the answer is served as the model gave it.
  it("an answer_person call outside the writer's schema is counted, and served unchanged", async () => {
    const app = (await import("../../src/index.js")).default;
    const bad = { decision: "cold_email_followup", message: "M3" };
    const gemini = { bodies: [] as Array<Record<string, unknown>>, replies: [{ call: { name: "answer_person", args: bad } }] as GeminiReply[] };
    routes.push(...baseRoutes(gemini, app, null));
    const res = await request(app).post("/internal/copilot/lead-turns").set(HEADERS).send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.json).toMatchObject(bad);
    const recorded = JSON.stringify(state.executes);
    expect(recorded).toContain("schema_conformance_days");
    expect(recorded).toContain("lead-turn");
    expect(recorded).toContain("/decision must be one of");
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
    const noHeaders = await request(app).post("/internal/copilot/lead-turns").set({ "x-api-key": "test-key" }).send(BODY);
    expect(noHeaders.status).toBe(400);
    const chat = await request(app)
      .post("/chat")
      .set({ "x-api-key": "test-key", "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN })
      .send({ configKey: "copilot", message: "hi", sessionId: SESSION, leadTurnId: TURN_ID });
    expect(chat.status).toBe(400);
    expect(state.leadTurns).toEqual([]);
  });
});
