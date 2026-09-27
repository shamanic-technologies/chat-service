import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import { transferBrand } from "../../src/lib/transfer-brand.js";

/**
 * Walks every chat-service table that ties a brand to an org, against a real
 * database: after a transfer nothing of the brand is left under the source
 * org, and a second run is a no-op.
 */

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;

describe("transferBrand", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  let SRC_ORG: string;
  let DST_ORG: string;
  let BRAND: string;
  let OTHER_BRAND: string;
  const orgs: string[] = [];

  beforeAll(() => {
    if (!connectionString) {
      throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    }
    client = postgres(connectionString);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await db.delete(schema.sessions).where(inArray(schema.sessions.orgId, orgs));
    await db
      .delete(schema.brandProfileEmbeddings)
      .where(inArray(schema.brandProfileEmbeddings.orgId, orgs));
    await client?.end();
  });

  beforeEach(() => {
    // Fresh orgs per test: no cleanup coupling between cases.
    SRC_ORG = `test-transfer-src-${randomUUID()}`;
    DST_ORG = `test-transfer-dst-${randomUUID()}`;
    BRAND = randomUUID();
    OTHER_BRAND = randomUUID();
    orgs.push(SRC_ORG, DST_ORG);
  });

  async function seed() {
    const [brandSession] = await db
      .insert(schema.sessions)
      .values({ orgId: SRC_ORG, brandIds: [BRAND], campaignId: "camp-1" })
      .returning();
    await db.insert(schema.messages).values([
      { sessionId: brandSession.id, role: "user", content: "hi" },
      { sessionId: brandSession.id, role: "assistant", content: "hello" },
    ]);
    const [otherSession] = await db
      .insert(schema.sessions)
      .values({ orgId: SRC_ORG, brandIds: [OTHER_BRAND] })
      .returning();
    const [noBrandSession] = await db
      .insert(schema.sessions)
      .values({ orgId: SRC_ORG })
      .returning();
    await db.insert(schema.brandProfileEmbeddings).values([
      emb(SRC_ORG, BRAND, "h1"),
      emb(SRC_ORG, BRAND, "h2"),
      emb(SRC_ORG, OTHER_BRAND, "h1"),
    ]);
    return { brandSession, otherSession, noBrandSession };
  }

  function emb(orgId: string, brandId: string, contentHash: string) {
    return { orgId, brandId, contentHash, queryText: "q", embedding: [0.1], model: "m" };
  }

  async function sessionsOf(orgId: string) {
    return db.select().from(schema.sessions).where(eq(schema.sessions.orgId, orgId));
  }
  async function embeddingsOf(orgId: string) {
    return db
      .select()
      .from(schema.brandProfileEmbeddings)
      .where(eq(schema.brandProfileEmbeddings.orgId, orgId));
  }
  const counts = (r: { updatedTables: { tableName: string; count: number }[] }) =>
    Object.fromEntries(r.updatedTables.map((t) => [t.tableName, t.count]));

  it("moves sessions (with their messages) and embeddings, leaves other brands behind", async () => {
    const { brandSession, otherSession, noBrandSession } = await seed();

    const result = await transferBrand(db, {
      sourceBrandId: BRAND,
      sourceOrgId: SRC_ORG,
      targetOrgId: DST_ORG,
    });
    expect(counts(result)).toEqual({ sessions: 1, messages: 2, brand_profile_embeddings: 2 });

    // sessions: nothing of the brand left under the source org
    const src = await sessionsOf(SRC_ORG);
    expect(src.some((s) => s.brandIds?.includes(BRAND))).toBe(false);
    expect(src.map((s) => s.id).sort()).toEqual([otherSession.id, noBrandSession.id].sort());
    const dst = await sessionsOf(DST_ORG);
    expect(dst.map((s) => s.id)).toEqual([brandSession.id]);
    expect(dst[0].brandIds).toEqual([BRAND]);

    // messages follow their session
    const msgs = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.sessionId, brandSession.id));
    expect(msgs).toHaveLength(2);

    // brand_profile_embeddings
    const srcEmb = await embeddingsOf(SRC_ORG);
    expect(srcEmb.some((e) => e.brandId === BRAND)).toBe(false);
    expect(srcEmb).toHaveLength(1);
    const dstEmb = await embeddingsOf(DST_ORG);
    expect(dstEmb.map((e) => e.contentHash).sort()).toEqual(["h1", "h2"]);
  });

  it("is a no-op on re-run", async () => {
    await seed();
    const input = { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG };
    await transferBrand(db, input);
    const before = { s: await sessionsOf(DST_ORG), e: await embeddingsOf(DST_ORG) };

    const again = await transferBrand(db, input);
    expect(counts(again)).toEqual({ sessions: 0, messages: 0, brand_profile_embeddings: 0 });
    expect(await sessionsOf(DST_ORG)).toEqual(before.s);
    expect(await embeddingsOf(DST_ORG)).toEqual(before.e);
  });

  it("rewrites the brand id when targetBrandId is given, and re-run is a no-op", async () => {
    await seed();
    const TARGET_BRAND = randomUUID();
    const input = {
      sourceBrandId: BRAND,
      sourceOrgId: SRC_ORG,
      targetOrgId: DST_ORG,
      targetBrandId: TARGET_BRAND,
    };

    const result = await transferBrand(db, input);
    expect(counts(result)).toEqual({ sessions: 1, messages: 2, brand_profile_embeddings: 2 });

    const dst = await sessionsOf(DST_ORG);
    expect(dst[0].brandIds).toEqual([TARGET_BRAND]);
    const dstEmb = await embeddingsOf(DST_ORG);
    expect(dstEmb.every((e) => e.brandId === TARGET_BRAND)).toBe(true);
    expect((await sessionsOf(SRC_ORG)).some((s) => s.brandIds?.includes(BRAND))).toBe(false);

    const again = await transferBrand(db, input);
    expect(counts(again)).toEqual({ sessions: 0, messages: 0, brand_profile_embeddings: 0 });
  });

  it("drops a source cache row the target already holds for the same content instead of colliding", async () => {
    await seed();
    await db.insert(schema.brandProfileEmbeddings).values(emb(DST_ORG, BRAND, "h1"));

    await transferBrand(db, { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG });

    const dstEmb = await embeddingsOf(DST_ORG);
    expect(dstEmb.map((e) => e.contentHash).sort()).toEqual(["h1", "h2"]);
    expect((await embeddingsOf(SRC_ORG)).some((e) => e.brandId === BRAND)).toBe(false);
  });

  it("completes a run interrupted after the org move but before the brand rewrite", async () => {
    const TARGET_BRAND = randomUUID();
    // State an older two-statement version could leave behind.
    await db.insert(schema.sessions).values({ orgId: DST_ORG, brandIds: [BRAND] });
    await db.insert(schema.brandProfileEmbeddings).values(emb(DST_ORG, BRAND, "h9"));

    const result = await transferBrand(db, {
      sourceBrandId: BRAND,
      sourceOrgId: SRC_ORG,
      targetOrgId: DST_ORG,
      targetBrandId: TARGET_BRAND,
    });
    expect(counts(result)).toMatchObject({ sessions: 1, brand_profile_embeddings: 1 });
    expect((await sessionsOf(DST_ORG))[0].brandIds).toEqual([TARGET_BRAND]);
    expect((await embeddingsOf(DST_ORG))[0].brandId).toBe(TARGET_BRAND);
  });

  it("leaves co-branded sessions in place", async () => {
    await db.insert(schema.sessions).values({ orgId: SRC_ORG, brandIds: [BRAND, OTHER_BRAND] });

    const result = await transferBrand(db, {
      sourceBrandId: BRAND,
      sourceOrgId: SRC_ORG,
      targetOrgId: DST_ORG,
    });
    expect(counts(result).sessions).toBe(0);
    expect(await sessionsOf(SRC_ORG)).toHaveLength(1);
  });

  it("does not touch the org-level app_configs", async () => {
    await db.insert(schema.appConfigs).values({
      orgId: SRC_ORG,
      key: `k-${randomUUID()}`,
      systemPrompt: "p",
      allowedTools: [],
    });
    await transferBrand(db, { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG });
    const rows = await db
      .select()
      .from(schema.appConfigs)
      .where(eq(schema.appConfigs.orgId, SRC_ORG));
    expect(rows).toHaveLength(1);
    await db.delete(schema.appConfigs).where(eq(schema.appConfigs.orgId, SRC_ORG));
  });
});
