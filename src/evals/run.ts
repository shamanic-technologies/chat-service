// ---------------------------------------------------------------------------
// Eval runner (SOPHIE-REFONTE-1102). Runs INSIDE the chat-service container on
// the box: it reads the platform keys from key-service and declares every cent
// it spends on a platform run marked `staff_experiment` (runs-service), like
// any other spend of ours. No client org is read or written.
//
//   node dist/evals/run.js --definition evals/definitions/<id>.json \
//     [--scenarios evals/scenarios] [--only id1,id2] [--runs 3] \
//     [--provider deepseek --model deepseek-flash] [--parallel 4] [--calibrate] [--out file]
//     [--no-brand-tools]   (lead turns as before BRAND-MCP-1109: the brand's own tools withheld)
//
// --calibrate judges the recorded replies only (no model call): every known-bad
// production reply must FAIL and every hand-written good reply must PASS, or the
// judge is not trusted and the run exits 1.
//
// --rejudge <run.json> --labels <labels.json> grades the replies a past run
// stored (reply, actions, turn context) with the judge as this code defines it,
// and reports its agreement with hand-checked labels: the judge measured alone,
// without the agent's own variance.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs";
import { sophieCodeHash } from "../agent/sophie.js";
import { resolvePlatformKey } from "../lib/key-client.js";
import { JUDGES, JUDGE_PROVIDERS, judgeActualCostName, runJudge, type Judge } from "../lib/judges.js";
import { addPlatformRunCosts, createPlatformRun, updatePlatformRunStatus, type RunCost } from "../lib/runs-client.js";
import { TYPESAFE_DEFAULT_MODEL, TYPESAFE_PROVIDER } from "../lib/typesafe.js";
import { definitionHash, loadDefinition, replayTurn, sophieDefinition, type AgentDefinition } from "./agent-turn.js";
import { fixtureExecutor } from "./fixture-tools.js";
import { CRITERIA, QUESTIONS, describeAction, judgeState, verdictFrom, type Criterion, type Verdict } from "./judge.js";
import { LabelFileSchema, trueAgreement, type JudgedRow } from "./labels.js";
import { loadScenarios, type Scenario } from "./scenario.js";
import { summarise, type ScenarioResult, type ReplayResult } from "./report.js";

const SERVICE = "chat-service";
const SUPPORT = { kind: "staff_experiment" as const, reason: "Sophie eval replay (SOPHIE-REFONTE-1102): replays a recorded conversation on fixtures, no client reached" };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cents = (costs: RunCost[]) => costs.reduce((s, c) => s + Number(c.totalCostInUsdCents), 0);

/** --judge <id>: which judge grades (Jev unless stated; the others are benchmarked with --rejudge). */
const JUDGE: Judge = (() => {
  const j = arg("judge") ?? "jev";
  if (!(JUDGES as readonly string[]).includes(j)) throw new Error(`[evals] --judge must be one of ${JUDGES.join(", ")}`);
  return j as Judge;
})();

async function judge(runId: string, judgeKey: string, scenario: Scenario, reply: string, actions: readonly string[], contextGiven = ""): Promise<{ verdict: Verdict; cents: number }> {
  const result = await runJudge({ judge: JUDGE, apiKey: judgeKey, model: TYPESAFE_DEFAULT_MODEL, state: judgeState(scenario, reply, actions, contextGiven), questions: QUESTIONS });
  const costs = await retryRefused("judge costs", () => addPlatformRunCosts(runId, SERVICE, [
    { costName: judgeActualCostName(JUDGE, result.inputTokens), quantity: result.inputTokens, costSource: "platform" },
  ]));
  return { verdict: verdictFrom(result.answers as never), cents: cents(costs) };
}

/**
 * A sibling service redeploying refuses connections for a minute (prod
 * 2026-11-02: runs-service mid-run killed a 60-replay eval at 52). Retry a
 * refused connection only: an answer of any kind is final.
 */
async function retryRefused<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      if (attempt >= 8 || (code !== "ECONNREFUSED" && code !== "ECONNRESET")) throw err;
      console.warn(`[evals] ${label}: ${code}, retrying in 15s (${attempt}/8)`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

async function withRun<T>(task: string, fn: (runId: string) => Promise<T>): Promise<T> {
  const run = await retryRefused("create run", () => createPlatformRun({ serviceName: SERVICE, taskName: task, support: SUPPORT }));
  let failed = false;
  try {
    return await fn(run.id);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await retryRefused("close run", () => updatePlatformRunStatus(run.id, SERVICE, failed ? "failed" : "completed"));
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
       try {
        const fixtures = fixtureExecutor(def, scenario);
        const turn = await replayTurn({ def, scenario, provider, model, apiKey: modelKey, executeTool: fixtures.executeTool, uiText: fixtures.uiText, brandTools: !process.argv.includes("--no-brand-tools"), ...(arg("api-model") ? { rawModel: { apiModelId: arg("api-model")!, costPrefix: arg("cost-prefix") ?? arg("api-model")! } } : {}), ...(process.argv.includes("--reasoning-off") ? { reasoningDisabled: true } : process.argv.includes("--reasoning-on") ? { reasoningDisabled: false } : {}) });
        const modelCosts = await retryRefused("reply costs", () => addPlatformRunCosts(runId, SERVICE, turn.costLines.map((l) => ({ costName: l.costName, quantity: l.quantity, costSource: "platform" as const }))));
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
       } catch (err) {
        // One failed reply (a vendor 500, a dropped connection) is a reply the
        // person never got: it counts as failing every criterion, the run goes on.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[evals] ${scenario.id}: the reply failed: ${message.slice(0, 300)}`);
        return {
          reply: "",
          error: message.slice(0, 1000),
          tools: [],
          missingFixtures: [],
          llmCalls: 0,
          tokensInput: 0,
          tokensOutput: 0,
          replyCostUsd: 0,
          judgeCostUsd: 0,
          latencyMs: 0,
          verdict: { probabilities: Object.fromEntries(CRITERIA.map((c) => [c, 0])), passed: Object.fromEntries(CRITERIA.map((c) => [c, false])), pass: false } as Verdict,
        };
       }
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

interface StoredRun {
  at: string;
  scenarios: Array<{ id: string; replays: Array<{ reply: string; actions?: string[]; turnContext?: string; error?: string }> }>;
}

async function rejudge(runPath: string, labelsPath: string, scenarios: Scenario[], typesafeKey: string, parallel: number) {
  const stored = JSON.parse(readFileSync(runPath, "utf8")) as StoredRun;
  const labelFile = LabelFileSchema.parse(JSON.parse(readFileSync(labelsPath, "utf8")));
  if (labelFile.run !== stored.at) throw new Error(`[evals] labels were checked on run ${labelFile.run}, not ${stored.at}`);
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const queue = stored.scenarios.flatMap((sc) =>
    sc.replays.map((r, replay) => ({ sc, r, replay })).filter((x) => !x.r.error && x.r.reply && byId.has(x.sc.id)),
  );
  const rows: Array<JudgedRow & { pTrue: number; pass: boolean }> = [];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { sc, r, replay } = item;
      const { verdict } = await withRun("sophie-eval-rejudge", (runId) => judge(runId, typesafeKey, byId.get(sc.id)!, r.reply, r.actions ?? [], r.turnContext ?? ""));
      rows.push({ scenario: sc.id, replay, judgedTrue: verdict.passed.true, pTrue: verdict.probabilities.true, pass: verdict.pass });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  rows.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.replay - b.replay);
  return { kind: "rejudge", at: new Date().toISOString(), run: stored.at, judge: JUDGE === "jev" ? `jev/${TYPESAFE_DEFAULT_MODEL}` : JUDGE, agreement: trueAgreement(rows, labelFile.labels), rows };
}

/** Sophie from the code, with the skills table as production serves it. */
async function codeDefinition(): Promise<AgentDefinition> {
  const { db } = await import("../db/index.js");
  const { listSkills } = await import("../lib/skills.js");
  const { SEED_SKILLS } = await import("../lib/skill-seed.js");
  // --seed-skills a,b: those skills as this code seeds them, over the live table (a skill rewrite measured before it ships).
  const fromSeed = new Set((arg("seed-skills") ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  const rows = (await listSkills(db)).map((r) => ({ slug: r.slug, parentSlug: r.parentSlug, title: r.title, description: r.description, content: r.content }));
  // --seed-skills all: the whole tree as this code seeds it (what production reads once it ships).
  if (fromSeed.has("all")) {
    return sophieDefinition(SEED_SKILLS.map((x) => ({ slug: x.slug, parentSlug: x.parentSlug, title: x.title, description: x.description, content: x.content })));
  }
  const merged = rows.map((r) => {
    const seed = fromSeed.has(r.slug) ? SEED_SKILLS.find((x) => x.slug === r.slug) : undefined;
    return seed ? { slug: seed.slug, parentSlug: seed.parentSlug, title: seed.title, description: seed.description, content: seed.content } : r;
  });
  return sophieDefinition(merged);
}

async function main() {
  const definitionPath = arg("definition") ?? (arg("rejudge") ? "code" : undefined);
  if (!definitionPath) throw new Error("--definition <file> is required");
  const loaded = definitionPath === "code" ? await codeDefinition() : loadDefinition(definitionPath);
  // A file definition with no skills of its own (an outside AI) reads the tree as this code seeds it.
  const def =
    loaded.skills.length === 0
      ? { ...loaded, skills: (await import("../lib/skill-seed.js")).SEED_SKILLS.map((x) => ({ slug: x.slug, parentSlug: x.parentSlug, title: x.title, description: x.description, content: x.content })) }
      : loaded;
  const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const scenarios = loadScenarios(arg("scenarios") ?? "evals/scenarios").filter((s) => !only || only.includes(s.id));
  if (scenarios.length === 0) throw new Error("[evals] no scenario selected");
  const provider = arg("provider") ?? def.provider;
  const model = arg("model") ?? def.model;
  const runs = Number(arg("runs") ?? "3");
  const out = arg("out");
  const { key: typesafeKey } = await resolvePlatformKey(JUDGE_PROVIDERS[JUDGE], { method: "POST", path: "/evals" });

  const rejudgePath = arg("rejudge");
  if (rejudgePath) {
    const labelsPath = arg("labels");
    if (!labelsPath) throw new Error("--rejudge needs --labels <file>");
    const report = await rejudge(rejudgePath, labelsPath, scenarios, typesafeKey, Number(arg("parallel") ?? "5"));
    if (out) writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`[evals] rejudge: true agrees with the labels on ${report.agreement.agree}/${report.agreement.labelled} (${Math.round(report.agreement.rate * 100)}%), ${report.agreement.falseAlarms.length} false alarms, ${report.agreement.missed.length} missed`);
    return;
  }

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
    ...(process.argv.includes("--no-brand-tools") ? { brandTools: "withheld" } : {}),
    model: `${provider}/${model}${process.argv.includes("--reasoning-off") || (!process.argv.includes("--reasoning-on") && def.reasoning === "off") ? " (reasoning off)" : ""}`,
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
