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

const { inserted } = vi.hoisted(() => ({ inserted: [] as Array<Record<string, unknown>> }));

vi.mock("../../src/db/index.js", () => {
  const appConfig = {
    id: "cfg-1",
    orgId: "org-1",
    key: "test-chat",
    systemPrompt: "Be useful.",
    allowedTools: ["list_workflows"],
    provider: "deepseek",
    model: "deepseek-flash",
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
          inserted.push(v);
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
    match: (url: string) => url.includes("/keys/deepseek/decrypt"),
    respond: () => ({ ok: true, body: { provider: "deepseek", key: "fake-deepseek-key", keySource: "platform" } }),
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

function mockBilling(capture: { calls: number }, opts?: { sufficient?: boolean; extra?: Record<string, unknown> }) {
  return {
    match: (url: string, init?: RequestInit) => url.includes("/v1/customer_balance/authorize") && (init?.method ?? "GET") === "POST",
    respond: () => {
      capture.calls += 1;
      return {
        ok: true,
        body: { sufficient: opts?.sufficient ?? true, balance_cents: "100000", required_cents: "1", ...opts?.extra },
      };
    },
  } satisfies MockRoute;
}

function mockBillingSequence(capture: { calls: number }, sufficient: boolean[]) {
  return {
    match: (url: string, init?: RequestInit) => url.includes("/v1/customer_balance/authorize") && (init?.method ?? "GET") === "POST",
    respond: () => {
      const ok = sufficient[Math.min(capture.calls, sufficient.length - 1)];
      capture.calls += 1;
      return { ok: true, body: { sufficient: ok, balance_cents: "0", required_cents: "3" } };
    },
  } satisfies MockRoute;
}

function mockPrepaidStatus(capture: { calls: number }, out: { status?: number; offer?: string | null }) {
  return {
    match: (url: string) => url.includes("/v1/accounts/prepaid_status"),
    respond: (_url: string, init?: RequestInit) => {
      capture.calls += 1;
      // billing 400s an identity read without x-run-id (prod 2026-10-12).
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (!h["x-org-id"] || !h["x-user-id"] || !h["x-run-id"]) {
        return { ok: false, status: 400, body: { error: "x-run-id header is required" } };
      }
      if (out.status && out.status !== 200) return { ok: false, status: out.status, body: { error: "Billing account not found" } };
      return { ok: true, body: { state: "none", free_credit_offer: out.offer ?? null, balance_cents: "0" } };
    },
  } satisfies MockRoute;
}

function sseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((l: string) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l: string) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

function mockWorkflowList() {
  return {
    match: (url: string, init?: RequestInit) => url.includes("/v1/workflows") && (init?.method ?? "GET") === "GET",
    respond: () => ({ ok: true, body: { workflows: [{ id: "wf-1", name: "Workflow" }] } }),
  } satisfies MockRoute;
}

// CHAT-DEEPSEEK-FLASH-1101: the chat (Copilot, WhatsApp, Lead event answers)
// runs on DeepSeek V4.1 Flash, tools included, its cost declared under the
// DeepSeek catalog names (provision then actualize, like every DeepSeek call).
function mockDeepSeekToolThenText(capture: { calls: number; bodies: Array<Record<string, unknown>> }) {
  return {
    match: (url: string, init?: RequestInit) => url === "https://api.deepseek.com/v1/chat/completions" && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      capture.calls += 1;
      capture.bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
      if (capture.calls === 1) {
        return {
          ok: true,
          body: {
            model: "deepseek-flash",
            choices: [{
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "Let me look.",
                reasoning_content: "The user wants workflows: call the tool.",
                tool_calls: [{ id: "call_00_a", type: "function", function: { name: "list_workflows", arguments: "{}" } }],
              },
            }],
            usage: { prompt_tokens: 1000, completion_tokens: 40, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 },
          },
        };
      }
      return {
        ok: true,
        body: {
          model: "deepseek-flash",
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "You have one workflow.", reasoning_content: "" } }],
          usage: { prompt_tokens: 1100, completion_tokens: 10, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 100 },
        },
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

const DS = /^deepseek-v4\.1-flash-(peak|off-peak)-tokens-(input|cached-input|output)$/;

describe("POST /chat on a DeepSeek config", () => {
  beforeEach(() => {
    vi.resetModules();
    routes = [];
    fetchCalls = [];
    inserted.length = 0;
    installFetchMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the tool loop on DeepSeek V4.1 Flash and declares DeepSeek costs", async () => {
    const app = (await import("../../src/index.js")).default;
    const ds = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    const costs = { provisionCalls: 0, actualCalls: 0 } as { provisionCalls: number; actualCalls: number; actualItems?: Array<{ costName: string; quantity: number }> };
    const billing = { calls: 0 };
    const provisioned: string[] = [];
    routes.push(
      mockKeyDecrypt(),
      mockRunCreate(),
      {
        match: (url: string, init?: RequestInit) => /\/v1\/runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
        respond: (url: string, init?: RequestInit) => {
          const body = JSON.parse(init!.body as string) as { items: Array<{ costName: string; status?: string }> };
          if (body.items.some((i) => i.status === "provisioned")) provisioned.push(...body.items.map((i) => i.costName));
          return mockRunCosts(costs).respond(url, init);
        },
      },
      mockCostPatch(),
      mockRunPatch(),
      mockTraceEvents(),
      mockBilling(billing),
      mockWorkflowList(),
      mockDeepSeekToolThenText(ds),
    );

    const res = await request(app).post("/chat").set(AUTH).send({ configKey: "test-chat", message: "Which workflows do I have?" });

    expect(res.status).toBe(200);
    // Never another model: no Anthropic, no Gemini call.
    expect(fetchCalls.some((c) => c.url.includes("anthropic.com") || c.url.includes("generativelanguage"))).toBe(false);
    expect(ds.calls).toBe(2);
    expect(ds.bodies[0].model).toBe("deepseek-flash");
    expect((ds.bodies[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(["list_workflows"]);
    // Round 2 carries the call (with its reasoning) and the tool result.
    const round2 = ds.bodies[1].messages as Array<Record<string, unknown>>;
    const call = round2.find((m) => m.role === "assistant" && m.tool_calls)!;
    expect(call.reasoning_content).toBe("The user wants workflows: call the tool.");
    const toolMsg = round2.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("call_00_a");
    expect(JSON.parse(toolMsg.content as string)).toEqual({ workflows: [{ id: "wf-1", name: "Workflow" }] });

    const events = sseEvents(res.text);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ name: "list_workflows" });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ name: "list_workflows" });
    expect(events.filter((e) => e.type === "token").map((e) => e.content).join("")).toContain("You have one workflow.");

    // PROVISION + AUTHORIZE before each of the two requests, under DeepSeek names.
    expect(costs.provisionCalls).toBe(2);
    expect(billing.calls).toBe(2);
    expect(provisioned.length).toBeGreaterThan(0);
    for (const name of provisioned) expect(name).toMatch(DS);
    // ACTUALIZE: fresh input, cache hits and output, summed over both requests.
    expect(costs.actualCalls).toBe(1);
    for (const item of costs.actualItems!) expect(item.costName).toMatch(DS);
    const sum = (suffix: string) => costs.actualItems!.filter((i) => i.costName.endsWith(suffix)).reduce((a, i) => a + i.quantity, 0);
    expect(sum("-tokens-input")).toBe(400 + 100);
    expect(sum("-tokens-cached-input")).toBe(600 + 1000);
    expect(sum("-tokens-output")).toBe(40 + 10);

    const assistant = [...inserted].reverse().find((v) => v.role === "assistant")!;
    expect(assistant.content).toContain("You have one workflow.");
    expect(assistant.toolCalls).toEqual([{ name: "list_workflows", args: {}, result: { workflows: [{ id: "wf-1", name: "Workflow" }] } }]);
  });

  it("fails the turn loud on a DeepSeek error: no other model is called", async () => {
    const app = (await import("../../src/index.js")).default;
    routes.push(
      mockKeyDecrypt(),
      mockRunCreate(),
      mockRunCosts({ provisionCalls: 0, actualCalls: 0 }),
      mockCostPatch(),
      mockRunPatch(),
      mockTraceEvents(),
      mockBilling({ calls: 0 }),
      mockWorkflowList(),
      {
        match: (url: string) => url.startsWith("https://api.deepseek.com/"),
        respond: () => ({ ok: false, status: 402, body: { error: { message: "Insufficient Balance" } } }),
      },
    );

    const res = await request(app).post("/chat").set(AUTH).send({ configKey: "test-chat", message: "hello" });

    expect(res.status).toBe(200);
    const events = sseEvents(res.text);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes("anthropic.com") || c.url.includes("generativelanguage") || c.url.includes("api.z.ai"))).toBe(false);
  });
});
