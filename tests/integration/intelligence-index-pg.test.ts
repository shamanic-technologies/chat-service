import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../src/db/schema.js";
import { readIndexState, refreshIntelligenceIndex } from "../../src/lib/intelligence-index.js";

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;

// DISTRY-MODELS-1119: bronze + silver of the Artificial Analysis read. Global tables: CI's throwaway database only.
describe("Intelligence Index store (DISTRY-MODELS-1119)", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    client = postgres(connectionString);
    db = drizzle(client, { schema });
    await db.delete(schema.intelligenceIndexScores);
    await db.delete(schema.intelligenceIndexReads);
  });

  afterAll(async () => {
    await client?.end();
  });

  const body = {
    intelligence_index_version: 5,
    pagination: { has_more: false },
    data: [
      { id: "a", name: "Claude Haiku 5.5", slug: "claude-haiku-5-5", evaluations: { artificial_analysis_intelligence_index: 41.2 }, artificial_analysis_intelligence_index_cost: { total_cost: 120.5 } },
    ],
  };

  it("no key reads nothing and stores nothing", async () => {
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: undefined })).toBe("no_key");
    expect((await readIndexState(db as never)).latestAttempt).toBeNull();
  });

  it("a good read stores bronze + silver; a later failure is stored and the good reading stays served", async () => {
    const t0 = new Date("2026-11-18T08:00:00Z");
    const ok = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: "k", now: t0, fetchImpl: ok })).toBe("stored");
    // Within 24 h: nothing re-read.
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: "k", now: new Date("2026-11-18T20:00:00Z"), fetchImpl: ok })).toBe("fresh");

    const bad = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const t1 = new Date("2026-11-19T09:00:00Z");
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: "k", now: t1, fetchImpl: bad })).toBe("failed");

    const state = await readIndexState(db as never);
    expect(state.latestAttempt).toMatchObject({ status: "failed" });
    expect(state.latestAttempt!.error).toMatch(/503/);
    expect(state.latestOk!.read.indexVersion).toBe("5");
    expect(state.latestOk!.entries).toEqual([
      expect.objectContaining({ aaSlug: "claude-haiku-5-5", score: expect.closeTo(41.2, 3), indexCostUsd: expect.closeTo(120.5, 3) }),
    ]);
  });
});
