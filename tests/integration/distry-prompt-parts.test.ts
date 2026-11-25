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
const ROW_ID = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";

const { state } = vi.hoisted(() => ({
  state: {
    channelRows: [] as Array<Record<string, unknown>>,
    messageInserts: [] as Array<Record<string, unknown>>,
    samples: [] as Array<Record<string, unknown>>,
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
    systemPrompt: "You are Distry (test role).",
    allowedTools: ["list_workflows", "present_choices", "open_page"],
    provider: "google",
    model: "flash",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const session = { id: SESSION, orgId: ORG, userId: USER, channelPhone: null, guest: false, brandIds: [BRAND], updatedAt: new Date() };
  const rowsFor = (table: unknown): unknown[] => {
    if (is(table, "channel_inbound_messages")) return state.channelRows;
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
          if (is(table, "channel_inbound_messages")) {
            if (state.channelRows.some((r) => r.messageId === v.messageId)) {
              return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }) };
            }
            const row = { id: ROW_ID, sessionId: null, replyText: null, error: null, sentAt: null, createdAt: new Date(), updatedAt: new Date(), ...v };
            state.channelRows.push(row);
            return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: row.id }]) }) };
          }
          if (is(table, "messages")) state.messageInserts.push(v);
          const p = Promise.resolve() as Promise<void> & { returning: () => Promise<Array<{ id: string; createdAt: Date }>>; onConflictDoUpdate: () => Promise<void> };
          p.returning = () => Promise.resolve([{ id: `msg-${state.messageInserts.length}`, createdAt: new Date() }]);
          p.onConflictDoUpdate = () => {
            if (is(table, "distry_prompt_samples")) state.samples.push(v);
            return Promise.resolve();
          };
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


function routesFor(gemini: { bodies: Array<Record<string, unknown>> }): MockRoute[] {
  return [
    { match: (url) => url.includes("/internal/accounts/by-org/") && url.endsWith("/cash"), respond: () => ({ ok: true, body: { cash_paid_cents: 5000, credited_cents: 5000, non_cash_credit_cents: 0 } }) },
    // SOLO-PLAN-1125: billing's solo-plan verdict, read on every Distry turn of an account (this one is not on the plan).
    { match: (url) => url.includes("/internal/accounts/by-org/") && url.endsWith("/solo-plan/ai-gate"), respond: () => ({ ok: true, body: { on_solo_plan: false, plan: null, may_use_our_keys: true, refused_reason: null, debt_cents: null, debt_limit_cents: null, upgrade_url: null, next_step: null } }) },
    { match: (url) => url.includes("/internal/users/"), respond: () => ({ ok: true, body: { user: { email: "client@example.com" } } }) },
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
    // The situation brief reads the account through the gateway: one brand, nothing else set up.
    { match: (url) => url.startsWith(`${process.env.API_SERVICE_URL}/v1/brands`) && !url.includes("/v1/brands/"), respond: () => ({ ok: true, body: { brands: [] } }) },
    {
      match: (url) => url.includes(":streamGenerateContent"),
      respond: (_url, init) => {
        gemini.bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        return { ok: true, body: sseStream([{ candidates: [{ content: { parts: [{ text: "Hello." }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, totalTokenCount: 23 } }]) };
      },
    },
  ];
}

const HEADERS = { "x-api-key": "test-key", "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN };

function sentSystem(body: Record<string, unknown>): string {
  const si = body.systemInstruction as { parts: Array<{ text: string }> };
  return si.parts.map((p) => p.text).join("");
}

function sentTools(body: Record<string, unknown>): Array<{ name: string; description: string }> {
  const tools = (body.tools as Array<{ functionDeclarations?: Array<{ name: string; description: string }> }> | undefined) ?? [];
  return tools.flatMap((t) => t.functionDeclarations ?? []).map((f) => ({ name: f.name, description: f.description }));
}

describe("Distry's prompt parts reach the model as recorded (DISTRY-PROMPT-PARTS-1120)", () => {
  beforeEach(() => {
    vi.resetModules();
    routes = [];
    fetchCalls = [];
    state.messageInserts.length = 0;
    state.samples.length = 0;
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  it("a client turn: the recorded parts add up to exactly the system instruction and the tools the model received", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = { bodies: [] as Array<Record<string, unknown>> };
    routes.push(...routesFor(gemini));
    const res = await request(app).post("/chat").set(HEADERS).send({ configKey: "copilot", message: "How is it going?", sessionId: SESSION, context: { page: "today" } });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(state.samples).toHaveLength(1));
    const sample = state.samples[0] as { audience: string; systemPrompt: string; turnContext: string; parts: Array<{ id: string; sent: boolean; placedIn: string; text: string | null }>; tools: Array<{ name: string; description: string }>; userMessage: string };
    expect(sample.audience).toBe("client");
    expect(sample.userMessage).toBe("How is it going?");
    // Gemini reads the two halves joined: exactly the sent parts, nothing else.
    const system = sentSystem(gemini.bodies[0]!);
    expect(system).toBe(sample.systemPrompt + sample.turnContext);
    const sentParts = sample.parts.filter((p) => p.sent && p.text !== null);
    expect(sentParts.map((p) => p.text).join("")).toBe(system);
    expect(sentParts.map((p) => p.id)).toEqual(["role", "request-context", "dashboard-pages", "situation-brief"]);
    expect(system.startsWith("You are Distry (test role).")).toBe(true);
    expect(sentTools(gemini.bodies[0]!)).toEqual(sample.tools.map((t) => ({ name: t.name, description: t.description })));
  }, 30_000);

  it("an edited part, a reorder and a rewritten tool description change the very next turn", async () => {
    const app = (await import("../../src/index.js")).default;
    const prompt = await import("../../src/agent/distry-prompt.js");
    const code = prompt.codePromptOverrides();
    const order = code.order.filter((id) => id !== "dashboard-pages");
    order.splice(order.indexOf("request-context"), 0, "dashboard-pages");
    prompt.setCurrentDistryPrompt({
      order,
      texts: { "dashboard-pages": "\n\n## Pages (edited)" },
      toolDescriptions: { present_choices: "Cards, edited." },
    });
    const gemini = { bodies: [] as Array<Record<string, unknown>> };
    routes.push(...routesFor(gemini));
    const res = await request(app).post("/chat").set(HEADERS).send({ configKey: "copilot", message: "hi", sessionId: SESSION, context: { page: "today" } });
    expect(res.status).toBe(200);
    const system = sentSystem(gemini.bodies[0]!);
    expect(system).toContain("\n\n## Pages (edited)");
    expect(system.indexOf("## Pages (edited)")).toBeLessThan(system.indexOf("## Additional Context"));
    expect(sentTools(gemini.bodies[0]!).find((t) => t.name === "present_choices")?.description).toBe("Cards, edited.");
    // Back to the code's parts: the next turn sends the code's text again.
    prompt.setCurrentDistryPrompt(code);
    await request(app).post("/chat").set(HEADERS).send({ configKey: "copilot", message: "hi again", sessionId: SESSION, context: { page: "today" } });
    expect(sentSystem(gemini.bodies[1]!)).not.toContain("(edited)");
  }, 30_000);
});
