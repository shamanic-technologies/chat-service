import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// Mock all heavy dependencies so we can import the Express app
vi.mock("../../src/db/index.js", () => {
  function makeValues() {
    const result: Record<string, unknown> = {
      returning: vi.fn().mockResolvedValue([{ id: "session-1" }]),
    };
    result.then = (
      resolve: (v: unknown) => void,
      reject?: (e: unknown) => void,
    ) => Promise.resolve().then(() => resolve(undefined), reject);
    return result;
  }
  return {
    db: {
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation(() => makeValues()),
      })),
      query: {
        messages: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    },
  };
});

vi.mock("../../src/lib/gemini.js", () => ({
  createGeminiClient: vi.fn().mockImplementation(() => ({
    model: "gemini-2.5-flash",
    streamChat: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: "done", usage: { promptTokens: 10, outputTokens: 5 } };
      })(),
    ),
    sendFunctionResult: vi.fn(),
  })),
  REQUEST_USER_INPUT_TOOL: { name: "request_user_input" },
}));

vi.mock("../../src/lib/mcp-client.js", () => ({
  connectMcp: vi.fn().mockRejectedValue(new Error("mocked")),
}));

const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-1" });
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: mockCreateRun,
  updateRunStatus: vi.fn().mockResolvedValue(null),
  addRunCosts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/key-client.js", () => ({
  decryptAppKey: vi.fn().mockResolvedValue({ key: "test-gemini-key" }),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return { ...orig, eq: vi.fn() };
});

vi.mock("drizzle-orm/postgres-js/migrator", () => ({
  migrate: vi.fn().mockResolvedValue(undefined),
}));

// Import app once (all mocks already registered above)
process.env.NODE_ENV = "test";
const { default: app } = await import("../../src/index.js");

const VALID_HEADERS = {
  Authorization: "Bearer test-api-key",
  "x-org-id": "550e8400-e29b-41d4-a716-446655440000",
  "x-user-id": "660e8400-e29b-41d4-a716-446655440001",
  "x-run-id": "770e8400-e29b-41d4-a716-446655440002",
};

describe("POST /chat required headers", () => {
  it("returns 400 when x-org-id is missing", async () => {
    const res = await request(app)
      .post("/chat")
      .set("Authorization", "Bearer test-key")
      .set("x-user-id", VALID_HEADERS["x-user-id"])
      .set("x-run-id", VALID_HEADERS["x-run-id"])
      .send({ message: "hello" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("returns 400 when x-user-id is missing", async () => {
    const res = await request(app)
      .post("/chat")
      .set("Authorization", "Bearer test-key")
      .set("x-org-id", VALID_HEADERS["x-org-id"])
      .set("x-run-id", VALID_HEADERS["x-run-id"])
      .send({ message: "hello" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-user-id");
  });

  it("returns 400 when x-run-id is missing", async () => {
    const res = await request(app)
      .post("/chat")
      .set("Authorization", "Bearer test-key")
      .set("x-org-id", VALID_HEADERS["x-org-id"])
      .set("x-user-id", VALID_HEADERS["x-user-id"])
      .send({ message: "hello" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-run-id");
  });

  it("returns 400 listing all missing headers when none provided", async () => {
    const res = await request(app)
      .post("/chat")
      .set("Authorization", "Bearer test-key")
      .send({ message: "hello" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
    expect(res.body.error).toContain("x-user-id");
    expect(res.body.error).toContain("x-run-id");
  });

  it("returns 401 before checking headers when auth is missing", async () => {
    const res = await request(app)
      .post("/chat")
      .send({ message: "hello" });

    expect(res.status).toBe(401);
  });

  it("passes parentRunId, orgId, and userId to createRun from headers", async () => {
    mockCreateRun.mockClear();

    await request(app)
      .post("/chat")
      .set(VALID_HEADERS)
      .send({ message: "hello" });

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: VALID_HEADERS["x-run-id"],
        clerkOrgId: VALID_HEADERS["x-org-id"],
        clerkUserId: VALID_HEADERS["x-user-id"],
      }),
    );
  });
});
