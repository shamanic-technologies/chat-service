// ---------------------------------------------------------------------------
// Eval runner (SOPHIE-REFONTE-1102). Runs INSIDE the chat-service container on
// the box: it reads the platform keys from key-service and declares every cent
// it spends on a platform run marked `staff_experiment` (runs-service), like
// any other spend of ours. No client org is read or written.
//
//   node dist/evals/run.js --definition evals/definitions/<id>.json \
//     [--scenarios evals/scenarios] [--only id1,id2] [--runs 3] \
//     [--provider deepseek --model deepseek-flash] [--parallel 4] [--calibrate] [--out file]
//
// --calibrate judges the recorded replies only (no model call): every known-bad
// production reply must FAIL and every hand-written good reply must PASS, or the
// judge is not trusted and the run exits 1.
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { sophieCodeHash } from "../agent/sophie.js";
import { resolvePlatformKey } from "../lib/key-client.js";
import { judgeActualCostName, runJudge } from "../lib/judges.js";
import { addPlatformRunCosts, createPlatformRun, updatePlatformRunStatus, type RunCost } from "../lib/runs-client.js";
import { TYPESAFE_DEFAULT_MODEL, TYPESAFE_PROVIDER } from "../lib/typesafe.js";
import { definitionHash, loadDefinition, replayTurn, sophieDefinition, type AgentDefinition } from "./agent-turn.js";
import { fixtureExecutor } from "./fixture-tools.js";
import { CRITERIA, QUESTIONS, describeAction, judgeState, verdictFrom, type Criterion, type Verdict } from "./judge.js";
import { loadScenarios, type Scenario } from "./scenario.js";
import { summarise, type ScenarioResult, type ReplayResult } from "./report.js";

const SERVICE = "chat-service";
const SUPPORT = { kind: "staff_experiment" as const, reason: "Sophie eval replay (SOPHIE-REFONTE-1102): replays a recorded conversation on fixtures, no client reached" };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cents = (costs: RunCost[]) => costs.reduce((s, c) => s + Number(c.totalCostInUsdCents), 0);

async function judge(runId: string, typesafeKey: string, scenario: Scenario, reply: string, actions: readonly string[], contextGiven = ""): Promise<{ verdict: Verdict; cents: number }> {
  const result = await runJudge({ judge: "jev", apiKey: typesafeKey, model: TYPESAFE_DEFAULT_MODEL, state: judgeState(scenario, reply, actions, contextGiven), questions: QUESTIONS });
  const costs = await addPlatformRunCosts(runId, SERVICE, [
    { costName: judgeActualCostName("jev", result.inputTokens), quantity: result.inputTokens, costSource: "platform" },
  ]);
  return { verdict: verdictFrom(result.answers as never), cents: cents(costs) };
}

async function withRun<T>(task: string, fn: (runId: string) => Promise<T>): Promise<T> {
  const run = await createPlatformRun({ serviceName: SERVICE, taskName: task, support: SUPPORT });
  let failed = false;
  try {
    return await fn(run.id);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await updatePlatformRunStatus(run.id, SERVICE, failed ? "failed" : "completed");
  }
}

async function calibrate(scenarios: Scenario[], typesafeKey: string) {
  const rows: Array<{ id: string; which: "prod-bad" | "good"; expected: "fail" | "pass"; got: "fail" | "pass"; failed: Criterion[] }> = [];
  for (const s of scenarios) {
    const cases: Array<["prod-bad" | "good", string | undefined, string[], "fail" | "pass"]> = [
      ["prod-bad", s.badReplyFails ? s.prodReply : undefined, s.prodReplyActions ?? [], "fail"],
      ["good", s.goodReply, s.goodReplyActions ?? [], "pass"],
    ];
    for (const [which, reply, actions, expected] of cases) {
      if (!reply) continue;
      const { verdict } = await withRun("sophie-eval-calibrate", (runId) => judge(runId, typesafeKey, s, reply, actions));
      const got = verdict.pass ? "pass" : "fail";
      rows.push({ id: s.id, which, expected, got, failed: CRITERIA.filter((c) => !verdict.passed[c]) });
      console.log(`[evals] calibrate ${s.id} ${which}: expected ${expected}, got ${got}${got === "fail" ? ` (${rows[rows.length - 1].failed.join(", ")})` : ""}`);
    }
  }
  const agree = rows.filter((r) => r.expected === r.got).length;
  return { cases: rows.length, agree, passed: rows.length > 0 && agree === rows.length, rows };
}

async function replay(def: AgentDefinition, scenarios: Scenario[], provider: string, model: string, runs: number, parallel: number, typesafeKey: string) {
  const { key: modelKey } = await resolvePlatformKey(provider, { method: "POST", path: "/evals" });
  const results: ScenarioResult[] = [];
  const queue = [...scenarios];
  const worker = async () => {
    for (let scenario = queue.shift(); scenario; scenario = queue.shift()) await replayScenario(scenario);
  };
  const replayScenario = async (scenario: Scenario) => {
    const replays: ReplayResult[] = [];
    for (let i = 0; i < runs; i++) {
      const r = await withRun("sophie-eval-replay", async (runId) => {
        const fixtures = fixtureExecutor(def, scenario);
        const turn = await replayTurn({ def, scenario, provider, model, apiKey: modelKey, executeTool: fixtures.executeTool, uiText: fixtures.uiText });
        const modelCosts = await addPlatformRunCosts(runId, SERVICE, turn.costLines.map((l) => ({ costName: l.costName, quantity: l.quantity, costSource: "platform" as const })));
        const actions = turn.toolCalls.map((c) => describeAction(c.name, c.args, c.result));
        const judged = await judge(runId, typesafeKey, scenario, turn.reply, actions, turn.turnContext);
        return {
          reply: turn.reply,
          tools: turn.toolCalls.map((c) => c.name),
          actions,
          turnContext: turn.turnContext,
          missingFixtures: fixtures.missing(),
          llmCalls: turn.llmCalls,
          tokensInput: turn.tokensInput,
          tokensOutput: turn.tokensOutput,
          replyCostUsd: cents(modelCosts) / 100,
          judgeCostUsd: judged.cents / 100,
          latencyMs: turn.latencyMs,
          verdict: judged.verdict,
        };
      });
      replays.push(r);
      const failed = CRITERIA.filter((c) => !r.verdict.passed[c]);
      console.log(`[evals] ${scenario.id} run ${i + 1}/${runs}: ${r.verdict.pass ? "PASS" : `FAIL (${failed.join(", ")})`} $${r.replyCostUsd.toFixed(4)} ${r.llmCalls} calls ${Math.round(r.latencyMs / 1000)}s`);
    }
    results.push({ id: scenario.id, surface: scenario.surface, replays });
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

/** Sophie from the code, with the skills table as production serves it. */
async function codeDefinition(candidate: "current" | "p2" = "current"): Promise<AgentDefinition> {
  const { db } = await import("../db/index.js");
  const { listSkills } = await import("../lib/skills.js");
  const { SEED_SKILLS } = await import("../lib/skill-seed.js");
  // --seed-skills a,b: those skills as this code seeds them, over the live table (a skill rewrite measured before it ships).
  const fromSeed = new Set((arg("seed-skills") ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  const rows = (await listSkills(db)).map((r) => ({ slug: r.slug, parentSlug: r.parentSlug, title: r.title, description: r.description, content: r.content }));
  const merged = rows.map((r) => {
    const seed = fromSeed.has(r.slug) ? SEED_SKILLS.find((x) => x.slug === r.slug) : undefined;
    return seed ? { slug: seed.slug, parentSlug: seed.parentSlug, title: seed.title, description: seed.description, content: seed.content } : r;
  });
  return sophieDefinition(merged, candidate);
}

async function main() {
  const definitionPath = arg("definition");
  if (!definitionPath) throw new Error("--definition <file> is required");
  const def =
    definitionPath === "code" ? await codeDefinition() : definitionPath === "code-p2" ? await codeDefinition("p2") : loadDefinition(definitionPath);
  const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const scenarios = loadScenarios(arg("scenarios") ?? "evals/scenarios").filter((s) => !only || only.includes(s.id));
  if (scenarios.length === 0) throw new Error("[evals] no scenario selected");
  const provider = arg("provider") ?? def.provider;
  const model = arg("model") ?? def.model;
  const runs = Number(arg("runs") ?? "3");
  const out = arg("out");
  const { key: typesafeKey } = await resolvePlatformKey(TYPESAFE_PROVIDER, { method: "POST", path: "/evals" });

  if (process.argv.includes("--calibrate")) {
    const calibration = await calibrate(scenarios, typesafeKey);
    const body = { kind: "calibration", at: new Date().toISOString(), judge: `jev/${TYPESAFE_DEFAULT_MODEL}`, ...calibration };
    if (out) writeFileSync(out, JSON.stringify(body, null, 2));
    console.log(`[evals] calibration: ${calibration.agree}/${calibration.cases} agree → ${calibration.passed ? "TRUSTED" : "NOT TRUSTED"}`);
    process.exitCode = calibration.passed ? 0 : 1;
    return;
  }

  const results = await replay(def, scenarios, provider, model, runs, Number(arg("parallel") ?? "4"), typesafeKey);
  const summary = summarise(results);
  const body = {
    kind: "replay",
    at: new Date().toISOString(),
    definition: def.id,
    ...(def.id.startsWith("sophie-code") ? { codeHash: sophieCodeHash(), definitionSnapshot: def } : {}),
    definitionHash: definitionHash(def, `${provider}/${model}`),
    model: `${provider}/${model}`,
    judge: `jev/${TYPESAFE_DEFAULT_MODEL}`,
    runsPerScenario: runs,
    summary,
    scenarios: results,
  };
  if (out) writeFileSync(out, JSON.stringify(body, null, 2));
  console.log(`[evals] ${JSON.stringify(summary)}`);
}

main().catch((err) => {
  console.error("[evals] run failed:", err);
  process.exit(1);
});
