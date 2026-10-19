import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
process.env.CLOUDFLARE_SERVICE_API_KEY = process.env.CLOUDFLARE_SERVICE_API_KEY || "test-cloudflare-key";
process.env.CLOUDFLARE_SERVICE_URL = process.env.CLOUDFLARE_SERVICE_URL || "https://cloudflare.test.local";

interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown };
}

let routes: MockRoute[] = [];
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function buildResponse(out: { ok: boolean; status?: number; body: unknown }): Response {
  return {
    ok: out.ok,
    status: out.status ?? (out.ok ? 200 : 500),
    json: () => Promise.resolve(out.body),
    text: () => Promise.resolve(typeof out.body === "string" ? out.body : JSON.stringify(out.body)),
    headers: new Headers(),
  } as unknown as Response;
}

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      for (const route of routes) {
        if (route.match(url, init)) return buildResponse(route.respond(url, init));
      }
      throw new Error(`[test] Unmocked fetch: ${url}`);
    }),
  );
}

function mockRunsCreate() {
  return {
    match: (url: string, init?: RequestInit) => url.endsWith("/v1/runs") && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: "run-tx-1", status: "running" } }),
  } satisfies MockRoute;
}

function mockRunsStatusPatch() {
  return {
    match: (url: string, init?: RequestInit) => /\/v1\/runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: () => ({ ok: true, body: { id: "run-tx-1", status: "completed" } }),
  } satisfies MockRoute;
}

function mockRunsEvents() {
  return {
    match: (url: string, init?: RequestInit) =>
      /\/v1\/runs\/[^/]+\/events$/.test(url) && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: "event-1" } }),
  } satisfies MockRoute;
}

function mockRunsCostRoutes(cap: {
  postedItems: Array<Array<{ costName: string; quantity: number; status?: string }>>;
  patchedStatuses: string[];
  provisionStatus?: number;
}) {
  return [
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
      respond: (_url: string, init?: RequestInit) => {
        const items = init?.body
          ? (JSON.parse(init.body as string) as { items: Array<{ costName: string; quantity: number; status?: string }> }).items
          : [];
        cap.postedItems.push(items);
        const isProvision = items[0]?.status === "provisioned";
        if (isProvision && cap.provisionStatus && cap.provisionStatus >= 400) {
          return { ok: false, status: cap.provisionStatus, body: { error: "Unknown cost name" } };
        }
        return { ok: true, status: 201, body: { costs: items.map((it, i) => ({ id: `cost-${i}`, ...it })) } };
      },
    },
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
      respond: (_url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(init.body as string) as { status: string }) : { status: "?" };
        cap.patchedStatuses.push(body.status);
        return { ok: true, body: { id: "cost-0", status: body.status } };
      },
    },
  ] satisfies MockRoute[];
}

function mockKeyDecrypt() {
  return {
    match: (url: string) => url.includes("/keys/google/decrypt"),
    respond: () => ({ ok: true, body: { provider: "google", key: "fake-google-key", keySource: "platform" } }),
  } satisfies MockRoute;
}

function mockBilling(opts?: { sufficient?: boolean }) {
  return {
    match: (url: string, init?: RequestInit) =>
      url.includes("/v1/customer_balance/authorize") && (init?.method ?? "GET") === "POST",
    respond: () => ({
      ok: true,
      body: { sufficient: opts?.sufficient ?? true, balance_cents: "100000", required_cents: "1" },
    }),
  } satisfies MockRoute;
}

function mockGemini(cap: { calls: number; bodies: Record<string, unknown>[]; status?: number; text?: string; finishReason?: string }) {
  return {
    match: (url: string) => url.includes(":generateContent") && url.includes("generativelanguage.googleapis.com"),
    respond: (_url: string, init?: RequestInit) => {
      cap.calls += 1;
      if (init?.body) cap.bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      if (cap.status && cap.status >= 400) return { ok: false, status: cap.status, body: { error: { message: "bad audio" } } };
      return {
        ok: true,
        body: {
          candidates: [{ content: { parts: [{ text: cap.text ?? "LANGUAGES: en\n[00:00] How many campaigns run on Distribute.you?" }] }, finishReason: cap.finishReason ?? "STOP" }],
          usageMetadata: { promptTokenCount: 180, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 205 },
        },
      };
    },
  } satisfies MockRoute;
}

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "parent-run-1" };
const AUDIO = { base64: Buffer.from("OggS fake voice note").toString("base64"), mimeType: "audio/ogg; codecs=opus" };

describe("POST /orgs/transcriptions (SOPHIE-VOICE-1019)", () => {
  let app: Awaited<ReturnType<typeof loadApp>>;
  async function loadApp() {
    vi.resetModules();
    return (await import("../../src/index.js")).default;
  }
  beforeAll(async () => {
    app = await loadApp();
  });
  beforeEach(() => {
    routes = [];
    fetchCalls = [];
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  function costCap() {
    return { postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string; costSource?: string }>>, patchedStatuses: [] as string[] };
  }

  it("provisions + authorizes before Gemini, answers the transcript, posts the real lines actual and releases the hold", async () => {
    const cost = costCap();
    const gemini = { calls: 0, bodies: [] as Record<string, unknown>[] };
    routes.push(mockRunsCreate(), mockRunsEvents(), mockKeyDecrypt(), mockBilling(), mockGemini(gemini), ...mockRunsCostRoutes(cost), mockRunsStatusPatch());

    const res = await request(app).post("/orgs/transcriptions").set(AUTH).send({ audio: AUDIO, durationSeconds: 4 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      text: "How many campaigns run on Distribute.you?",
      languages: ["en"],
      model: "gemini-3.8-flash",
      tokensInput: 180,
      tokensOutput: 25,
      runId: "run-tx-1",
    });
    // The audio goes inline, its media type without parameters.
    const parts = (gemini.bodies[0].contents as Array<{ parts: Array<Record<string, unknown>> }>)[0].parts;
    expect(parts[0]).toEqual({ inlineData: { mimeType: "audio/ogg", data: AUDIO.base64 } });

    const [provision, actual] = cost.postedItems;
    expect(provision.every((i) => i.status === "provisioned")).toBe(true);
    expect(provision.map((i) => i.costName).sort()).toEqual(["google-flash-3.8-tokens-input", "google-flash-3.8-tokens-output"]);
    // 4 s × 32 tokens + 500 prompt; output 1000 + 4 × 10.
    expect(provision.find((i) => i.costName.endsWith("input"))!.quantity).toBe(628);
    expect(provision.find((i) => i.costName.endsWith("output"))!.quantity).toBe(1040);
    expect(actual).toEqual([
      { costName: "google-flash-3.8-tokens-input", quantity: 180, costSource: "platform" },
      { costName: "google-flash-3.8-tokens-output", quantity: 25, costSource: "platform" },
    ]);
    expect(cost.patchedStatuses).toEqual(["cancelled", "cancelled"]);

    const billingIdx = fetchCalls.findIndex((c) => c.url.includes("/customer_balance/authorize"));
    const geminiIdx = fetchCalls.findIndex((c) => c.url.includes(":generateContent"));
    expect(billingIdx).toBeGreaterThan(-1);
    expect(geminiIdx).toBeGreaterThan(billingIdx);
  });

  it("402 when billing refuses: Gemini is never called", async () => {
    const cost = costCap();
    const gemini = { calls: 0, bodies: [] as Record<string, unknown>[] };
    routes.push(mockRunsCreate(), mockRunsEvents(), mockKeyDecrypt(), mockBilling({ sufficient: false }), mockGemini(gemini), ...mockRunsCostRoutes(cost), mockRunsStatusPatch());
    const res = await request(app).post("/orgs/transcriptions").set(AUTH).send({ audio: AUDIO });
    expect(res.status).toBe(402);
    expect(gemini.calls).toBe(0);
  });

  it("no speech is a 200 with empty text, not an error", async () => {
    const cost = costCap();
    const gemini = { calls: 0, bodies: [] as Record<string, unknown>[], text: "LANGUAGES: none\nNO SPEECH" };
    routes.push(mockRunsCreate(), mockRunsEvents(), mockKeyDecrypt(), mockBilling(), mockGemini(gemini), ...mockRunsCostRoutes(cost), mockRunsStatusPatch());
    const res = await request(app).post("/orgs/transcriptions").set(AUTH).send({ audio: AUDIO });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("");
    expect(res.body.languages).toEqual([]);
  });

  it("a truncated answer is a 502 transcript_truncated, and its tokens are still declared", async () => {
    const cost = costCap();
    const gemini = { calls: 0, bodies: [] as Record<string, unknown>[], finishReason: "MAX_TOKENS" };
    routes.push(mockRunsCreate(), mockRunsEvents(), mockKeyDecrypt(), mockBilling(), mockGemini(gemini), ...mockRunsCostRoutes(cost), mockRunsStatusPatch());
    const res = await request(app).post("/orgs/transcriptions").set(AUTH).send({ audio: AUDIO });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("transcript_truncated");
    expect(cost.postedItems[1].map((i) => i.quantity)).toEqual([180, 25]);
  });

  it("refuses a non-audio type (422) and an empty file before any spend", async () => {
    routes.push(mockRunsCreate(), mockRunsEvents(), mockKeyDecrypt(), mockBilling(), mockRunsStatusPatch());
    const notAudio = await request(app).post("/orgs/transcriptions").set(AUTH).send({ audio: { base64: AUDIO.base64, mimeType: "image/png" } });
    expect(notAudio.status).toBe(422);
    expect(notAudio.body.code).toBe("not_media");
    const empty = await request(app).post("/orgs/transcriptions").set(AUTH).send({ audio: { base64: "====", mimeType: "audio/ogg" } });
    expect(empty.status).toBe(422);
    expect(fetchCalls.some((c) => c.url.includes("/costs"))).toBe(false);
  });
});
