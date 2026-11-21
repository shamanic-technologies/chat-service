import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  EVAL_MONTHLY_CEILING_USD,
  EvalSpendCeilingError,
  evalBudget,
  evalRunsPerScenario,
  requireScenarioSelection,
  type EvalDb,
} from "../../src/evals/budget.js";
import { runReplayPlan, type ReplayOutcome } from "../../src/evals/replay-plan.js";

// EVAL-SPEND-CAP-1121 on a real Postgres (CI's throwaway container): an eval
// run can no longer burn money unseen. The replays are faked (no model call):
// each "costs" what the test says runs-service measured.

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const tag = `esc${Date.now()}`;
let monthN = 0;
/** Every test counts in its own UTC month, so the fleet's monthly total starts at 0. */
const freshDay = () => {
  const d = new Date(Date.UTC(2099, monthN++, 15, 12));
  return () => d;
};

interface Fake {
  id: string;
  failed?: boolean;
}

const scenarios = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, key: `${tag}-${prefix}-${i}` }));

/** A replay costing `usd` (reply + judge), measured, after `delayMs`. */
const replayCosting = (usd: number, delayMs = 0, failed = false) =>
  vi.fn(async (scenarioId: string, _run: number, reservation: { add(c: number): void }): Promise<ReplayOutcome<Fake>> => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    reservation.add(usd * 100);
    return { result: { id: scenarioId, ...(failed ? { failed: true } : {}) }, costUsd: usd, failed };
  });

describe("eval spend ceilings", { timeout: 30_000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: EvalDb;

  beforeAll(() => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL is required");
    client = postgres(connectionString, { max: 6 });
    db = drizzle(client) as unknown as EvalDb;
  });

  afterAll(async () => {
    await client`DELETE FROM eval_replay_cache WHERE cache_key LIKE ${`${tag}%`}`;
    await client`DELETE FROM eval_spend WHERE run_key LIKE ${`${tag}%`}`;
    await client.end();
  });

  it("refuses a run whose projection crosses its ceiling before any spend, stating the figures", async () => {
    const budget = evalBudget({ db, runKey: `${tag}-proj`, runCeilingUsd: 0.1, monthlyCeilingUsd: 3, now: freshDay() });
    const replayOnce = replayCosting(0.0005);
    // 73 scenarios x 3 replays x 3 models at the prior ($0.0005): $0.3285 projected over a $0.10 ceiling.
    const err = await runReplayPlan({ db, budget, scenarios: scenarios(657, "proj"), runs: 1, parallel: 4, model: `${tag}/proj`, fresh: false, replayOnce, log: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(EvalSpendCeilingError);
    expect(err.scope).toBe("run");
    expect(err.basis).toBe("projected");
    expect(err.message).toContain("ceiling $0.1000");
    expect(err.message).toContain("$0.3285");
    expect(replayOnce).not.toHaveBeenCalled();
    const [{ n }] = await client`SELECT COUNT(*)::int AS n FROM eval_spend WHERE run_key = ${`${tag}-proj`}`;
    expect(n).toBe(0);
  });

  it("stops cleanly when the measured spend would cross the run ceiling, keeping the partial results", async () => {
    const budget = evalBudget({ db, runKey: `${tag}-actual`, runCeilingUsd: 1, monthlyCeilingUsd: 3, now: freshDay() });
    // Each replay costs $0.40 measured (the prior said $0.0005: the projection passed).
    const replayOnce = replayCosting(0.4);
    const plan = await runReplayPlan({ db, budget, scenarios: scenarios(5, "actual"), runs: 1, parallel: 1, model: `${tag}/actual`, fresh: false, replayOnce, log: () => {} });
    expect(plan.replayed).toBe(2);
    expect(plan.skipped).toBe(3);
    expect(plan.stopped).toBeInstanceOf(EvalSpendCeilingError);
    expect(plan.stopped!.scope).toBe("run");
    expect(plan.stopped!.message).toMatch(/spent \$0\.80/);
    expect(budget.spentCents()).toBeCloseTo(80, 6);
    expect([...plan.byScenario.values()].flat()).toHaveLength(2);
    const [{ cents }] = await client`SELECT SUM(spent_cents)::float AS cents FROM eval_spend WHERE run_key = ${`${tag}-actual`}`;
    expect(cents).toBeCloseTo(80, 6);
  });

  it("holds the fleet's monthly ceiling across two concurrent runs", async () => {
    const now = freshDay();
    // $0.001 a month for every eval run together; each replay reserves the prior ($0.0005) and costs it.
    const a = evalBudget({ db, runKey: `${tag}-fleet-a`, runCeilingUsd: 1, monthlyCeilingUsd: 0.001, now });
    const b = evalBudget({ db, runKey: `${tag}-fleet-b`, runCeilingUsd: 1, monthlyCeilingUsd: 0.001, now });
    const run = (budget: typeof a, name: string) =>
      runReplayPlan({ db, budget, scenarios: scenarios(4, name), runs: 1, parallel: 2, model: `${tag}/fleet`, fresh: false, replayOnce: replayCosting(0.0005, 30), log: () => {} });
    // Start each on one replay: together they fill the month exactly.
    const [pa, pb] = await Promise.all([
      runReplayPlan({ db, budget: a, scenarios: scenarios(1, "fleet-a"), runs: 1, parallel: 1, model: `${tag}/fleet`, fresh: false, replayOnce: replayCosting(0.0005, 30), log: () => {} }),
      runReplayPlan({ db, budget: b, scenarios: scenarios(1, "fleet-b"), runs: 1, parallel: 1, model: `${tag}/fleet`, fresh: false, replayOnce: replayCosting(0.0005, 30), log: () => {} }),
    ]);
    expect(pa.replayed + pb.replayed).toBe(2);
    // The month now holds $0.001: anything more from either run crosses it.
    const third = await run(a, "fleet-c").catch((e) => e);
    expect(third).toBeInstanceOf(EvalSpendCeilingError);
    expect(third.scope).toBe("month");

    // Truly concurrent reservations: 6 parallel replays from two runs in a fresh month, room for 2.
    const day2 = freshDay();
    const c = evalBudget({ db, runKey: `${tag}-fleet-c`, runCeilingUsd: 1, monthlyCeilingUsd: 0.01, now: day2 });
    const d = evalBudget({ db, runKey: `${tag}-fleet-d`, runCeilingUsd: 1, monthlyCeilingUsd: 0.01, now: day2 });
    const reserveMany = async (budget: typeof c) => {
      const got = await Promise.allSettled(Array.from({ length: 3 }, () => budget.reserve(0.004)));
      for (const g of got) if (g.status === "fulfilled") { g.value.add(0.4); await g.value.close(); }
      return got;
    };
    const [rc, rd] = await Promise.all([reserveMany(c), reserveMany(d)]);
    const all = [...rc, ...rd];
    expect(all.filter((g) => g.status === "fulfilled")).toHaveLength(2);
    for (const g of all.filter((x) => x.status === "rejected")) expect((g as PromiseRejectedResult).reason).toBeInstanceOf(EvalSpendCeilingError);
    const [{ cents }] = await client`SELECT SUM(spent_cents)::float AS cents FROM eval_spend WHERE run_key IN (${`${tag}-fleet-c`}, ${`${tag}-fleet-d`})`;
    expect(cents).toBeLessThanOrEqual(1);
  });

  it("reuses an unchanged replay at $0 and replays a failed one", async () => {
    const list = scenarios(2, "reuse");
    const first = replayCosting(0.004);
    const b1 = evalBudget({ db, runKey: `${tag}-reuse-1`, runCeilingUsd: 1, monthlyCeilingUsd: 3, now: freshDay() });
    const p1 = await runReplayPlan({ db, budget: b1, scenarios: list, runs: 1, parallel: 2, model: `${tag}/reuse`, fresh: false, replayOnce: first, log: () => {} });
    expect(p1.replayed).toBe(2);
    expect(b1.spentCents()).toBeCloseTo(0.8, 6);

    const second = replayCosting(0.004);
    const b2 = evalBudget({ db, runKey: `${tag}-reuse-2`, runCeilingUsd: 1, monthlyCeilingUsd: 3, now: freshDay() });
    const p2 = await runReplayPlan({ db, budget: b2, scenarios: list, runs: 1, parallel: 2, model: `${tag}/reuse`, fresh: false, replayOnce: second, log: () => {} });
    expect(second).not.toHaveBeenCalled();
    expect(p2.reused).toBe(2);
    expect(p2.replayed).toBe(0);
    expect(b2.spentCents()).toBe(0);
    for (const r of [...p2.byScenario.values()].flat()) expect(r).toMatchObject({ reused: true });

    // Asking 2 replays reuses the kept one and makes only the missing one.
    const third = replayCosting(0.004);
    const b3 = evalBudget({ db, runKey: `${tag}-reuse-3`, runCeilingUsd: 1, monthlyCeilingUsd: 3, now: freshDay() });
    const p3 = await runReplayPlan({ db, budget: b3, scenarios: list, runs: 2, parallel: 2, model: `${tag}/reuse`, fresh: false, replayOnce: third, log: () => {} });
    expect(p3.reused).toBe(2);
    expect(third).toHaveBeenCalledTimes(2);

    // A failed replay (vendor 500) is never kept: the next run replays it.
    const failing = scenarios(1, "reuse-failed");
    const b4 = evalBudget({ db, runKey: `${tag}-reuse-4`, runCeilingUsd: 1, monthlyCeilingUsd: 3, now: freshDay() });
    await runReplayPlan({ db, budget: b4, scenarios: failing, runs: 1, parallel: 1, model: `${tag}/reuse`, fresh: false, replayOnce: replayCosting(0, 0, true), log: () => {} });
    const again = replayCosting(0.004);
    const b5 = evalBudget({ db, runKey: `${tag}-reuse-5`, runCeilingUsd: 1, monthlyCeilingUsd: 3, now: freshDay() });
    const p5 = await runReplayPlan({ db, budget: b5, scenarios: failing, runs: 1, parallel: 1, model: `${tag}/reuse`, fresh: false, replayOnce: again, log: () => {} });
    expect(p5.reused).toBe(0);
    expect(again).toHaveBeenCalledTimes(1);
    // A failed replay settles at least at its reservation: its real spend is unknown.
    expect(b4.spentCents()).toBeGreaterThan(0);
  });

  it("--fresh replays even what is kept", async () => {
    const list = scenarios(1, "fresh");
    const b1 = evalBudget({ db, runKey: `${tag}-fresh-1`, runCeilingUsd: 1, monthlyCeilingUsd: 3, now: freshDay() });
    await runReplayPlan({ db, budget: b1, scenarios: list, runs: 1, parallel: 1, model: `${tag}/fresh`, fresh: false, replayOnce: replayCosting(0.004), log: () => {} });
    const again = replayCosting(0.004);
    const b2 = evalBudget({ db, runKey: `${tag}-fresh-2`, runCeilingUsd: 1, monthlyCeilingUsd: 3, now: freshDay() });
    const p = await runReplayPlan({ db, budget: b2, scenarios: list, runs: 1, parallel: 1, model: `${tag}/fresh`, fresh: true, replayOnce: again, log: () => {} });
    expect(p.reused).toBe(0);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("caps every eval run of a month together at $1 by default (the Jev judge's)", async () => {
    expect(EVAL_MONTHLY_CEILING_USD).toBe(1);
    const now = freshDay();
    // The month already holds $0.9998 of judgments.
    const filler = evalBudget({ db, runKey: `${tag}-cap-fill`, runCeilingUsd: 5, monthlyCeilingUsd: 5, now });
    const held = await filler.reserve(0.9998);
    held.add(99.98);
    await held.close();
    const b = evalBudget({ db, runKey: `${tag}-cap-1`, runCeilingUsd: 1, monthlyCeilingUsd: EVAL_MONTHLY_CEILING_USD, now });
    const replayOnce = replayCosting(0.0002);
    const err = await runReplayPlan({ db, budget: b, scenarios: scenarios(3, "cap"), runs: 1, parallel: 1, model: `${tag}/cap`, fresh: false, replayOnce, log: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(EvalSpendCeilingError);
    expect(err.scope).toBe("month");
    expect(err.message).toContain("ceiling $1.00 a month");
    expect(replayOnce).not.toHaveBeenCalled();
  });

  it("defaults to one replay per scenario and to naming the scenarios", () => {
    expect(evalRunsPerScenario(undefined)).toBe(1);
    expect(evalRunsPerScenario("3")).toBe(3);
    expect(() => evalRunsPerScenario("0")).toThrow(/--runs/);
    expect(() => requireScenarioSelection(undefined, false)).toThrow(/--only/);
    expect(() => requireScenarioSelection(["a"], false)).not.toThrow();
    expect(() => requireScenarioSelection(undefined, true)).not.toThrow();
  });
});
