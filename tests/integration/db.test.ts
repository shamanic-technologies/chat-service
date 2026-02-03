import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;

describe("database integration", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    if (!connectionString) {
      throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    }
    client = postgres(connectionString);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client?.end();
  });

  it("should connect and query sessions table", async () => {
    const rows = await db.select().from(schema.sessions).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("should create, read, and delete a session", async () => {
    const [created] = await db
      .insert(schema.sessions)
      .values({ orgId: "test-org-integration" })
      .returning();

    expect(created.id).toBeDefined();
    expect(created.orgId).toBe("test-org-integration");
    expect(created.createdAt).toBeInstanceOf(Date);

    const [found] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, created.id));

    expect(found).toBeDefined();
    expect(found.id).toBe(created.id);

    await db.delete(schema.sessions).where(eq(schema.sessions.id, created.id));

    const [gone] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, created.id));

    expect(gone).toBeUndefined();
  });

  it("should create a message linked to a session and cascade delete", async () => {
    const [session] = await db
      .insert(schema.sessions)
      .values({ orgId: "test-org-msg" })
      .returning();

    const [message] = await db
      .insert(schema.messages)
      .values({
        sessionId: session.id,
        role: "user",
        content: "integration test message",
      })
      .returning();

    expect(message.id).toBeDefined();
    expect(message.sessionId).toBe(session.id);
    expect(message.role).toBe("user");
    expect(message.content).toBe("integration test message");

    // Cascade delete: removing session should remove its messages
    await db.delete(schema.sessions).where(eq(schema.sessions.id, session.id));

    const remaining = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, message.id));

    expect(remaining).toHaveLength(0);
  });

  it("should store and retrieve toolCalls and buttons JSONB", async () => {
    const [session] = await db
      .insert(schema.sessions)
      .values({ orgId: "test-org-jsonb" })
      .returning();

    const toolCalls = [{ name: "search", args: { q: "test" }, result: { hits: 1 } }];
    const buttons = [{ label: "Try again", value: "Try again" }];

    const [message] = await db
      .insert(schema.messages)
      .values({
        sessionId: session.id,
        role: "assistant",
        content: "Here are results",
        toolCalls,
        buttons,
        tokenCount: 42,
      })
      .returning();

    expect(message.toolCalls).toEqual(toolCalls);
    expect(message.buttons).toEqual(buttons);
    expect(message.tokenCount).toBe(42);

    // Cleanup
    await db.delete(schema.sessions).where(eq(schema.sessions.id, session.id));
  });
});
