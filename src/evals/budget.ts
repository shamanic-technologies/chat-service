// ---------------------------------------------------------------------------
// Eval spend ceilings (EVAL-SPEND-CAP-1121, owner 2026-11-21 « ça dépense trop,
// c'est pas possible !!! »). November: 34,662 replayed turns, ~$104, $42 of it
// on Claude, and the org's $160 Claude limit crossed on 11-21, refusing every
// client chat until December. Each turn was cheap ($0.003); the VOLUME was not
// (7,112 turns in one hour on 11-19).
//
// So every eval replay (and judge call) is money RESERVED before it runs and
// SETTLED at what runs-service priced it at:
//   - a per-run ceiling (`--max-usd`, default $1): the run is refused before any
//     spend when its PROJECTION crosses it, and stops cleanly (partial results
//     written, exit 1) the moment the next replay would cross it;
//   - a fleet-wide daily ceiling (`EVAL_DAILY_USD`, default $3) over every eval
//     run of the UTC day, concurrent runs included: one Postgres advisory lock
//     serialises the reservations in `eval_spend`.
// The values follow eval-budgeting practice: hard USD caps that stop scoring
// when hit (LangSmith evaluator spend limits), a cost projected up front as
// rows x variants x runs x cost per evaluation before the run starts (Arize),
// and caching of fully versioned evaluations (see replay-plan.ts). Our measured
// replay is ~$0.0015 (reply + judge), so $1 still covers one side of the merge
// gate (73 scenarios x 3) and $3 a day about four such runs.
// ---------------------------------------------------------------------------

import { sql, type SQL } from "drizzle-orm";

export const EVAL_RUN_CEILING_USD = 1;
export const EVAL_DAILY_CEILING_USD = 3;
/** Cost of one replay (reply + judge) assumed before this model was ever measured: ~2.5x the measured mean (Haiku 5.5, 2026-11-19). */
export const REPLAY_PRIOR_USD = 0.004;
/** Cost of one judge call assumed before measurement (measured ~$0.0002). */
export const JUDGE_PRIOR_USD = 0.0005;
/** A reservation never settled (the process died) stops counting after this long. */
const STALE_RESERVATION_MINUTES = 30;

export interface EvalDb {
  execute(query: SQL): Promise<unknown>;
  transaction<T>(fn: (tx: EvalDb) => Promise<T>): Promise<T>;
}

const rowsOf = (r: unknown): Array<Record<string, unknown>> => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, unknown>>;
const usd = (cents: number) => `$${(cents / 100).toFixed(cents < 100 ? 4 : 2)}`;

export class EvalSpendCeilingError extends Error {
  constructor(
    readonly scope: "run" | "day",
    readonly basis: "projected" | "actual",
    readonly spentCents: number,
    readonly wouldReachCents: number,
    readonly ceilingCents: number,
  ) {
    super(
      scope === "run"
        ? `[evals] run spend ceiling reached (${basis}): spent ${usd(spentCents)}, the next work would reach ${usd(wouldReachCents)}, ceiling ${usd(ceilingCents)} (--max-usd)`
        : `[evals] fleet daily eval spend ceiling reached (${basis}): every eval run today spent ${usd(spentCents)}, the next work would reach ${usd(wouldReachCents)}, ceiling ${usd(ceilingCents)} a day (EVAL_DAILY_USD)`,
    );
    this.name = "EvalSpendCeilingError";
  }
}

export interface Reservation {
  /** Measured cents runs-service answered for a cost posted by this work. */
  add(cents: number): void;
  /** Settles at what was measured; a failed work settles at least at its reservation (its spend is unknown). */
  close(failed?: boolean): Promise<void>;
}

export interface EvalBudget {
  /** Refuses (throws) before any spend when `replays` x `perReplayUsd` crosses the run ceiling or what is left of the day's. */
  checkProjection(replays: number, perReplayUsd: number): Promise<void>;
  /** Reserves the next work's estimate; throws EvalSpendCeilingError (and stays stopped) when it would cross a ceiling. */
  reserve(estimateUsd: number): Promise<Reservation>;
  spentCents(): number;
  ceilingCents(): number;
  stopped(): EvalSpendCeilingError | null;
  /** "spent $0.0123 of $1.00" for the progress lines. */
  line(): string;
}

export function evalDailyCeilingUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EVAL_DAILY_USD;
  if (raw === undefined || raw === "") return EVAL_DAILY_CEILING_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`[evals] EVAL_DAILY_USD must be a positive number of dollars, got "${raw}"`);
  return n;
}

export function evalRunCeilingUsd(raw: string | undefined): number {
  if (raw === undefined) return EVAL_RUN_CEILING_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`[evals] --max-usd must be a positive number of dollars, got "${raw}"`);
  return n;
}

/** Replays per scenario: ONE unless asked (EVAL-SPEND-CAP-1121); the merge gate asks --runs 3 itself. */
export function evalRunsPerScenario(raw: string | undefined): number {
  const n = Number(raw ?? "1");
  if (!Number.isInteger(n) || n < 1) throw new Error(`[evals] --runs must be a whole number >= 1, got "${raw}"`);
  return n;
}

/** The scenarios a change touches are named; the whole suite only on --all (the merge gate). */
export function requireScenarioSelection(only: readonly string[] | undefined, all: boolean): void {
  if ((!only || only.length === 0) && !all) {
    throw new Error("[evals] name the scenarios your change touches with --only id1,id2, or pass --all for the whole suite (the merge gate)");
  }
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

async function dayCents(db: EvalDb, day: string): Promise<number> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT COALESCE(SUM(COALESCE(spent_cents,
        CASE WHEN created_at > now() - make_interval(mins => ${STALE_RESERVATION_MINUTES}) THEN reserved_cents ELSE 0 END)), 0) AS cents
      FROM eval_spend WHERE day = ${day}`),
  );
  return Number(rows[0]?.cents ?? 0);
}

export function evalBudget(opts: { db: EvalDb; runKey: string; runCeilingUsd: number; dailyCeilingUsd: number; now?: () => Date }): EvalBudget {
  const { db, runKey } = opts;
  const now = opts.now ?? (() => new Date());
  const runCeil = opts.runCeilingUsd * 100;
  const dayCeil = opts.dailyCeilingUsd * 100;
  let spent = 0;
  let inflight = 0;
  let stop: EvalSpendCeilingError | null = null;
  const halt = (e: EvalSpendCeilingError): never => {
    stop = stop ?? e;
    throw e;
  };

  return {
    async checkProjection(replays, perReplayUsd) {
      const projected = replays * perReplayUsd * 100;
      if (projected <= 0) return;
      if (spent + projected > runCeil) halt(new EvalSpendCeilingError("run", "projected", spent, spent + projected, runCeil));
      const today = await dayCents(db, utcDay(now()));
      if (today + projected > dayCeil) halt(new EvalSpendCeilingError("day", "projected", today, today + projected, dayCeil));
    },
    async reserve(estimateUsd) {
      if (stop) throw stop;
      const est = estimateUsd * 100;
      if (spent + inflight + est > runCeil) halt(new EvalSpendCeilingError("run", spent >= runCeil ? "actual" : "projected", spent, spent + inflight + est, runCeil));
      const day = utcDay(now());
      const got = await db.transaction(async (tx): Promise<{ refusedAt: number } | { id: number }> => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('eval_spend'))`);
        const today = await dayCents(tx, day);
        if (today + est > dayCeil) return { refusedAt: today };
        const ins = rowsOf(await tx.execute(sql`INSERT INTO eval_spend (day, run_key, reserved_cents) VALUES (${day}, ${runKey}, ${est}) RETURNING id`));
        return { id: Number(ins[0].id) };
      });
      if ("refusedAt" in got) return halt(new EvalSpendCeilingError("day", got.refusedAt >= dayCeil ? "actual" : "projected", got.refusedAt, got.refusedAt + est, dayCeil));
      const id = got.id;
      inflight += est;
      let measured = 0;
      let closed = false;
      return {
        add(cents) {
          measured += cents;
        },
        async close(failed = false) {
          if (closed) return;
          closed = true;
          const settled = failed ? Math.max(measured, est) : measured;
          await db.execute(sql`UPDATE eval_spend SET spent_cents = ${settled} WHERE id = ${id}`);
          inflight -= est;
          spent += settled;
          if (spent >= runCeil && !stop) stop = new EvalSpendCeilingError("run", "actual", spent, spent, runCeil);
        },
      };
    },
    spentCents: () => spent,
    ceilingCents: () => runCeil,
    stopped: () => stop,
    line: () => `spent ${usd(spent)} of ${usd(runCeil)}`,
  };
}
