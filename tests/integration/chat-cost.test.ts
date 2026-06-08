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

const sessionId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";

vi.mock("../../src/db/index.js", () => {
  const appConfig = {
    id: "cfg-1",
    orgId: "org-1",
    key: "test-chat",
    systemPrompt: "Be useful.",
    allowedTools: ["list_workflows"],
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
        values: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: sessionId }])),
        })),
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

function mockWorkflowList() {
  return {
    match: (url: string, init?: RequestInit) => url.includes("/v1/workflows") && (init?.method ?? "GET") === "GET",
    respond: () => ({ ok: true, body: { workflows: [{ id: "wf-1", name: "Workflow" }] } }),
  } satisfies MockRoute;
}

function mockGeminiToolThenText(capture: { calls: number }) {
  return {
    match: (url: string, init?: RequestInit) => url.includes(":streamGenerateContent") && (init?.method ?? "GET") === "POST",
    respond: () => {
      capture.calls += 1;
      if (capture.calls === 1) {
        return {
          ok: true,
          body: sseResponse([
            {
              candidates: [{ content: { parts: [{ functionCall: { name: "list_workflows", args: {} } }] } }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
            },
          ]),
        };
      }
      return {
        ok: true,
        body: sseResponse([
          {
            candidates: [{ content: { parts: [{ text: "Done." }] } }],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
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

describe("POST /chat — provider-call credit gates", () => {
  beforeEach(() => {
    vi.resetModules();
    routes = [];
    fetchCalls = [];
    installFetchMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadApp() {
    return (await import("../../src/index.js")).default;
  }

  it("provisions and authorizes before each Gemini provider call in the tool loop", async () => {
    const app = await loadApp();
    const gemini = { calls: 0 };
    const costs = { provisionCalls: 0, actualCalls: 0 };
    const billing = { calls: 0 };
    routes.push(
      mockKeyDecrypt(),
      mockRunCreate(),
      mockRunCosts(costs),
      mockCostPatch(),
      mockRunPatch(),
      mockTraceEvents(),
      mockBilling(billing),
      mockWorkflowList(),
      mockGeminiToolThenText(gemini),
    );

    const res = await request(app)
      .post("/chat")
      .set(AUTH)
      .send({ configKey: "test-chat", message: "Use a tool then answer." });

    expect(res.status).toBe(200);
    expect(gemini.calls).toBe(2);
    expect(costs.provisionCalls).toBe(2);
    expect(billing.calls).toBe(2);
    expect(costs.actualItems?.find((item) => item.costName.endsWith("-tokens-input"))?.quantity).toBe(30);

    const providerCallIndexes = fetchCalls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.url.includes(":streamGenerateContent"))
      .map(({ index }) => index);
    const provisionIndexes = fetchCalls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => /\/v1\/runs\/[^/]+\/costs$/.test(call.url) && (call.init?.method ?? "GET") === "POST")
      .map(({ index }) => index);
    const billingIndexes = fetchCalls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.url.includes("/v1/customer_balance/authorize"))
      .map(({ index }) => index);

    expect(provisionIndexes[0]).toBeLessThan(providerCallIndexes[0]);
    expect(billingIndexes[0]).toBeLessThan(providerCallIndexes[0]);
    expect(provisionIndexes[1]).toBeLessThan(providerCallIndexes[1]);
    expect(billingIndexes[1]).toBeLessThan(providerCallIndexes[1]);
  });

  it("does not call Gemini when provision is rejected", async () => {
    const app = await loadApp();
    const gemini = { calls: 0 };
    const costs = { provisionCalls: 0, actualCalls: 0 };
    const billing = { calls: 0 };
    routes.push(
      mockKeyDecrypt(),
      mockRunCreate(),
      mockRunCosts(costs, { provisionStatus: 422 }),
      mockCostPatch(),
      mockRunPatch(),
      mockTraceEvents(),
      mockBilling(billing),
      mockWorkflowList(),
      mockGeminiToolThenText(gemini),
    );

    const res = await request(app)
      .post("/chat")
      .set(AUTH)
      .send({ configKey: "test-chat", message: "hello" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("Cost authorization failed");
    expect(gemini.calls).toBe(0);
    expect(billing.calls).toBe(0);
  });

  it("does not call Gemini when billing reports insufficient credits", async () => {
    const app = await loadApp();
    const gemini = { calls: 0 };
    const costs = { provisionCalls: 0, actualCalls: 0 };
    const billing = { calls: 0 };
    routes.push(
      mockKeyDecrypt(),
      mockRunCreate(),
      mockRunCosts(costs),
      mockCostPatch(),
      mockRunPatch(),
      mockTraceEvents(),
      mockBilling(billing, { sufficient: false }),
      mockWorkflowList(),
      mockGeminiToolThenText(gemini),
    );

    const res = await request(app)
      .post("/chat")
      .set(AUTH)
      .send({ configKey: "test-chat", message: "hello" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("Insufficient credits");
    expect(gemini.calls).toBe(0);
    expect(billing.calls).toBe(1);
  });
});
