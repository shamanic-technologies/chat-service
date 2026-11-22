import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { like } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";

// DISTRY-SKILL-MENTIONS-1122: the shapes the dashboard reads and the saves it still sends.
process.env.NODE_ENV = "test";
const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const P = `mr-${Date.now().toString(36)}`;
const KEY = { "x-api-key": "test-key" };
const ED = "kevin@distribute.you";

describe("skill routes serve who mentions whom", { timeout: 60000 }, () => {
  let app: import("express").Express;
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    client = postgres(connectionString);
    db = drizzle(client, { schema });
    app = (await import("../../src/index.js")).default;
  }, 120_000);

  afterAll(async () => {
    await db.delete(schema.skills).where(like(schema.skills.slug, `${P}-%`));
    await client?.end();
  });

  it("create needs no parent; list and read serve mentions in text order, backlinks and never-mentioned", async () => {
    const a = `${P}-a`;
    const b = `${P}-b`;
    const created = await request(app).put(`/internal/skills/${b}`).set(KEY).send({ content: "B.", title: "B", description: "b", editedBy: ED });
    expect(created.status).toBe(200);
    expect(created.body.skill).toMatchObject({ slug: b, parentSlug: null, neverMentioned: true, mentionedBy: { prompt: false, skills: [] } });

    // The dashboard's current save still sends a parent: accepted.
    const withParent = await request(app)
      .put(`/internal/skills/${a}`)
      .set(KEY)
      .send({ content: `Read @skill:${b}, call @tool:open_page, not @skill:${P}-ghost.`, title: "A", description: "a", parentSlug: b, editedBy: ED });
    expect(withParent.status).toBe(200);
    expect(withParent.body.skill.mentions).toEqual([
      { kind: "skill", ref: b, known: true },
      { kind: "tool", ref: "open_page", known: true },
      { kind: "skill", ref: `${P}-ghost`, known: false },
    ]);

    const list = await request(app).get("/internal/skills").set(KEY);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.prompt.mentions)).toBe(true);
    const rowB = list.body.skills.find((s: { slug: string }) => s.slug === b);
    expect(rowB).toMatchObject({ mentionedBy: { prompt: false, skills: [a] }, neverMentioned: false, reachable: false });
    const rowA = list.body.skills.find((s: { slug: string }) => s.slug === a);
    expect(rowA).toMatchObject({ neverMentioned: true });

    const one = await request(app).get(`/internal/skills/${b}`).set(KEY);
    expect(one.body).toMatchObject({ slug: b, content: "B.", mentionedBy: { skills: [a] } });

    // Deleting a mentioned skill: it goes, the result names who still mentions it.
    const del = await request(app).delete(`/internal/skills/${b}`).set(KEY).send({ editedBy: ED });
    expect(del.status).toBe(200);
    expect(del.body.mentionedBy).toEqual([a]);
    const after = await request(app).get(`/internal/skills/${a}`).set(KEY);
    expect(after.body.mentions[0]).toEqual({ kind: "skill", ref: b, known: false });
  });

  it("the Distry editor read carries each skill's links, the Prompt's mentions and the mentionable tools", async () => {
    const res = await request(app).get("/internal/distry/config").set(KEY);
    if (res.status === 503) return; // Distry not seeded in this database yet (another file seeds it).
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.promptMentions)).toBe(true);
    expect(res.body.mentionableTools).toContain("read_skill");
    expect(res.body.mentionableTools).not.toContain("engines");
    for (const s of res.body.skills) expect(s).toHaveProperty("neverMentioned");
  });
});
