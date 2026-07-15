import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

// Configurable mock state — each test sets what the DB "contains".
let sessionRow: Record<string, unknown> | null = null;
let messageRows: Record<string, unknown>[] = [];

vi.mock("../../src/db/index.js", () => {
  return {
    db: {
      // db.select().from(sessions).where(...) → [sessionRow] (or [])
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(sessionRow ? [sessionRow] : [])),
        })),
      })),
      query: {
        messages: {
          findMany: vi.fn(() => Promise.resolve(messageRows)),
        },
      },
    },
  };
});

const AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "parent-run-1",
};

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    orgId: "org-1",
    userId: "user-1",
    runId: null,
    parentRunId: null,
    campaignId: null,
    brandIds: null,
    workflowSlug: null,
    featureSlug: null,
    audienceId: null,
    createdAt: new Date("2026-07-16T10:00:00.000Z"),
    updatedAt: new Date("2026-07-16T10:05:00.000Z"),
    ...overrides,
  };
}

describe("GET /sessions/:sessionId", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionRow = null;
    messageRows = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadApp() {
    return (await import("../../src/index.js")).default;
  }

  it("returns the ordered conversation for an owned session", async () => {
    sessionRow = makeSession();
    messageRows = [
      {
        id: "m1",
        role: "user",
        content: "hi",
        contentBlocks: null,
        toolCalls: null,
        buttons: null,
        tokenCount: null,
        createdAt: new Date("2026-07-16T10:00:01.000Z"),
      },
      {
        id: "m2",
        role: "assistant",
        content: "hello",
        contentBlocks: [{ type: "text", text: "hello" }],
        toolCalls: [{ name: "list_workflows", args: { limit: 5 }, result: { workflows: [] } }],
        buttons: [{ label: "More", value: "more" }],
        tokenCount: 12,
        createdAt: new Date("2026-07-16T10:00:02.000Z"),
      },
    ];
    const app = await loadApp();

    const res = await request(app).get(`/sessions/${SESSION_ID}`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(SESSION_ID);
    expect(res.body.orgId).toBe("org-1");
    expect(res.body.createdAt).toBe("2026-07-16T10:00:00.000Z");
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);
    expect(res.body.messages[1].toolCalls).toEqual([
      { name: "list_workflows", args: { limit: 5 }, result: { workflows: [] } },
    ]);
    expect(res.body.messages[1].contentBlocks).toEqual([{ type: "text", text: "hello" }]);
    expect(res.body.messages[1].buttons).toEqual([{ label: "More", value: "more" }]);
  });

  it("returns 404 for an unknown session", async () => {
    sessionRow = null;
    const app = await loadApp();

    const res = await request(app).get(`/sessions/${SESSION_ID}`).set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Session not found/);
  });

  it("returns 404 for a session owned by a different org (no cross-org leak)", async () => {
    sessionRow = makeSession({ orgId: "org-2" });
    const app = await loadApp();

    const res = await request(app).get(`/sessions/${SESSION_ID}`).set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Session not found/);
  });

  it("returns 400 when sessionId is not a UUID", async () => {
    const app = await loadApp();

    const res = await request(app).get("/sessions/not-a-uuid").set(AUTH);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 400 when x-org-id header is missing", async () => {
    const app = await loadApp();

    const res = await request(app)
      .get(`/sessions/${SESSION_ID}`)
      .set({ "x-api-key": "test-key", "x-user-id": "user-1", "x-run-id": "parent-run-1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-org-id/);
  });
});
