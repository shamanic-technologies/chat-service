// Postgres side of vendor-credit.ts (VENDOR-CREDIT-1030): tables
// `vendor_credit_outages` + `vendor_credit_days` (migration 0029).
import { sql } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import type { Provider } from "./anthropic.js";
import type { DayCountRow, OutageRow, VendorCreditStore } from "./vendor-credit.js";

type Database = typeof Db;

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function createVendorCreditStore(database: Database): VendorCreditStore {
  return {
    async recordRefusal({ provider, model, at, message }) {
      const ts = at.toISOString();
      // One statement opens the outage or extends the open one: the partial
      // unique index makes two concurrent first refusals land on one row.
      await database.execute(sql`
        INSERT INTO vendor_credit_outages (provider, model, first_seen_at, last_seen_at, refused_calls, last_message)
        VALUES (${provider}, ${model}, ${ts}::timestamptz, ${ts}::timestamptz, 1, ${message})
        ON CONFLICT (provider) WHERE recovered_at IS NULL
        DO UPDATE SET last_seen_at = GREATEST(vendor_credit_outages.last_seen_at, EXCLUDED.last_seen_at),
                      refused_calls = vendor_credit_outages.refused_calls + 1,
                      last_message = EXCLUDED.last_message`);
      await database.execute(sql`
        INSERT INTO vendor_credit_days (day, provider, refused_calls) VALUES (${utcDay(at)}::date, ${provider}, 1)
        ON CONFLICT (day, provider) DO UPDATE SET refused_calls = vendor_credit_days.refused_calls + 1`);
    },
    async recordReroute({ provider, at }) {
      await database.execute(sql`
        UPDATE vendor_credit_outages SET rerouted_calls = rerouted_calls + 1
        WHERE provider = ${provider} AND recovered_at IS NULL`);
      await database.execute(sql`
        INSERT INTO vendor_credit_days (day, provider, rerouted_calls) VALUES (${utcDay(at)}::date, ${provider}, 1)
        ON CONFLICT (day, provider) DO UPDATE SET rerouted_calls = vendor_credit_days.rerouted_calls + 1`);
    },
    async closeOutage({ provider, at }) {
      await database.execute(sql`
        UPDATE vendor_credit_outages SET recovered_at = ${at.toISOString()}::timestamptz
        WHERE provider = ${provider} AND recovered_at IS NULL`);
    },
    async loadOpen() {
      const rows = rowsOf(await database.execute(sql`
        SELECT provider, first_seen_at FROM vendor_credit_outages WHERE recovered_at IS NULL`));
      return rows.map((r) => ({ provider: String(r.provider) as Provider, firstSeenAt: new Date(String(r.first_seen_at)) }));
    },
  };
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

/** Rows the staff read needs: every outage touching the window, plus each provider's latest. */
export async function loadVendorCreditRows(
  database: Database,
  days: number,
  now: Date = new Date(),
): Promise<{ outages: OutageRow[]; dayCounts: DayCountRow[] }> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(today - (days - 1) * 86_400_000).toISOString();
  const outages = rowsOf(await database.execute(sql`
    SELECT provider, first_seen_at, last_seen_at, recovered_at, refused_calls, rerouted_calls
    FROM vendor_credit_outages o
    WHERE recovered_at IS NULL OR recovered_at >= ${from}::timestamptz
       OR first_seen_at = (SELECT max(first_seen_at) FROM vendor_credit_outages l WHERE l.provider = o.provider)`));
  const dayCounts = rowsOf(await database.execute(sql`
    SELECT day::text AS day, provider, refused_calls, rerouted_calls
    FROM vendor_credit_days WHERE day >= ${from}::date`));
  return {
    outages: outages.map((r) => ({
      provider: String(r.provider),
      firstSeenAt: toDate(r.first_seen_at),
      lastSeenAt: toDate(r.last_seen_at),
      recoveredAt: r.recovered_at == null ? null : toDate(r.recovered_at),
      refusedCalls: Number(r.refused_calls),
      reroutedCalls: Number(r.rerouted_calls),
    })),
    dayCounts: dayCounts.map((r) => ({
      day: String(r.day),
      provider: String(r.provider),
      refusedCalls: Number(r.refused_calls),
      reroutedCalls: Number(r.rerouted_calls),
    })),
  };
}
