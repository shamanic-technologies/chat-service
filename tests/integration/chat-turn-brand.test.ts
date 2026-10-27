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

interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown; text?: string };
}

let routes: MockRoute[] = [];
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
const { insertedValues } = vi.hoisted(() => ({ insertedValues: [] as Array<Record<string, unknown>> }));

const sessionId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";

vi.mock("../../src/db/index.js", () => {
  const appConfig = {
    id: "cfg-1",
    orgId: "org-1",
    key: "test-brand-chat",
    systemPrompt: "Be useful.",
    allowedTools: ["list_audiences", "suggest_audiences", "list_brands", "request_user_input"],
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
        values: vi.fn((v: Record<string, unknown>) => {
          insertedValues.push(v);
          const p = Promise.resolve() as Promise<void> & { returning: () => Promise<Array<{ id: string }>> };
          p.returning = () => Promise.resolve([{ id: sessionId }]);
          return p;
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
      query: {
        messages: {
          findMany: vi.fn(() => Promise.resolve([])),
        },
      },
    },
  };
});

function buildResponse(out: { ok: boolean; status?: number; body: unknown; text?: string }): Response {
  const text = out.text ?? (typeof out.body === "string" ? out.body : JSON.stringify(out.body));
  return {
    ok: out.ok,
    status: out.status ?? (out.ok ? 200 : 500),
    json: () => Promise.resolve(out.body),
    text: () => Promise.resolve(text),
    headers: new Headers(),
    body: out.body instanceof ReadableStream ? out.body : undefined,
  } as unknown as Response;
}

function sseResponse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
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

function mockKeyDecrypt() {
  return {
    match: (url: string) => url.includes("/keys/google/decrypt"),
    respond: () => ({ ok: true, body: { provider: "google", key: "fake-google-key", keySource: "platform" } }),
  } satisfies MockRoute;
}

function mockRunCreate() {
  return {
    match: (url: string, init?: RequestInit) => url.endsWith("/v1/runs") && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: runId, status: "running" } }),
  } satisfies MockRoute;
}

function mockRunPatch() {
  return {
    match: (url: string, init?: RequestInit) => /\/v1\/runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: () => ({ ok: true, body: { id: runId, status: "completed" } }),
  } satisfies MockRoute;
}

function mockTraceEvents() {
  return {
    match: (url: string, init?: RequestInit) => /\/v1\/runs\/[^/]+\/events$/.test(url) && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: "evt-1" } }),
  } satisfies MockRoute;
}

function mockRunCosts(
  capture: {
    provisionCalls: number;
    actualCalls: number;
    actualItems?: Array<{ costName: string; quantity: number }>;
  },
  opts?: { provisionStatus?: number },
) {
  return {
    match: (url: string, init?: RequestInit) => /\/v1\/runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { items: Array<{ status?: string }> }) : { items: [] };
      const provisioned = body.items.some((item) => item.status === "provisioned");
      if (provisioned) {
        capture.provisionCalls += 1;
        if (opts?.provisionStatus && opts.provisionStatus >= 400) {
          return { ok: false, status: opts.provisionStatus, body: { error: "Unknown cost name" } };
        }
      } else {
        capture.actualCalls += 1;
        capture.actualItems = body.items as Array<{ costName: string; quantity: number }>;
      }
      return { ok: true, status: 201, body: { costs: body.items.map((item, i) => ({ id: `cost-${capture.provisionCalls}-${i}`, ...item })) } };
    },
  } satisfies MockRoute;
}

function mockCostPatch() {
  return {
    match: (url: string, init?: RequestInit) => /\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: () => ({ ok: true, body: { id: "cost-1", status: "cancelled" } }),
  } satisfies MockRoute;
}

function mockBilling(capture: { calls: number }, opts?: { sufficient?: boolean }) {
  return {
    match: (url: string, init?: RequestInit) => url.includes("/v1/customer_balance/authorize") && (init?.method ?? "GET") === "POST",
    respond: () => {
      capture.calls += 1;
      return {
        ok: true,
        body: { sufficient: opts?.sufficient ?? true, balance_cents: "100000", required_cents: "1" },
      };
    },
  } satisfies MockRoute;
}


// Staff test org fixtures only (STAFF TEST - Email Sending E2E, brand Reed).
const REED = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";

function mockBrands(brands: Array<{ id: string; name: string }>, capture: { calls: number }) {
  return {
    match: (url: string, init?: RequestInit) => url === "https://api.test.local/v1/brands" && (init?.method ?? "GET") === "GET",
    respond: () => {
      capture.calls += 1;
      return { ok: true, body: { brands } };
    },
  } satisfies MockRoute;
}

function mockAudiences(capture: { urls: string[]; suggestBodies: unknown[] }) {
  return {
    match: (url: string) => url.startsWith("https://api.test.local/v1/orgs/audiences"),
    respond: (url: string, init?: RequestInit) => {
      if (url.includes("/suggest")) {
        capture.suggestBodies.push(JSON.parse(init?.body as string));
        return { ok: true, body: { candidates: [] } };
      }
      capture.urls.push(url);
      return { ok: true, body: { audiences: [], total: 0 } };
    },
  } satisfies MockRoute;
}

/** First model call: one function call; second: text. Captures what the model was fed back. */
function mockGeminiCall(name: string, args: Record<string, unknown>, capture: { calls: number; bodies: string[] }) {
  return {
    match: (url: string, init?: RequestInit) => url.includes(":streamGenerateContent") && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      capture.calls += 1;
      capture.bodies.push(String(init?.body ?? ""));
      if (capture.calls === 1) {
        return {
          ok: true,
          body: sseResponse([
            {
              candidates: [{ content: { parts: [{ functionCall: { name, args }, thoughtSignature: "sig-1" }] } }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
            },
          ]),
        };
      }
      return {
        ok: true,
        body: sseResponse([
          {
            candidates: [{ content: { parts: [{ text: "Done." }] } }],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
          },
        ]),
      };
    },
  } satisfies MockRoute;
}

const AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "parent-run-1",
};

const WHATSAPP_CONTEXT = { channel: { kind: "whatsapp" } };

describe("POST /chat — brand-scoped tools with no brand in context (COPILOT-WA-BRAND-1027)", () => {
  beforeEach(() => {
    vi.resetModules();
    routes = [];
    fetchCalls = [];
    insertedValues.length = 0;
    installFetchMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function baseRoutes() {
    return [
      mockKeyDecrypt(), mockRunCreate(), mockRunCosts({ provisionCalls: 0, actualCalls: 0 }), mockCostPatch(),
      mockRunPatch(), mockTraceEvents(), mockBilling({ calls: 0 }),
    ];
  }

  async function chat(context: Record<string, unknown>) {
    const app = (await import("../../src/index.js")).default;
    return request(app).post("/chat").set(AUTH).send({ configKey: "test-brand-chat", message: "B2B ecommerce", context });
  }

  it("single-brand org: list_audiences acts on the org's only brand", async () => {
    const gemini = { calls: 0, bodies: [] as string[] };
    const audiences = { urls: [] as string[], suggestBodies: [] as unknown[] };
    const brands = { calls: 0 };
    routes.push(...baseRoutes(), mockBrands([{ id: REED, name: "Reed" }], brands), mockAudiences(audiences), mockGeminiCall("list_audiences", {}, gemini));
    const res = await chat(WHATSAPP_CONTEXT);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("requires a brand");
    expect(audiences.urls).toHaveLength(1);
    expect(new URL(audiences.urls[0]).searchParams.get("brandId")).toBe(REED);
    expect(gemini.calls).toBe(2);
  });

  it("single-brand org: suggest_audiences acts on the org's only brand", async () => {
    const gemini = { calls: 0, bodies: [] as string[] };
    const audiences = { urls: [] as string[], suggestBodies: [] as unknown[] };
    routes.push(...baseRoutes(), mockBrands([{ id: REED, name: "Reed" }], { calls: 0 }), mockAudiences(audiences),
      mockGeminiCall("suggest_audiences", { nlPrompt: "B2B ecommerce founders" }, gemini));
    const res = await chat(WHATSAPP_CONTEXT);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("requires a brand");
    expect(audiences.suggestBodies).toEqual([{ brandId: REED, nlPrompt: "B2B ecommerce founders" }]);
  });

  it("multi-brand org, no brandId: the model is told to ask which brand, no internal error, nothing fetched", async () => {
    const gemini = { calls: 0, bodies: [] as string[] };
    const audiences = { urls: [] as string[], suggestBodies: [] as unknown[] };
    routes.push(...baseRoutes(), mockBrands([{ id: REED, name: "Reed" }, { id: OTHER, name: "Other" }], { calls: 0 }),
      mockAudiences(audiences), mockGeminiCall("list_audiences", {}, gemini));
    const res = await chat(WHATSAPP_CONTEXT);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("requires a brand");
    expect(res.text).not.toContain("\"type\":\"error\"");
    expect(audiences.urls).toEqual([]);
    // The second model call carries the brand choice as the tool's answer.
    const fedBack = gemini.bodies[1];
    expect(fedBack).toContain("brandChoiceRequired");
    expect(fedBack).toContain("Ask the person which brand");
    expect(fedBack).toContain(REED);
    expect(fedBack).toContain(OTHER);
  });

  it("multi-brand org, brandId the person chose: acts on that brand", async () => {
    const gemini = { calls: 0, bodies: [] as string[] };
    const audiences = { urls: [] as string[], suggestBodies: [] as unknown[] };
    routes.push(...baseRoutes(), mockBrands([{ id: REED, name: "Reed" }, { id: OTHER, name: "Other" }], { calls: 0 }),
      mockAudiences(audiences), mockGeminiCall("list_audiences", { brandId: OTHER }, gemini));
    const res = await chat(WHATSAPP_CONTEXT);
    expect(res.status).toBe(200);
    expect(new URL(audiences.urls[0]).searchParams.get("brandId")).toBe(OTHER);
  });

  it("a brandId outside the org is refused, never acted on", async () => {
    const gemini = { calls: 0, bodies: [] as string[] };
    const audiences = { urls: [] as string[], suggestBodies: [] as unknown[] };
    routes.push(...baseRoutes(), mockBrands([{ id: REED, name: "Reed" }, { id: OTHER, name: "Other" }], { calls: 0 }),
      mockAudiences(audiences), mockGeminiCall("list_audiences", { brandId: "00000000-0000-4000-8000-0000000000ff" }, gemini));
    const res = await chat(WHATSAPP_CONTEXT);
    expect(res.status).toBe(200);
    expect(audiences.urls).toEqual([]);
    expect(gemini.bodies[1]).toContain("is not one of this account's brands");
  });

  it("web turn with context.brandId: unchanged, the org's brands are never read and a model brandId is ignored", async () => {
    const gemini = { calls: 0, bodies: [] as string[] };
    const audiences = { urls: [] as string[], suggestBodies: [] as unknown[] };
    const brands = { calls: 0 };
    routes.push(...baseRoutes(), mockBrands([{ id: REED, name: "Reed" }, { id: OTHER, name: "Other" }], brands),
      mockAudiences(audiences), mockGeminiCall("list_audiences", { brandId: OTHER }, gemini));
    const res = await chat({ brandId: REED });
    expect(res.status).toBe(200);
    expect(brands.calls).toBe(0);
    expect(new URL(audiences.urls[0]).searchParams.get("brandId")).toBe(REED);
  });
});
