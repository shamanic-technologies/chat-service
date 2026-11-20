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

  const apiBody = (score: number | null) => ({
    intelligence_index_version: 5,
    pagination: { has_more: false },
    data: [
      { id: "a", name: "Claude Haiku 5.5 (Low)", slug: "claude-haiku-5-5-low", evaluations: { artificial_analysis_intelligence_index: score }, artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.0437 } } },
      { id: "b", name: "Claude Haiku 5.5 (Max)", slug: "claude-haiku-5-5", evaluations: { artificial_analysis_intelligence_index: 36.5 }, artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.41 } } },
    ],
  });

  it("no key reads nothing and stores nothing", async () => {
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: undefined })).toBe("no_key");
    expect((await readIndexState(db as never)).latestAttempt).toBeNull();
  });

  it("a good API read stores bronze + every variant; a later failure is stored and the good reading stays served", async () => {
    const t0 = new Date("2026-11-18T08:00:00Z");
    const ok = (async () => new Response(JSON.stringify(apiBody(18.6)), { status: 200 })) as unknown as typeof fetch;
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: "k", now: t0, fetchImpl: ok })).toBe("stored");
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: "k", now: new Date("2026-11-18T20:00:00Z"), fetchImpl: ok })).toBe("fresh");
    const [bronze] = await db.select().from(schema.intelligenceIndexReads);
    expect(bronze).toMatchObject({ status: "ok", source: "api", indexVersion: "5" });

    const bad = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: "k", now: new Date("2026-11-19T09:00:00Z"), fetchImpl: bad })).toBe("failed");

    const state = await readIndexState(db as never);
    expect(state.latestAttempt).toMatchObject({ status: "failed", source: "api" });
    expect(state.latestAttempt!.error).toMatch(/503/);
    const low = state.latestOk!.entries.find((e) => e.aaId === "a");
    expect(low).toMatchObject({ releaseSlug: "claude-haiku-5-5", variantLabel: "Low", effort: "low", score: expect.closeTo(18.6, 3), indexCostPerTaskUsd: expect.closeTo(0.0437, 3) });
  });

  it("a superseded read is no attempt: the next tick reads at once", async () => {
    await db.delete(schema.intelligenceIndexScores);
    await db.delete(schema.intelligenceIndexReads);
    await db.insert(schema.intelligenceIndexReads).values({ fetchedAt: new Date("2026-11-20T07:09:00Z"), status: "superseded", indexVersion: "5" });
    expect((await readIndexState(db as never)).latestAttempt).toBeNull();
    const ok = (async () => new Response(JSON.stringify(apiBody(18.6)), { status: 200 })) as unknown as typeof fetch;
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: "k", now: new Date("2026-11-20T07:27:00Z"), fetchImpl: ok })).toBe("stored");
  });
});
