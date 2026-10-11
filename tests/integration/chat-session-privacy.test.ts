import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";

// A chat session is private to the user who opened it (owner 2026-10-11):
// a teammate in the same org continuing it by id gets the SAME session_not_found
// as an unknown id, and nothing is written to the owner's session.

const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";

const { state } = vi.hoisted(() => ({
  state: {
    sessionRow: null as Record<string, unknown> | null,
    selectCalls: 0,
    inserts: 0,
    updates: 0,
  },
}));

vi.mock("../../src/db/index.js", () => {
  const appConfig = {
    id: "cfg-1",
    orgId: "org-1",
    key: "test-chat",
    systemPrompt: "Be useful.",
    allowedTools: [],
    provider: "google",
    model: "flash",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    db: {
      // 1st select = the org config lookup, 2nd = the session-ownership lookup.
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            state.selectCalls += 1;
            if (state.selectCalls === 1) return Promise.resolve([appConfig]);
            return Promise.resolve(state.sessionRow ? [state.sessionRow] : []);
          }),
        })),
      })),
      insert: vi.fn(() => {
        state.inserts += 1;
        return { values: vi.fn(() => ({ returning: () => Promise.resolve([{ id: "new" }]) })) };
      }),
      update: vi.fn(() => {
        state.updates += 1;
        return { set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) };
      }),
      query: { messages: { findMany: vi.fn(() => Promise.resolve([])) } },
    },
  };
});

const fetchCalls: string[] = [];

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/keys/google/decrypt")) {
        return new Response(JSON.stringify({ provider: "google", key: "k", keySource: "platform" }), { status: 200 });
      }
      // Run creation refused: proves the owner got PAST the ownership guard
      // without driving a whole model turn.
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "down" }), { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
}

function session(overrides: Record<string, unknown>) {
  return { id: SESSION_ID, orgId: "org-1", userId: "user-a", configKey: "test-chat", ...overrides };
}

function authFor(userId: string) {
  return { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": userId, "x-run-id": "parent-run-1" };
}

function events(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .map((d) => (d === "[DONE]" ? d : JSON.parse(d)));
}

async function chat(userId: string) {
  const app = (await import("../../src/index.js")).default;
  const res = await request(app)
    .post("/chat")
    .set(authFor(userId))
    .send({ configKey: "test-chat", message: "hi", sessionId: SESSION_ID });
  return events(res.text);
}

describe("POST /chat — continuing a session is private to its user", () => {
  beforeEach(() => {
    vi.resetModules();
    state.sessionRow = null;
    state.selectCalls = 0;
    state.inserts = 0;
    state.updates = 0;
    fetchCalls.length = 0;
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a teammate in the same org gets the same session_not_found as an unknown id, nothing written", async () => {
    state.sessionRow = null;
    const unknown = await chat("user-b");

    state.selectCalls = 0;
    state.sessionRow = session({ userId: "user-a" });
    const teammate = await chat("user-b");

    expect(teammate).toEqual(unknown);
    expect(teammate[0]).toMatchObject({ type: "error", code: "session_not_found" });
    expect(teammate.at(-1)).toBe("[DONE]");
    expect(state.inserts).toBe(0);
    expect(state.updates).toBe(0);
    expect(fetchCalls.some((c) => c.includes("/v1/runs"))).toBe(false);
  });

  it("a legacy session with no recorded user is nobody's", async () => {
    state.sessionRow = session({ userId: null });
    const out = await chat("user-a");
    expect(out[0]).toMatchObject({ type: "error", code: "session_not_found" });
    expect(state.inserts).toBe(0);
  });

  it("the owner continues their own session as before", async () => {
    state.sessionRow = session({ userId: "user-a" });
    const out = await chat("user-a");
    expect(out[0]).toEqual({ sessionId: SESSION_ID });
    expect(fetchCalls.some((c) => c.startsWith("POST") && c.endsWith("/v1/runs"))).toBe(true);
  });
});
