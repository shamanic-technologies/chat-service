// SCRIPT-VALUE-RATING-1113-SOPHIE (owner 2026-11-13): a client telling Sophie that a message we
// wrote is not good becomes ONE report of that Unit, stored through the public gateway route as
// the person, with no yes asked; the model reads back that nothing was sent or changed.
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
    key: "test-report-chat",
    systemPrompt: "Be useful.",
    allowedTools: ["report_not_good", "list_brands"],
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


// Staff test org shape only: a lead of brand Reed, a follow-up we wrote.
const LEAD = "00000000-0000-4000-8000-0000000000b1";
const REPORT = { outcomeKey: "message_written", subjectService: "lead-service", subjectId: LEAD, kind: "reported", note: "way too pushy", unitAt: "2026-11-10T14:05:00Z" };

function mockUnitReports(capture: { calls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> }, status = 201) {
  return {
    match: (url: string, init?: RequestInit) => url === "https://api.test.local/v1/features/unit-reports" && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      capture.calls.push({ body, headers: init?.headers as Record<string, string> });
      if (status >= 400) return { ok: false, status, body: { error: "The report could not be stored", code: "unit_report_unwritable" } };
      return { ok: true, status, body: { id: "rep-1", ...body, orgId: "org-1", userId: "user-1", reportedAt: "2026-11-13T10:00:00.000Z" } };
    },
  } satisfies MockRoute;
}

describe("POST /chat: report_not_good (SCRIPT-VALUE-RATING-1113-SOPHIE)", () => {
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

  async function chat() {
    const app = (await import("../../src/index.js")).default;
    return request(app).post("/chat").set(AUTH).send({ configKey: "test-report-chat", message: "that follow-up to Dana was way too pushy", context: {} });
  }

  it("stores ONE report of the Unit through the gateway, as the person, in the same turn", async () => {
    const gemini = { calls: 0, bodies: [] as string[] };
    const reports = { calls: [] as Array<{ body: Record<string, unknown>; headers: Record<string, string> }> };
    routes.push(...baseRoutes(), mockUnitReports(reports), mockGeminiCall("report_not_good", REPORT, gemini));
    const res = await chat();
    expect(res.status).toBe(200);
    expect(reports.calls).toHaveLength(1);
    expect(reports.calls[0].body).toEqual({
      outcomeKey: "message_written",
      subjectService: "lead-service",
      subjectId: LEAD,
      kind: "reported",
      source: "Sophie (web chat)",
      note: "way too pushy",
      unitAt: "2026-11-10T14:05:00.000Z",
    });
    expect(reports.calls[0].headers["x-org-id"]).toBe("org-1");
    expect(reports.calls[0].headers["x-user-id"]).toBe("user-1");
    // No yes was asked: the report ran in this turn, and the model read back what it did and did not do.
    expect(gemini.calls).toBe(2);
    const fedBack = gemini.bodies[1];
    expect(fedBack).toContain("reported");
    expect(fedBack).toContain("Nothing was sent to anyone");
    expect(fedBack).not.toContain("confirmationToken");
  });

  it("a report the store refused reads as a failure of ours, never as reported", async () => {
    const gemini = { calls: 0, bodies: [] as string[] };
    const reports = { calls: [] as Array<{ body: Record<string, unknown>; headers: Record<string, string> }> };
    routes.push(...baseRoutes(), mockUnitReports(reports, 502), mockGeminiCall("report_not_good", REPORT, gemini));
    const res = await chat();
    expect(res.status).toBe(200);
    expect(reports.calls).toHaveLength(1);
    const fedBack = gemini.bodies[1];
    expect(fedBack).toContain("Failed on our side");
    expect(fedBack).not.toContain("Nothing was sent to anyone");
  });

  it("a kind that is no report never reaches the gateway", async () => {
    const gemini = { calls: 0, bodies: [] as string[] };
    const reports = { calls: [] as Array<{ body: Record<string, unknown>; headers: Record<string, string> }> };
    routes.push(...baseRoutes(), mockUnitReports(reports), mockGeminiCall("report_not_good", { ...REPORT, kind: "liked" }, gemini));
    const res = await chat();
    expect(res.status).toBe(200);
    expect(reports.calls).toEqual([]);
    expect(gemini.bodies[1]).toContain("no positive vote");
  });
});
