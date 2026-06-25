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
    respond: () => ({ ok: true, status: 201, body: { id: "run-image-1", status: "running" } }),
  } satisfies MockRoute;
}

function mockRunsStatusPatch() {
  return {
    match: (url: string, init?: RequestInit) => /\/v1\/runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: () => ({ ok: true, body: { id: "run-image-1", status: "completed" } }),
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

function mockGeminiImage(cap: { calls: number; bodies: Record<string, unknown>[]; status?: number }) {
  return {
    match: (url: string) => url.includes(":generateContent") && url.includes("generativelanguage.googleapis.com"),
    respond: (_url: string, init?: RequestInit) => {
      cap.calls += 1;
      if (init?.body) cap.bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      if (cap.status && cap.status >= 400) {
        return {
          ok: false,
          status: cap.status,
          body: { error: { status: "INVALID_ARGUMENT", message: "Unsupported generation_config field" } },
        };
      }
      return {
        ok: true,
        body: {
          candidates: [
            {
              content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1290 },
        },
      };
    },
  } satisfies MockRoute;
}

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "parent-run-1" };

describe("POST /orgs/images/generate — cost gate and Gemini image request", () => {
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

  it("provisions image costs before Gemini and returns generated image bytes", async () => {
    const costCap = {
      postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string }>>,
      patchedStatuses: [] as string[],
    };
    const gemini = { calls: 0, bodies: [] as Record<string, unknown>[] };
    routes.push(mockRunsCreate(), mockRunsEvents(), mockKeyDecrypt(), mockBilling(), mockGeminiImage(gemini), ...mockRunsCostRoutes(costCap), mockRunsStatusPatch());

    const res = await request(app)
      .post("/orgs/images/generate")
      .set(AUTH)
      .send({ prompt: "Generate a square avatar, no text." });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      imageBase64: "iVBORw0KGgo=",
      mimeType: "image/png",
      model: "gemini-3.1-flash-image",
      tokensInput: 12,
      tokensOutput: 1290,
    });

    const provision = costCap.postedItems[0];
    expect(provision).toHaveLength(2);
    expect(provision.every((i) => i.status === "provisioned")).toBe(true);
    expect(provision.map((i) => i.costName).sort()).toEqual([
      "google-flash-image-3.1-tokens-input",
      "google-flash-image-3.1-tokens-output",
    ]);
    expect(provision.find((i) => i.costName.endsWith("output"))!.quantity).toBe(747);

    const provisionIdx = fetchCalls.findIndex(
      (c) => /\/v1\/runs\/[^/]+\/costs$/.test(c.url) && (c.init?.method ?? "GET") === "POST",
    );
    const geminiIdx = fetchCalls.findIndex((c) => c.url.includes(":generateContent"));
    expect(geminiIdx).toBeGreaterThan(provisionIdx);

    expect(gemini.bodies[0]).toEqual({
      contents: [{ parts: [{ text: "Generate a square avatar, no text." }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { imageSize: "512" },
      },
    });
    expect(JSON.stringify(gemini.bodies[0])).not.toContain("maxOutputTokens");

    const actual = costCap.postedItems.find((items) => items.some((i) => i.status === undefined));
    expect(actual).toBeDefined();
    expect(actual!.find((i) => i.costName.endsWith("input"))!.quantity).toBe(12);
    expect(actual!.find((i) => i.costName.endsWith("output"))!.quantity).toBe(1290);
    expect(costCap.patchedStatuses.filter((s) => s === "cancelled")).toHaveLength(2);
  });

  it("uses caller-selected xlarge size for Gemini and provisions documented 4K image tokens", async () => {
    const costCap = {
      postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string }>>,
      patchedStatuses: [] as string[],
    };
    const gemini = { calls: 0, bodies: [] as Record<string, unknown>[] };
    routes.push(mockRunsCreate(), mockRunsEvents(), mockKeyDecrypt(), mockBilling(), mockGeminiImage(gemini), ...mockRunsCostRoutes(costCap), mockRunsStatusPatch());

    const res = await request(app)
      .post("/orgs/images/generate")
      .set(AUTH)
      .send({ prompt: "Generate a detailed poster.", size: "xlarge" });

    expect(res.status).toBe(200);
    const provision = costCap.postedItems[0];
    expect(provision.find((i) => i.costName.endsWith("output"))!.quantity).toBe(2_000);
    expect(gemini.bodies[0]).toMatchObject({
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { imageSize: "4K" },
      },
    });
  });

  it("fails loud and does not call Gemini when cost provision is rejected", async () => {
    const costCap = {
      postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string }>>,
      patchedStatuses: [] as string[],
      provisionStatus: 422,
    };
    const gemini = { calls: 0, bodies: [] as Record<string, unknown>[] };
    routes.push(mockRunsCreate(), mockRunsEvents(), mockKeyDecrypt(), mockBilling(), mockGeminiImage(gemini), ...mockRunsCostRoutes(costCap), mockRunsStatusPatch());

    const res = await request(app)
      .post("/orgs/images/generate")
      .set(AUTH)
      .send({ prompt: "Generate a square avatar, no text." });

    expect(res.status).toBe(502);
    expect(gemini.calls).toBe(0);
  });

  it("surfaces Gemini 4xx provider details", async () => {
    const costCap = {
      postedItems: [] as Array<Array<{ costName: string; quantity: number; status?: string }>>,
      patchedStatuses: [] as string[],
    };
    const gemini = { calls: 0, bodies: [] as Record<string, unknown>[], status: 400 };
    routes.push(mockRunsCreate(), mockRunsEvents(), mockKeyDecrypt(), mockBilling(), mockGeminiImage(gemini), ...mockRunsCostRoutes(costCap), mockRunsStatusPatch());

    const res = await request(app)
      .post("/orgs/images/generate")
      .set(AUTH)
      .send({ prompt: "Generate a square avatar, no text." });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("provider status 400");
    expect(res.body.providerError).toContain("Unsupported generation_config field");
    expect(costCap.patchedStatuses.filter((s) => s === "cancelled")).toHaveLength(2);
  });
});
