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
    key: "test-chat",
    systemPrompt: "Be useful.",
    allowedTools: ["list_workflows", "open_page", "present_choices"],
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
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 40, totalTokenCount: 53 },
            },
          ]),
        };
      }
      return {
        ok: true,
        body: sseResponse([
          {
            candidates: [{ content: { parts: [{ text: "Done." }] } }],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 60, totalTokenCount: 85 },
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

function mockGeminiOpenPageThenChoices(capture: { calls: number }, opts: { leadText?: string | null; intro?: string | null } = {}) {
  const leadText = opts.leadText === undefined ? "Here is your week." : opts.leadText;
  const intro = opts.intro === undefined ? "You have 3 replies waiting." : opts.intro;
  return {
    match: (url: string, init?: RequestInit) => url.includes(":streamGenerateContent") && (init?.method ?? "GET") === "POST",
    respond: () => {
      capture.calls += 1;
      if (capture.calls === 1) {
        return {
          ok: true,
          body: sseResponse([
            {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: { name: "open_page", args: { page: "offer-today", brandId: "b-1", offerId: "o-1" } },
                        thoughtSignature: "sig-1",
                      },
                    ],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
            },
          ]),
        };
      }
      return {
        ok: true,
        body: sseResponse([
          {
            candidates: [
              {
                content: {
                  parts: [
                    ...(leadText ? [{ text: leadText }] : []),
                    {
                      functionCall: {
                        name: "present_choices",
                        args: {
                          ...(intro ? { text: intro } : {}),
                          question: "What next?",
                          choices: [
                            { label: "Answer replies", visual: { type: "number", value: "3", unit: "replies" } },
                            { label: "Raise budget", value: "Raise my daily budget", visual: { type: "icon", icon: "wallet" } },
                          ],
                        },
                      },
                      thoughtSignature: "sig-2",
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
          },
        ]),
      };
    },
  } satisfies MockRoute;
}

function sseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

describe("POST /chat — rich UI (open_page + present_choices)", () => {
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

  it("streams open_page and choices events, ends the turn on choices, and persists both", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = { calls: 0 };
    const costs = { provisionCalls: 0, actualCalls: 0 };
    routes.push(
      mockKeyDecrypt(),
      mockRunCreate(),
      mockRunCosts(costs),
      mockCostPatch(),
      mockRunPatch(),
      mockTraceEvents(),
      mockBilling({ calls: 0 }),
      mockGeminiOpenPageThenChoices(gemini),
    );

    const res = await request(app)
      .post("/chat")
      .set(AUTH)
      .send({ configKey: "test-chat", message: "Where do I stand?" });

    expect(res.status).toBe(200);
    // The turn ended on present_choices: no third provider call.
    expect(gemini.calls).toBe(2);

    const events = sseEvents(res.text);
    expect(events.find((e) => e.type === "open_page")).toEqual({
      type: "open_page",
      page: "offer-today",
      brandId: "b-1",
      offerId: "o-1",
    });
    expect(events.find((e) => e.type === "choices")).toEqual({
      type: "choices",
      question: "What next?",
      choices: [
        { label: "Answer replies", value: "Answer replies", visual: { type: "number", value: "3", unit: "replies" } },
        { label: "Raise budget", value: "Raise my daily budget", visual: { type: "icon", icon: "wallet" } },
      ],
      allowFreeText: true,
    });
    // No generic tool card for client-UI tools, and no empty-response error.
    expect(events.filter((e) => e.type === "tool_call" || e.type === "tool_result")).toEqual([]);
    expect(events.filter((e) => e.type === "error")).toEqual([]);

    // Session row records its config key (GET /sessions/latest reads it).
    expect(insertedValues[0]).toEqual(expect.objectContaining({ configKey: "test-chat" }));
    const assistant = insertedValues.find((v) => v.role === "assistant")!;
    // Text written BESIDE a tool call is the model's working note, never shown
    // (prod 2026-10-10: "Now find the step and funnel for..."): the answer is
    // present_choices' own text.
    expect(assistant.content).toBe("You have 3 replies waiting.");
    expect(events.filter((e) => e.type === "token").map((e) => e.content).join("")).toBe("You have 3 replies waiting.");
    expect(assistant.openPages).toEqual([{ page: "offer-today", brandId: "b-1", offerId: "o-1" }]);
    expect((assistant.choices as { choices: unknown[] }).choices).toHaveLength(2);
    // Each tool call stored ONCE: open_page with its thought signature, then
    // the turn-ending present_choices (regression: Gemini stored every call twice).
    const stored = assistant.toolCalls as Array<{ name: string; thoughtSignature?: string }>;
    expect(stored.map((t) => t.name)).toEqual(["open_page", "present_choices"]);
    expect(stored[0].thoughtSignature).toBe("sig-1");
  });

  it("a model that writes NO text gets its present_choices intro streamed before the cards and stored (Sonnet 5.5, prod 2026-10-10)", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = { calls: 0 };
    routes.push(
      mockKeyDecrypt(), mockRunCreate(), mockRunCosts({ provisionCalls: 0, actualCalls: 0 }), mockCostPatch(),
      mockRunPatch(), mockTraceEvents(), mockBilling({ calls: 0 }),
      mockGeminiOpenPageThenChoices(gemini, { leadText: null }),
    );
    const res = await request(app).post("/chat").set(AUTH).send({ configKey: "test-chat", message: "Where do I stand?" });
    expect(res.status).toBe(200);
    const events = sseEvents(res.text);
    const tokenAt = events.findIndex((e) => e.type === "token");
    const choicesAt = events.findIndex((e) => e.type === "choices");
    expect(events[tokenAt]).toEqual({ type: "token", content: "You have 3 replies waiting." });
    expect(tokenAt).toBeLessThan(choicesAt);
    const assistant = insertedValues.find((v) => v.role === "assistant")!;
    expect(assistant.content).toBe("You have 3 replies waiting.");
  });

  it("present_choices without text is a tool error the model retries, never bare cards", async () => {
    const app = (await import("../../src/index.js")).default;
    const gemini = { calls: 0 };
    routes.push(
      mockKeyDecrypt(), mockRunCreate(), mockRunCosts({ provisionCalls: 0, actualCalls: 0 }), mockCostPatch(),
      mockRunPatch(), mockTraceEvents(), mockBilling({ calls: 0 }),
      mockGeminiOpenPageThenChoices(gemini, { leadText: null, intro: null }),
    );
    const res = await request(app).post("/chat").set(AUTH).send({ configKey: "test-chat", message: "Where do I stand?" });
    expect(res.status).toBe(200);
    const events = sseEvents(res.text);
    expect(events.find((e) => e.type === "choices")).toBeUndefined();
    // The refusal went back to the model (a third provider call).
    expect(gemini.calls).toBeGreaterThanOrEqual(3);
  });
});
