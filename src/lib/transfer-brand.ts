import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * Moves everything chat-service holds for ONE brand from one org to another.
 *
 * Every table that ties a brand to an org is covered — adding a table that
 * does is a change to this function, and `tests/integration/transfer-brand.test.ts`
 * walks each one:
 *
 * - `sessions` (org_id + brand_ids) — the brand's chat history. `messages`
 *   carry no org column; they belong to their session and move with it, so
 *   their count is reported but they are never rewritten.
 * - `brand_profile_embeddings` (org_id + brand_id) — the RAG score cache,
 *   partitioned per (org, brand). A row the target already holds for the same
 *   content hash is a byte-equivalent cache entry, so the source copy is
 *   dropped instead of colliding with the unique key.
 *
 * Deliberately NOT moved: `app_configs` (per-ORG chat configs, no brand) and
 * `platform_configs` (no org at all).
 *
 * Scope is SOLO-brand rows: a co-branded session (`brand_ids` of 2+) or a
 * multi-brand cache key (`"a,b"`) also belongs to a brand that stays behind,
 * so it is left in place. Production held zero of either on 2026-09-27.
 *
 * Idempotent: rows are matched in EITHER org under the SOURCE brand id, so a
 * re-run finds nothing left to move (brand rewritten, or already in target),
 * and a run interrupted by an older two-statement version (org moved, brand
 * not yet rewritten) is completed rather than skipped. Runs in one
 * transaction, so a failure moves nothing.
 */
export interface TransferBrandInput {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
}

export interface TransferBrandResult {
  updatedTables: { tableName: string; count: number }[];
}

type AnyPgDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export async function transferBrand(
  db: AnyPgDb,
  { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId }: TransferBrandInput,
): Promise<TransferBrandResult> {
  const finalBrandId = targetBrandId ?? sourceBrandId;

  return db.transaction(async (tx) => {
    // Rows still under the source org, plus (only when the brand id changes)
    // rows an interrupted earlier run already moved but never re-branded.
    // Without a targetBrandId, rows in the target org under the same brand id
    // are already done and must not be counted again.
    const orgFilter = targetBrandId
      ? sql`org_id IN (${sourceOrgId}, ${targetOrgId})`
      : sql`org_id = ${sourceOrgId}`;

    const movedSessions = (await tx.execute(sql`
      UPDATE sessions
      SET org_id = ${targetOrgId},
          brand_ids = ARRAY[${finalBrandId}]::text[],
          updated_at = NOW()
      WHERE ${orgFilter}
        AND brand_ids = ARRAY[${sourceBrandId}]::text[]
      RETURNING id
    `)) as unknown as { id: string }[];

    const sessionIds = movedSessions.map((r) => r.id);
    let messageCount = 0;
    if (sessionIds.length > 0) {
      const [row] = (await tx.execute(sql`
        SELECT count(*)::int AS count FROM messages
        WHERE session_id IN (${sql.join(sessionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `)) as unknown as { count: number }[];
      messageCount = row.count;
    }

    // Drop source cache rows the target already holds for the same content —
    // they would collide with the (org_id, brand_id, content_hash) unique key.
    const deduped = (await tx.execute(sql`
      DELETE FROM brand_profile_embeddings src
      USING brand_profile_embeddings dst
      WHERE src.org_id IN (${sourceOrgId}, ${targetOrgId})
        AND src.brand_id = ${sourceBrandId}
        AND dst.org_id = ${targetOrgId}
        AND dst.brand_id = ${finalBrandId}
        AND dst.content_hash = src.content_hash
        AND dst.id <> src.id
      RETURNING src.id
    `)) as unknown as { id: string }[];

    const movedEmbeddings = (await tx.execute(sql`
      UPDATE brand_profile_embeddings
      SET org_id = ${targetOrgId}, brand_id = ${finalBrandId}
      WHERE ${orgFilter}
        AND brand_id = ${sourceBrandId}
      RETURNING id
    `)) as unknown as { id: string }[];

    return {
      updatedTables: [
        { tableName: "sessions", count: sessionIds.length },
        { tableName: "messages", count: messageCount },
        {
          tableName: "brand_profile_embeddings",
          count: movedEmbeddings.length + deduped.length,
        },
      ],
    };
  });
}
