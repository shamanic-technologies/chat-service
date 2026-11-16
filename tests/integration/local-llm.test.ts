import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// LOCAL-CLAUDE-1116: an org that declared its LLM local gets every completion,
// judgment and chat round answered by a runner on the user's machine, through
// the runner routes only (claim → `claude -p` → result). The fake runner below
// uses nothing but those routes; any vendor, key-service or billing call fails
// the test (unmocked fetch), and runs-service receives no cost line ($0).

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";
process.env.BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY || "test-billing-key";
process.env.BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "https://billing.test.local";

const sessionId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";

vi.mock("../../src/db/index.js", () => {
  const appConfig = {
    id: "cfg-1",
    orgId: "org-local",
    key: "test-chat",
    systemPrompt: "Be useful.",
    allowedTools: ["list_workflows"],
    provider: "anthropic",
    model: "claude-haiku",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const insertResult = () => {
    const p = Promise.resolve() as Promise<void> & { returning: () => Promise<Array<{ id: string }>>; onConflictDoUpdate: () => Promise<void> };
    p.returning = () => Promise.resolve([{ id: sessionId }]);
    p.onConflictDoUpdate = () => Promise.resolve();
    return p;
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([appConfig])),
          limit: vi.fn(() => Promise.resolve([appConfig])),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(() => insertResult()) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      query: { messages: { findMany: vi.fn(() => Promise.resolve([])) } },
    },
  };
});

interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown };
}
let routes: MockRoute[] = [];
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      for (const route of routes) {
        if (route.match(url, init)) {
          const out = route.respond(url, init);
          return {
            ok: out.ok,
            status: out.status ?? (out.ok ? 200 : 500),
            json: () => Promise.resolve(out.body),
            text: () => Promise.resolve(JSON.stringify(out.body)),
            headers: new Headers(),
          } as unknown as Response;
        }
      }
      throw new Error(`[test] Unmocked fetch: ${url}`);
    }),
  );
}

const runsRoutes: MockRoute[] = [
  {
    match: (url, init) => url.endsWith("/v1/runs") && init?.method === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: runId, status: "running" } }),
  },
  {
    match: (url, init) => /\/v1\/runs\/[^/]+$/.test(url) && init?.method === "PATCH",
    respond: () => ({ ok: true, body: { id: runId, status: "completed" } }),
  },
  {
    match: (url, init) => /\/v1\/runs\/[^/]+\/events$/.test(url) && init?.method === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: "evt-1" } }),
  },
  {
    match: (url) => url.includes("/v1/workflows"),
    respond: () => ({ ok: true, body: { workflows: [{ id: "wf-1", name: "Workflow" }] } }),
  },
];

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-local", "x-user-id": "user-1", "x-run-id": "parent-run-1" };
const OTHER = { ...AUTH, "x-org-id": "org-platform" };

type App = Parameters<typeof request>[0];
interface WorkItem {
  id: string;
  leaseId: string;
  kind: string;
  claude: { systemPrompt: string; prompt: string; jsonSchema: Record<string, unknown> | null; model: string; tools: string[] };
}

/** A throwaway runner: only the public runner routes, answering like `claude -p` would. */
function startRunner(app: App, answer: (item: WorkItem) => Record<string, unknown>) {
  const executed = new Map<string, number>();
  const seen: WorkItem[] = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const res = await request(app).post("/orgs/local-llm/work/claim").set(AUTH).send({ waitMs: 200, max: 5, runner: { name: "test-runner", version: "0.0.1" } });
      expect(res.status).toBe(200);
      await Promise.all(
        (res.body.items as WorkItem[]).map(async (item) => {
          seen.push(item);
          executed.set(item.id, (executed.get(item.id) ?? 0) + 1);
          const r = await request(app)
            .post(`/orgs/local-llm/work/${item.id}/result`)
            .set(AUTH)
            .send({ leaseId: item.leaseId, ok: true, model: item.claude.model, usage: { inputTokens: 120, outputTokens: 30 }, notionalCostUsd: 0.002, durationMs: 900, ...answer(item) });
          expect(r.status).toBe(200);
        }),
      );
    }
  })();
  return { executed, seen, stop: async () => { stop = true; await loop; } };
}

async function boot() {
  vi.resetModules();
  const app = (await import("../../src/index.js")).default;
  const local = await import("../../src/lib/local-llm.js");
  const { createMemoryLocalLlmStore } = await import("../../src/lib/local-llm-store.js");
  const store = createMemoryLocalLlmStore();
  await local.startLocalLlm(store, { refresh: false });
  return { app, store };
}

describe("LOCAL-CLAUDE-1116 — an org's LLM on its own Claude Code", { timeout: 30_000 }, () => {
  beforeEach(() => {
    routes = [...runsRoutes];
    fetchCalls = [];
    installFetchMock();
    delete process.env.LOCAL_LLM_PICKUP_WAIT_MS;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOCAL_LLM_PICKUP_WAIT_MS;
  });

  it("declares, shows the state, and refuses a runner for an org that did not declare", async () => {
    const { app } = await boot();
    const before = await request(app).get("/orgs/local-llm").set(AUTH);
    expect(before.status).toBe(200);
    expect(before.body.declared).toBe(false);
    expect((await request(app).post("/orgs/local-llm/work/claim").set(AUTH).send({ waitMs: 0 })).status).toBe(409);

    const put = await request(app).put("/orgs/local-llm").set(AUTH).send({ enabled: true });
    expect(put.status).toBe(200);
    expect(put.body.declared).toBe(true);
    expect(put.body.runner.connected).toBe(false);
    expect(put.body.stillOnPlatform.map((f: { family: string }) => f.family)).toContain("image generation");

    await request(app).post("/orgs/local-llm/work/claim").set(AUTH).send({ waitMs: 0, runner: { name: "mac-app" } });
    const after = await request(app).get("/orgs/local-llm").set(AUTH);
    expect(after.body.runner).toMatchObject({ connected: true, name: "mac-app" });
    expect(after.body.usageLast30Days.chargedUsd).toBe(0);
  });

  it("a structured completion and a judgment are answered by the runner, at $0, naming the model that ran", async () => {
    const { app, store } = await boot();
    await request(app).put("/orgs/local-llm").set(AUTH).send({ enabled: true });
    const runner = startRunner(app, (item) =>
      item.kind === "judgment"
        ? { structured: { urgent: { yes: 0.9, no: 0.1 }, team: { billing: 3, support: 1 }, severity: { "1": 0.2, "2": 0.8 } } }
        : { structured: { subject: "Hello", body: "Hi there" } },
    );

    const schema = { type: "object", properties: { subject: { type: "string" }, body: { type: "string" } }, required: ["subject", "body"] };
    const complete = await request(app).post("/complete").set(AUTH).send({
      message: "Write the email.",
      systemPrompt: "You write emails.",
      provider: "google",
      model: "flash-pro",
      responseSchema: schema,
    });
    expect(complete.status).toBe(200);
    expect(complete.body.json).toEqual({ subject: "Hello", body: "Hi there" });
    expect(complete.body.servedBy).toBe("local-claude-code");
    // flash-pro is recorded `cheap` → Haiku 5.5; the answer names the model the runner reported.
    expect(complete.body.model).toBe("claude-haiku-5-5");
    // The caller's prompt reached the runner byte-equal, with its schema.
    const completeItem = runner.seen.find((i) => i.kind === "complete")!;
    expect(completeItem.claude).toMatchObject({ systemPrompt: "You write emails.", prompt: "Write the email.", jsonSchema: schema, tools: [] });

    const judged = await request(app).post("/orgs/judgments").set(AUTH).send({
      state: "Help! My payouts have been failing for 3 days.",
      questions: {
        urgent: { type: "noul", instructions: "Does this convey urgency?" },
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "money", support: "else" } },
        severity: { type: "score", instructions: "How severe?", criteria: ["minor", "major"] },
      },
    });
    expect(judged.status).toBe(200);
    expect(judged.body.servedBy).toBe("local-claude-code");
    expect(judged.body.model).toBe("claude-haiku-5-5");
    expect(judged.body.answers.urgent).toEqual({ type: "noul", noul: 0.9 });
    expect(judged.body.answers.team).toMatchObject({ type: "choice", choice: "billing", confidence: 0.75 });
    expect(judged.body.answers.severity.score).toBeCloseTo(1.8);

    await runner.stop();
    // $0: no key resolved, no hold, no affordability check, no cost line.
    expect(fetchCalls.some((c) => c.url.includes("/costs"))).toBe(false);
    expect(fetchCalls.some((c) => c.url.includes("key.test.local") || c.url.includes("billing.test.local"))).toBe(false);
    expect(fetchCalls.some((c) => /googleapis|anthropic\.com|deepseek|typesafe/.test(c.url))).toBe(false);
    // Usage is still measured per call.
    const done = [...store.jobs.values()].filter((j) => j.status === "done");
    expect(done).toHaveLength(2);
    expect(done.every((j) => j.usage.inputTokens === 120 && j.usage.notionalCostUsd === 0.002)).toBe(true);
  });

  it("a Copilot turn that needs one tool completes through the runner", async () => {
    const { app } = await boot();
    await request(app).put("/orgs/local-llm").set(AUTH).send({ enabled: true });
    const runner = startRunner(app, (item) =>
      item.claude.prompt.includes("[result of list_workflows]")
        ? { structured: { text: "You have one workflow: Workflow.", toolCalls: [] } }
        : { structured: { text: "", toolCalls: [{ name: "list_workflows", input: {} }] } },
    );
    const res = await request(app).post("/chat").set(AUTH).send({ configKey: "test-chat", message: "Which workflows do I have?" });
    await runner.stop();
    expect(res.status).toBe(200);
    const events = res.text.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.find((e) => e.type === "tool_result")?.result).toEqual({ workflows: [{ id: "wf-1", name: "Workflow" }] });
    expect(events.filter((e) => e.type === "token").map((e) => e.content).join("")).toBe("You have one workflow: Workflow.");
    // Two rounds, both on the runner, the tool's schema in the round's system prompt.
    expect(runner.seen).toHaveLength(2);
    expect(runner.seen[0].claude.model).toBe("claude-haiku-5-5");
    expect(runner.seen[0].claude.systemPrompt).toContain("### list_workflows");
    expect(fetchCalls.some((c) => c.url.includes("/costs") || c.url.includes("anthropic.com") || c.url.includes("key.test.local"))).toBe(false);
  });

  it("with no runner, the call ends in the named waiting state and no provider is called", async () => {
    process.env.LOCAL_LLM_PICKUP_WAIT_MS = "300";
    const { app, store } = await boot();
    await request(app).put("/orgs/local-llm").set(AUTH).send({ enabled: true });
    const res = await request(app).post("/complete").set(AUTH).send({ message: "Hi", systemPrompt: "S.", provider: "google", model: "flash-pro" });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "local_runner_waiting", retryable: true, servedBy: "local-claude-code" });
    // Provider call count: zero (no vendor, no key, no billing).
    expect(fetchCalls.filter((c) => !c.url.includes("runs.test.local"))).toEqual([]);
    const [job] = [...store.jobs.values()];
    expect(job.status).toBe("expired");
    // A runner arriving late cannot run it.
    const claim = await request(app).post("/orgs/local-llm/work/claim").set(AUTH).send({ waitMs: 0 });
    expect(claim.body.items).toEqual([]);
  });

  it("10 calls at once: none deadlocks, each runs exactly once", async () => {
    const { app } = await boot();
    await request(app).put("/orgs/local-llm").set(AUTH).send({ enabled: true });
    const runnerA = startRunner(app, (item) => ({ text: `answer to ${item.claude.prompt}` }));
    const runnerB = startRunner(app, (item) => ({ text: `answer to ${item.claude.prompt}` }));
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => request(app).post("/complete").set(AUTH).send({ message: `q${i}`, systemPrompt: "S.", provider: "google", model: "flash-pro" })),
    );
    await Promise.all([runnerA.stop(), runnerB.stop()]);
    results.forEach((r, i) => {
      expect(r.status).toBe(200);
      expect(r.body.content).toBe(`answer to q${i}`);
    });
    const counts = new Map<string, number>();
    for (const m of [runnerA.executed, runnerB.executed]) for (const [id, n] of m) counts.set(id, (counts.get(id) ?? 0) + n);
    expect(counts.size).toBe(10);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it("a second answer to the same call is refused; a wrong lease too", async () => {
    const { app } = await boot();
    await request(app).put("/orgs/local-llm").set(AUTH).send({ enabled: true });
    const pending = request(app).post("/complete").set(AUTH).send({ message: "Hi", systemPrompt: "S.", provider: "google", model: "flash-pro" }).then((r) => r);
    let item: WorkItem | undefined;
    for (let i = 0; i < 20 && !item; i++) {
      const c = await request(app).post("/orgs/local-llm/work/claim").set(AUTH).send({ waitMs: 200 });
      item = c.body.items[0];
    }
    const wrong = await request(app).post(`/orgs/local-llm/work/${item!.id}/result`).set(AUTH).send({ leaseId: crypto.randomUUID(), ok: true, model: "claude-sonnet-5-5", text: "x" });
    expect(wrong.status).toBe(409);
    const ok = await request(app).post(`/orgs/local-llm/work/${item!.id}/result`).set(AUTH).send({ leaseId: item!.leaseId, ok: true, model: "claude-sonnet-5-5", text: "hello" });
    expect(ok.status).toBe(200);
    const again = await request(app).post(`/orgs/local-llm/work/${item!.id}/result`).set(AUTH).send({ leaseId: item!.leaseId, ok: true, model: "claude-sonnet-5-5", text: "again" });
    expect(again.status).toBe(409);
    expect((await pending).body.content).toBe("hello");
    // Another org never sees this org's items.
    const other = await request(app).get("/orgs/local-llm").set(OTHER);
    expect(other.body.declared).toBe(false);
  });

  it("an org that did not declare is untouched: its call goes to the vendor as before", async () => {
    const { app } = await boot();
    await request(app).put("/orgs/local-llm").set(AUTH).send({ enabled: true });
    // org-platform did not declare: it resolves a key (the first thing a vendor call does).
    routes.push({
      match: (url) => url.includes("key.test.local"),
      respond: () => ({ ok: false, status: 503, body: { error: "down" } }),
    });
    const res = await request(app).post("/complete").set(OTHER).send({ message: "Hi", systemPrompt: "S.", provider: "google", model: "flash-pro" });
    expect(res.status).toBe(502);
    expect(fetchCalls.some((c) => c.url.includes("key.test.local"))).toBe(true);
  });
});
