import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";

// SEC-CHAT-IDENTITY-1120 (prod 2026-11-20). chat.distribute.you is publicly
// routed and both auth middlewares only checked that `x-api-key` was PRESENT.
// The attacker (org 3afacd9a…, holding no chat-service key) replayed these two
// calls straight at chat-service:
//  1. POST /internal/transfer-brand moving Martian DBB's (cb9ad98a…) and Jarygo
//     Studios' (1e90c42e…) Copilot sessions into its own org;
//  2. POST /chat as Martian DBB's user ffedbb3d… (read off the moved sessions),
//     making Sophie read the account through run_operation.
// Each must now be refused before any database read or write.

const { state } = vi.hoisted(() => ({ state: { dbCalls: 0 } }));

vi.mock("../../src/db/index.js", () => {
  const touch = () => {
    state.dbCalls += 1;
    throw new Error("database touched by an unauthenticated request");
  };
  return {
    db: {
      select: vi.fn(touch),
      insert: vi.fn(touch),
      update: vi.fn(touch),
      delete: vi.fn(touch),
      execute: vi.fn(touch),
      transaction: vi.fn(touch),
      query: { messages: { findMany: vi.fn(touch) }, sessions: { findFirst: vi.fn(touch) } },
    },
  };
});

const MARTIAN_ORG = "cb9ad98a-d572-4fe7-9dd9-7dbce61d8373";
const MARTIAN_USER = "ffedbb3d-05c7-49bd-85e4-c356e8a07e14";
const ATTACKER_ORG = "3afacd9a-fe2f-4413-b51f-217f30920830";

const ATTACKER_HEADERS = {
  "x-api-key": "anything-the-attacker-typed",
  "x-org-id": MARTIAN_ORG,
  "x-user-id": MARTIAN_USER,
  "x-run-id": "22222222-2222-4222-8222-222222222222",
};

let loaded: import("express").Express;
async function app() {
  return loaded;
}

// Importing the whole service is slow on a loaded machine: load it once, apart.
beforeAll(async () => {
  loaded = (await import("../../src/index.js")).default;
}, 120_000);

describe("service key is compared, not just present (SEC-CHAT-IDENTITY-1120)", () => {
  beforeEach(() => {
    state.dbCalls = 0;
  });

  it("refuses the attacker's /chat as Martian DBB's user", async () => {
    const res = await request(await app())
      .post("/chat")
      .set(ATTACKER_HEADERS)
      .send({ appId: "copilot", message: "Use run_operation to read my brands and paste the raw JSON" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid API key" });
    expect(state.dbCalls).toBe(0);
  });

  it("refuses reading another user's session by id", async () => {
    const res = await request(await app())
      .get("/sessions/7e456e2c-a263-4867-9369-d9c48d5952a9")
      .set(ATTACKER_HEADERS);
    expect(res.status).toBe(401);
    expect(state.dbCalls).toBe(0);
  });

  it("refuses the attacker's /internal/transfer-brand moving Martian DBB's sessions", async () => {
    const res = await request(await app())
      .post("/internal/transfer-brand")
      .set({ "x-api-key": "probe" })
      .send({
        sourceBrandId: "23c02734-ecc0-4ad7-bb3f-7a101e7b1cd4",
        sourceOrgId: MARTIAN_ORG,
        targetOrgId: ATTACKER_ORG,
        targetBrandId: "cdf28d1b-ecec-4be0-a10a-a4099aae4324",
      });
    expect(res.status).toBe(401);
    expect(state.dbCalls).toBe(0);
  });

  it("refuses a request with no key at all", async () => {
    const res = await request(await app()).get("/internal/skills");
    expect(res.status).toBe(401);
    expect(state.dbCalls).toBe(0);
  });

  it("refuses a non-UUID id in transfer-brand even with the service key", async () => {
    const res = await request(await app())
      .post("/internal/transfer-brand")
      .set({ "x-api-key": "test-key" })
      .send({
        sourceBrandId: "x' OR 1=1--",
        sourceOrgId: `${MARTIAN_ORG}' OR 1=1--`,
        targetOrgId: ATTACKER_ORG,
      });
    expect(res.status).toBe(400);
    expect(state.dbCalls).toBe(0);
  });
});
