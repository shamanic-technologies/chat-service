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

  const page = (score: number | null) => {
    const models = [{ id: "a", name: "Claude Haiku 5.5 (Low)", suffix: "Low", release: { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5" }, intelligenceIndex: score, intelligenceIndexCostPerTask: 0.0437 }];
    const payload = `21:["$","div",null,{"initialModels":${JSON.stringify(models)}}]`;
    return `<p>Intelligence Index v5.0.1</p><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
  };

  it("no key reads the public page: bronze keeps the raw page, silver every variant; a page with nothing scored is a stored failure and the good reading stays served", async () => {
    const t0 = new Date("2026-11-18T08:00:00Z");
    const ok = (async () => new Response(page(18.6), { status: 200 })) as unknown as typeof fetch;
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: undefined, now: t0, fetchImpl: ok })).toBe("stored");
    // Within 24 h: nothing re-read.
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: undefined, now: new Date("2026-11-18T20:00:00Z"), fetchImpl: ok })).toBe("fresh");
    const [bronze] = await db.select().from(schema.intelligenceIndexReads);
    expect(bronze).toMatchObject({ status: "ok", source: "public_page", indexVersion: "5.0.1" });
    expect(bronze!.rawText).toContain("initialModels");

    const empty = (async () => new Response(page(null), { status: 200 })) as unknown as typeof fetch;
    const t1 = new Date("2026-11-19T09:00:00Z");
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: undefined, now: t1, fetchImpl: empty })).toBe("failed");

    const state = await readIndexState(db as never);
    expect(state.latestAttempt).toMatchObject({ status: "failed", source: "public_page" });
    expect(state.latestAttempt!.error).toMatch(/none carries an Intelligence Index score/);
    expect(state.latestOk!.entries).toEqual([
      expect.objectContaining({ aaId: "a", releaseSlug: "claude-haiku-5-5", variantLabel: "Low", effort: "low", score: expect.closeTo(18.6, 3), indexCostPerTaskUsd: expect.closeTo(0.0437, 3) }),
    ]);
  });

  it("with a key the API is read (source api)", async () => {
    await db.delete(schema.intelligenceIndexScores);
    await db.delete(schema.intelligenceIndexReads);
    const body = { intelligence_index_version: 5, pagination: { has_more: false }, data: [{ id: "b", name: "Claude Haiku 5.5 (Max)", slug: "claude-haiku-5-5", evaluations: { artificial_analysis_intelligence_index: 36.5 }, artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.41 } } }] };
    const api = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    expect(await refreshIntelligenceIndex({ database: db as never, apiKey: "k", now: new Date("2026-11-20T08:00:00Z"), fetchImpl: api })).toBe("stored");
    const state = await readIndexState(db as never);
    expect(state.latestOk!.read.source).toBe("api");
    expect(state.latestOk!.entries[0]).toMatchObject({ effort: "max", indexCostPerTaskUsd: expect.closeTo(0.41, 3) });
  });
});
