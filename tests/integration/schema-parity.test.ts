import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../../src/db/schema.js";

/**
 * Guards the CI database against a half-built schema.
 *
 * `drizzle-kit push` prints its errors and still exits 0, so a migration or
 * schema statement that cannot execute leaves a partially-built database and a
 * green step. Against a Neon branch forked from production that never showed:
 * everything already existed, so nothing had to be created. Against the empty
 * database CI now starts from, it would — and the suite would fail somewhere
 * unrelated, or worse, pass while missing an index.
 *
 * This asserts the live database carries every table, column and index that
 * `schema.ts` declares. It fails loudly, naming what is missing.
 */

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;

const tables = [
  schema.sessions,
  schema.messages,
  schema.appConfigs,
  schema.platformConfigs,
  schema.brandProfileEmbeddings,
];

describe("schema parity — declared schema vs live database", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;

  beforeAll(() => {
    if (!connectionString) {
      throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    }
    client = postgres(connectionString);
  });

  afterAll(async () => {
    await client?.end();
  });

  it("every declared table exists with every declared column", async () => {
    const rows = await client<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `;
    const live = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));

    const missing: string[] = [];
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const key = `${config.name}.${column.name}`;
        if (!live.has(key)) missing.push(key);
      }
    }

    expect(missing).toEqual([]);
  });

  it("every declared index and unique constraint exists", async () => {
    const rows = await client<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const live = new Set(rows.map((r) => r.indexname));

    const missing: string[] = [];
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const index of config.indexes) {
        if (index.config.name && !live.has(index.config.name)) {
          missing.push(index.config.name);
        }
      }
      for (const constraint of config.uniqueConstraints) {
        if (constraint.name && !live.has(constraint.name)) {
          missing.push(constraint.name);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("carries the production index migration 0012 created on sessions", async () => {
    const rows = await client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'sessions_org_brand_idx'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("org_id");
    expect(rows[0].indexdef).toContain("brand_ids");
  });
});
