// ---------------------------------------------------------------------------
// Eval scoring (SOPHIE-REFONTE-1102). A scenario PASSES when a majority of its
// replays pass every criterion (models are not deterministic). A suite passes
// when every scenario passes, "true" holds on every replay (an invented fact is
// never averaged away) and the median cost per reply is under the target.
// ---------------------------------------------------------------------------

import { CRITERIA, type Criterion, type Verdict } from "./judge.js";

/** Owner target 2026-11-02: under 3 cents per reply. */
export const COST_PER_REPLY_TARGET_USD = 0.03;

export interface ReplayResult {
  reply: string;
  tools: string[];
  missingFixtures: string[];
  llmCalls: number;
  tokensInput: number;
  tokensOutput: number;
  replyCostUsd: number;
  judgeCostUsd: number;
  latencyMs: number;
  verdict: Verdict;
}

export interface ScenarioResult {
  id: string;
  surface: string;
  replays: ReplayResult[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function scenarioPasses(r: ScenarioResult): boolean {
  const passing = r.replays.filter((x) => x.verdict.pass).length;
  return passing * 2 > r.replays.length;
}

export function summarise(results: ScenarioResult[]) {
  const replays = results.flatMap((r) => r.replays);
  const criterionRate = Object.fromEntries(
    CRITERIA.map((c) => [c, replays.length ? replays.filter((x) => x.verdict.passed[c]).length / replays.length : 0]),
  ) as Record<Criterion, number>;
  const scenariosPassed = results.filter(scenarioPasses).length;
  const medianCost = median(replays.map((x) => x.replyCostUsd));
  const alwaysTrue = replays.every((x) => x.verdict.passed.true);
  return {
    scenarios: results.length,
    scenariosPassed,
    replays: replays.length,
    criterionRate,
    medianCostPerReplyUsd: Number(medianCost.toFixed(5)),
    medianLlmCalls: median(replays.map((x) => x.llmCalls)),
    medianInputTokens: median(replays.map((x) => x.tokensInput)),
    medianLatencyMs: median(replays.map((x) => x.latencyMs)),
    passed: results.length > 0 && scenariosPassed === results.length && alwaysTrue && medianCost < COST_PER_REPLY_TARGET_USD,
  };
}

export type Summary = ReturnType<typeof summarise>;
