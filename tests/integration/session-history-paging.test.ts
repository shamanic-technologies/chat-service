import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";

/**
 * MON-PAGE-SPEED-1114: the Copilot panel reads only the newest messages on a page load and
 * older ones on scroll. Real database: the cursor is compared on the stored row (microseconds).
 */
const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const ORG = `org-paging-${Date.now().toString(36)}`;
const USER = "user-paging";
const OTHER_USER = "user-other";
const SESSION = randomUUID();
const OTHER_SESSION = randomUUID();
const AUTH = { "x-api-key": "test-key", "x-org-id": ORG, "x-user-id": USER, "x-run-id": randomUUID() };
const TOTAL = 75;

describe("GET /sessions/* paging", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;
  let app: import("express").Express;
  const ids: string[] = [];
  let hiddenId = "";

  beforeAll(async () => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    client = postgres(connectionString);
    await client`INSERT INTO sessions (id, org_id, user_id, config_key) VALUES (${SESSION}, ${ORG}, ${USER}, 'copilot'), (${OTHER_SESSION}, ${ORG}, ${OTHER_USER}, 'copilot')`;
    const base = Date.parse("2026-11-16T09:00:00.000Z");
    for (let i = 0; i < TOTAL; i++) {
      const id = randomUUID();
      ids.push(id);
      // Several rows share one microsecond-precise timestamp: the id breaks the tie.
      const at = new Date(base + Math.floor(i / 3) * 1000).toISOString().replace("Z", "123Z");
      await client`INSERT INTO messages (id, session_id, role, content, created_at) VALUES (${id}, ${SESSION}, ${i % 2 ? "assistant" : "user"}, ${`turn ${i}`}, ${at}::timestamptz + interval '0.000456 second')`;
    }
    // A nudge trigger: stored, never shown.
    hiddenId = randomUUID();
    await client`INSERT INTO messages (id, session_id, role, content, proactive_trigger, created_at) VALUES (${hiddenId}, ${SESSION}, 'user', 'nudge', true, ${new Date(base + 5_500).toISOString()})`;
    await client`INSERT INTO messages (id, session_id, role, content) VALUES (${randomUUID()}, ${OTHER_SESSION}, 'user', 'theirs')`;
    app = (await import("../../src/index.js")).default;
  });

  afterAll(async () => {
    await client`DELETE FROM sessions WHERE org_id = ${ORG}`;
    await client?.end();
  });

  it("the full read is unchanged and says nothing older exists", async () => {
    const res = await request(app).get("/sessions/latest").query({ configKey: "copilot" }).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(TOTAL);
    expect(res.body.hasOlder).toBe(false);
    expect(res.body.olderCursor).toBeNull();
  });

  for (const route of ["latest", "by-id"] as const) {
    it(`${route}: the newest page, then scrolling back reaches the first message with no gap or repeat`, async () => {
      const full = await request(app).get(`/sessions/${SESSION}`).set(AUTH);
      const fullIds = full.body.messages.map((m: { id: string }) => m.id);
      const read = (before?: string) =>
        route === "latest"
          ? request(app).get("/sessions/latest").query({ configKey: "copilot", limit: 30, ...(before ? { before } : {}) }).set(AUTH)
          : request(app).get(`/sessions/${SESSION}`).query({ limit: 30, ...(before ? { before } : {}) }).set(AUTH);

      const first = await read();
      expect(first.status).toBe(200);
      expect(first.body.messages.map((m: { id: string }) => m.id)).toEqual(fullIds.slice(-30));
      expect(first.body.hasOlder).toBe(true);

      const seen: string[] = [];
      let res = first;
      for (;;) {
        seen.unshift(...res.body.messages.map((m: { id: string }) => m.id));
        if (!res.body.hasOlder) break;
        res = await read(res.body.olderCursor);
        expect(res.status).toBe(200);
      }
      expect(seen).toEqual(fullIds);
      expect(seen).not.toContain(hiddenId);
    });
  }

  it("a cursor from another user's session is a 404, on both routes", async () => {
    const theirs = await client<{ id: string }[]>`SELECT id FROM messages WHERE session_id = ${OTHER_SESSION}`;
    const latest = await request(app).get("/sessions/latest").query({ configKey: "copilot", limit: 10, before: theirs[0].id }).set(AUTH);
    expect(latest.status).toBe(404);
    const byId = await request(app).get(`/sessions/${SESSION}`).query({ limit: 10, before: theirs[0].id }).set(AUTH);
    expect(byId.status).toBe(404);
  });

  it("`before` without `limit` is a 400; a limit out of range is a 400", async () => {
    const a = await request(app).get("/sessions/latest").query({ configKey: "copilot", before: ids[3] }).set(AUTH);
    expect(a.status).toBe(400);
    const b = await request(app).get("/sessions/latest").query({ configKey: "copilot", limit: 500 }).set(AUTH);
    expect(b.status).toBe(400);
  });

  it("10 concurrent page loads all answer the same newest page", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => request(app).get("/sessions/latest").query({ configKey: "copilot", limit: 30 }).set(AUTH)),
    );
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.messages.map((m: { id: string }) => m.id)).toEqual(results[0].body.messages.map((m: { id: string }) => m.id));
    }
    expect(results[0].body.messages).toHaveLength(30);
  });
});
