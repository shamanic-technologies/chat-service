import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

let sessionRows: Record<string, unknown>[] = [];
let messageRows: Record<string, unknown>[] = [];
const whereSpy = vi.fn();
const orderBySpy = vi.fn();
const limitSpy = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    // db.select().from(sessions).where(...).orderBy(...).limit(1)
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => {
          whereSpy(cond);
          return {
            orderBy: vi.fn((o: unknown) => {
              orderBySpy(o);
              return {
                limit: vi.fn((n: number) => {
                  limitSpy(n);
                  return Promise.resolve(sessionRows.slice(0, n));
                }),
              };
            }),
          };
        }),
      })),
    })),
    query: { messages: { findMany: vi.fn(() => Promise.resolve(messageRows)) } },
  },
}));

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "parent-run-1" };

describe("GET /sessions/latest", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionRows = [];
    messageRows = [];
    whereSpy.mockClear();
    orderBySpy.mockClear();
    limitSpy.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  async function loadApp() {
    return (await import("../../src/index.js")).default;
  }

  it("returns the newest session for (org, user, configKey) with choices and opened pages", async () => {
    sessionRows = [
      {
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
        configKey: "copilot",
        createdAt: new Date("2026-10-09T10:00:00.000Z"),
        updatedAt: new Date("2026-10-09T10:05:00.000Z"),
      },
    ];
    const choices = {
      question: "Next?",
      choices: [
        { label: "Answer replies", value: "Answer replies", visual: { type: "number", value: "3", unit: "replies" } },
        { label: "Pause", value: "Pause", visual: { type: "icon", icon: "pause" } },
      ],
      allowFreeText: true,
    };
    messageRows = [
      { id: "m1", sessionId: SESSION_ID, role: "user", content: "hi", contentBlocks: null, toolCalls: null, buttons: null, choices: null, openPages: null, tokenCount: null, createdAt: new Date("2026-10-09T10:00:01.000Z") },
      { id: "m2", sessionId: SESSION_ID, role: "assistant", content: "Here is where you stand.", contentBlocks: null, toolCalls: null, buttons: null, choices, openPages: [{ page: "offer-today", brandId: "b1" }], tokenCount: 10, createdAt: new Date("2026-10-09T10:00:02.000Z") },
    ];

    const app = await loadApp();
    const res = await request(app).get("/sessions/latest").query({ configKey: "copilot" }).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(SESSION_ID);
    expect(res.body.configKey).toBe("copilot");
    expect(res.body.messages[1].choices).toEqual(choices);
    expect(res.body.messages[1].openPages).toEqual([{ page: "offer-today", brandId: "b1" }]);
    expect(res.body.messages[0].choices).toBeNull();
    expect(limitSpy).toHaveBeenCalledWith(1);
    expect(orderBySpy).toHaveBeenCalledTimes(1);
  });

  it("404s when the user has no session for that config key", async () => {
    const app = await loadApp();
    const res = await request(app).get("/sessions/latest").query({ configKey: "copilot" }).set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/copilot/);
  });

  it("400s without a configKey (and never reads it as a session id)", async () => {
    const app = await loadApp();
    const res = await request(app).get("/sessions/latest").set(AUTH);
    expect(res.status).toBe(400);
    expect(whereSpy).not.toHaveBeenCalled();
  });

  it("requires the user header (sessions are per user)", async () => {
    const app = await loadApp();
    const { "x-user-id": _omit, ...noUser } = AUTH;
    const res = await request(app).get("/sessions/latest").query({ configKey: "copilot" }).set(noUser);
    expect(res.status).toBe(400);
  });
});
