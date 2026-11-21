// ---------------------------------------------------------------------------
// Which replays a run really makes (EVAL-SPEND-CAP-1121). A replay already
// judged under the same key (agent definition, Sophie's code, the eval code,
// the scenario, the model and every setting on the wire, the judge) is REUSED
// at $0: the same request to the same model graded by the same judge measures
// nothing new. Only the missing replays run, each under the budget's ceilings,
// and the run stops cleanly the moment the next one would cross a ceiling.
// A failed replay (a vendor 500) is never kept: it is replayed next time.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { EvalSpendCeilingError, REPLAY_PRIOR_USD, type EvalBudget, type EvalDb, type Reservation } from "./budget.js";

const rowsOf = (r: unknown): Array<Record<string, unknown>> => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, unknown>>;

const sortedJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

export function replayCacheKey(parts: Record<string, unknown>): string {
  return createHash("sha256").update(sortedJson(parts)).digest("hex").slice(0, 32);
}

/** The eval runner's own code (this directory, compiled or not): a change to how a replay is made or judged is a new key. */
export function evalCodeHash(dir = dirname(fileURLToPath(import.meta.url))): string {
  const files = readdirSync(dir).filter((f) => /\.(js|ts)$/.test(f) && !f.endsWith(".d.ts")).sort();
  const h = createHash("sha256");
  for (const f of files) h.update(f).update(readFileSync(join(dir, f)));
  return h.digest("hex").slice(0, 16);
}

/** A kept replay is reused for a week: past that, the vendor may serve the model differently. */
export const REUSE_DAYS = 7;

export async function cachedReplays<R>(db: EvalDb, key: string, limit: number): Promise<R[]> {
  if (limit <= 0) return [];
  const rows = rowsOf(await db.execute(sql`SELECT result FROM eval_replay_cache WHERE cache_key = ${key} AND created_at > now() - make_interval(days => ${REUSE_DAYS}) ORDER BY id LIMIT ${limit}`));
  return rows.map((r) => r.result as R);
}

export async function storeReplay(db: EvalDb, row: { key: string; scenarioId: string; model: string; costUsd: number; result: unknown }): Promise<void> {
  await db.execute(sql`INSERT INTO eval_replay_cache (cache_key, scenario_id, model, cost_usd, result) VALUES (${row.key}, ${row.scenarioId}, ${row.model}, ${row.costUsd}, ${JSON.stringify(row.result)}::jsonb)`);
}

/** Mean measured cost of one replay on this model, over its latest 200 kept replays of the last 14 days; null = never measured. */
export async function measuredCostPerReplayUsd(db: EvalDb, model: string): Promise<number | null> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT AVG(cost_usd) AS mean, COUNT(*) AS n FROM (
        SELECT cost_usd FROM eval_replay_cache WHERE model = ${model} AND created_at > now() - interval '14 days' ORDER BY id DESC LIMIT 200
      ) t`),
  );
  return Number(rows[0]?.n ?? 0) > 0 ? Number(rows[0].mean) : null;
}

export interface PlannedScenario {
  id: string;
  key: string;
}

export interface ReplayOutcome<R> {
  result: R;
  /** What this replay cost, measured (reply + judge). */
  costUsd: number;
  failed: boolean;
}

export interface PlanResult<R> {
  /** Per scenario: reused replays first (marked), then the fresh ones, in order. */
  byScenario: Map<string, R[]>;
  reused: number;
  replayed: number;
  /** Replays the run never made because a ceiling stopped it. */
  skipped: number;
  stopped: EvalSpendCeilingError | null;
}

/**
 * Reuses what is kept, projects the rest against the ceilings (throws before
 * any spend when the projection crosses one), then replays the missing ones
 * under the budget. `replayOnce` records every measured cost on its reservation.
 */
export async function runReplayPlan<R extends object>(opts: {
  db: EvalDb;
  budget: EvalBudget;
  scenarios: PlannedScenario[];
  runs: number;
  parallel: number;
  model: string;
  fresh: boolean;
  replayOnce: (scenarioId: string, run: number, reservation: Reservation) => Promise<ReplayOutcome<R>>;
  log?: (line: string) => void;
}): Promise<PlanResult<R>> {
  const { db, budget, runs, model } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const byScenario = new Map<string, R[]>();
  const jobs: Array<{ scenario: PlannedScenario; run: number }> = [];
  let reused = 0;
  for (const s of opts.scenarios) {
    const kept = opts.fresh ? [] : await cachedReplays<R>(db, s.key, runs);
    byScenario.set(s.id, kept.map((r) => ({ ...r, reused: true })));
    reused += kept.length;
    for (let i = kept.length; i < runs; i++) jobs.push({ scenario: s, run: i });
  }
  const perReplay = (await measuredCostPerReplayUsd(db, model)) ?? REPLAY_PRIOR_USD;
  log(`[evals] ${reused} replays reused at $0, ${jobs.length} to replay at ~$${perReplay.toFixed(4)} each (measured on ${model} when kept, else the prior)`);
  await budget.checkProjection(jobs.length, perReplay);

  const fresh = new Map<string, Array<{ run: number; r: R }>>();
  let replayed = 0;
  let measuredSum = 0;
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      if (budget.stopped()) return;
      const estimate = Math.max(perReplay, replayed > 0 ? measuredSum / replayed : 0);
      let reservation: Reservation;
      try {
        reservation = await budget.reserve(estimate);
      } catch (err) {
        if (err instanceof EvalSpendCeilingError) return;
        throw err;
      }
      let outcome: ReplayOutcome<R>;
      try {
        outcome = await opts.replayOnce(job.scenario.id, job.run, reservation);
      } catch (err) {
        await reservation.close(true);
        throw err;
      }
      await reservation.close(outcome.failed);
      replayed++;
      measuredSum += outcome.costUsd;
      if (!outcome.failed) await storeReplay(db, { key: job.scenario.key, scenarioId: job.scenario.id, model, costUsd: outcome.costUsd, result: outcome.result });
      const list = fresh.get(job.scenario.id) ?? [];
      list.push({ run: job.run, r: outcome.result });
      fresh.set(job.scenario.id, list);
      log(`[evals] ${job.scenario.id} run ${job.run + 1}/${runs}: $${outcome.costUsd.toFixed(4)}, ${budget.line()}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.parallel) }, worker));
  for (const [id, list] of fresh) byScenario.get(id)!.push(...list.sort((a, b) => a.run - b.run).map((x) => x.r));
  const stopped = budget.stopped();
  return { byScenario, reused, replayed, skipped: jobs.length - replayed, stopped };
}
