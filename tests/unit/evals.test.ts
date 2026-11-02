import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleTurn, definitionHash, loadDefinition } from "../../src/evals/agent-turn.js";
import { fixtureExecutor } from "../../src/evals/fixture-tools.js";
import { CRITERIA, verdictFrom } from "../../src/evals/judge.js";
import { COST_PER_REPLY_TARGET_USD, summarise, type ReplayResult } from "../../src/evals/report.js";
import { loadScenarios, type Scenario } from "../../src/evals/scenario.js";
import { readSkillFrom, skillIndexBlockFrom } from "../../src/lib/skills.js";
import { sophieCodeHash } from "../../src/agent/sophie.js";

const ROOT = join(__dirname, "../..");
const SCENARIOS_DIR = join(ROOT, "evals/scenarios");
const BASELINE_DEFINITION = join(ROOT, "evals/definitions/prod-2026-11-02.json");

const scenarios = loadScenarios(SCENARIOS_DIR);
const def = loadDefinition(BASELINE_DEFINITION);

function verdict(p: Partial<Record<(typeof CRITERIA)[number], number>> = {}) {
  return verdictFrom(Object.fromEntries(CRITERIA.map((c) => [c, { type: "noul", noul: p[c] ?? 0.9 }])));
}

function replay(over: Partial<ReplayResult> = {}): ReplayResult {
  return {
    reply: "ok",
    tools: [],
    missingFixtures: [],
    llmCalls: 1,
    tokensInput: 1000,
    tokensOutput: 100,
    replyCostUsd: 0.01,
    judgeCostUsd: 0.001,
    latencyMs: 1000,
    verdict: verdict(),
    ...over,
  };
}

describe("eval scenarios", () => {
  it("every scenario file is valid and named after its id", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(20);
  });

  it("cover the web and WhatsApp surfaces", () => {
    expect(new Set(scenarios.map((s) => s.surface))).toEqual(new Set(["web", "whatsapp", "lead"]));
    for (const s of scenarios.filter((x) => x.surface === "lead")) expect(s.lead, s.id).toBeDefined();
  });

  it("never carry a client's email address (anonymised)", () => {
    for (const f of readdirSync(SCENARIOS_DIR)) {
      const text = readFileSync(join(SCENARIOS_DIR, f), "utf8");
      const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      const foreign = emails.filter((e) => !/@(example\.com|distribute\.you)$/i.test(e));
      expect(foreign, f).toEqual([]);
    }
  });

  it("each known-bad production reply is kept for calibration", () => {
    for (const s of scenarios.filter((x) => x.badReplyFails)) expect(s.prodReply, s.id).toBeTruthy();
  });
});

describe("assembleTurn (same builders as /chat)", () => {
  const web = scenarios.find((s) => s.surface === "web")!;
  const wa = scenarios.find((s) => s.surface === "whatsapp")!;

  it("puts the config prompt, the skill index and the identity line in the stable prompt", () => {
    const turn = assembleTurn(def, web, "DeepSeek V4.1 Flash");
    expect(turn.systemPrompt.startsWith(def.systemPrompt)).toBe(true);
    expect(turn.systemPrompt).toContain(skillIndexBlockFrom(def.skills));
    expect(turn.systemPrompt).toContain("DeepSeek V4.1 Flash");
  });

  it("adds the WhatsApp channel block on WhatsApp only", () => {
    expect(assembleTurn(def, wa, "m").turnContext).toContain("## Channel: WhatsApp");
    expect(assembleTurn(def, web, "m").turnContext).not.toContain("## Channel: WhatsApp");
  });

  it("offers the config's tools plus the ones /chat adds (our site, account setup)", () => {
    const names = assembleTurn(def, web, "m").tools.map((t) => t.name);
    expect(names).toContain("read_our_website");
    expect(names).toContain("create_brand_from_url");
    expect(names).toContain("present_choices");
  });
});

describe("fixtureExecutor", () => {
  const s: Scenario = {
    id: "x",
    title: "x",
    source: "x",
    surface: "web",
    person: { name: "A" },
    history: [],
    message: "hi",
    fixtures: { list_campaigns: [{ n: 1 }, { n: 2 }] },
    facts: ["f"],
    expect: "e",
  };

  it("answers recorded results in order, the last one repeating", async () => {
    const ex = fixtureExecutor(def, s);
    const call = () => ex.executeTool({ name: "list_campaigns", args: {} });
    expect(await call()).toEqual({ name: "list_campaigns", result: { n: 1 } });
    expect(await call()).toEqual({ name: "list_campaigns", result: { n: 2 } });
    expect(await call()).toEqual({ name: "list_campaigns", result: { n: 2 } });
  });

  it("answers a tool with no recording with an error and lists it", async () => {
    const ex = fixtureExecutor(def, s);
    const r = await ex.executeTool({ name: "get_billing_account", args: {} });
    expect(r).toMatchObject({ result: { error: expect.stringContaining("get_billing_account") } });
    expect(ex.missing()).toEqual(["get_billing_account"]);
  });

  it("answers read_skill from the definition under test", async () => {
    const ex = fixtureExecutor(def, s);
    const r = await ex.executeTool({ name: "read_skill", args: { slug: "campaigns" } });
    expect(r).toEqual({ name: "read_skill", result: readSkillFrom(def.skills, "campaigns") });
  });

  it("ends the turn on present_choices and keeps what the person sees", async () => {
    const ex = fixtureExecutor(def, s);
    const r = await ex.executeTool({
      name: "present_choices",
      args: { text: "Two options.", choices: [{ label: "Yes, start it" }, { label: "Not now" }] },
    });
    expect(r).toBe("input_request");
    expect(ex.uiText()).toBe("Two options.\n1. Yes, start it\n2. Not now");
  });
});

describe("judge verdict and suite summary", () => {
  it("a criterion passes at a probability of yes >= 0.5, a reply passes when all do", () => {
    expect(verdict().pass).toBe(true);
    const v = verdict({ proactive: 0.49 });
    expect(v.pass).toBe(false);
    expect(v.passed.proactive).toBe(false);
  });

  it("throws when the judge omits a criterion", () => {
    expect(() => verdictFrom({ true: { type: "noul", noul: 1 } })).toThrow(/respectful/);
  });

  it("a scenario passes on a majority of its replays; an untrue reply fails the suite", () => {
    const ok = summarise([{ id: "a", surface: "web", replays: [replay(), replay(), replay({ verdict: verdict({ form: 0.1 }) })] }]);
    expect(ok.scenariosPassed).toBe(1);
    expect(ok.passed).toBe(true);
    const lie = summarise([{ id: "a", surface: "web", replays: [replay(), replay(), replay({ verdict: verdict({ true: 0.1 }) })] }]);
    expect(lie.scenariosPassed).toBe(1);
    expect(lie.passed).toBe(false);
  });

  it("fails the suite when the median reply costs the target or more", () => {
    const dear = summarise([{ id: "a", surface: "web", replays: [replay({ replyCostUsd: COST_PER_REPLY_TARGET_USD })] }]);
    expect(dear.passed).toBe(false);
  });
});

describe("definitionHash", () => {
  it("changes with the prompt or the model, not with the label", () => {
    const base = definitionHash(def);
    expect(definitionHash({ ...def, note: "other", id: "other" })).toBe(base);
    expect(definitionHash({ ...def, systemPrompt: def.systemPrompt + "." })).not.toBe(base);
    expect(definitionHash(def, "deepseek/other")).not.toBe(base);
  });
});

describe("the judge is calibrated (merge gate)", () => {
  it("evals/calibration.json: every known-bad production reply failed, every good reply passed", () => {
    const path = join(ROOT, "evals/calibration.json");
    expect(existsSync(path)).toBe(true);
    const c = JSON.parse(readFileSync(path, "utf8")) as { passed: boolean; cases: number; agree: number };
    expect(c.cases).toBeGreaterThanOrEqual(20);
    expect(c.agree).toBe(c.cases);
    expect(c.passed).toBe(true);
  });
});

describe("Sophie changes only with a fresh eval run (merge gate)", () => {
  it("evals/last-run.json was run on the code as it is now, and passes at least as many replies as the baseline (pooled)", () => {
    const run = JSON.parse(readFileSync(join(ROOT, "evals/last-run.json"), "utf8")) as {
      codeHash: string;
      pooled: { replays: number; passRate: number };
      baseline: { pooled: { replays: number; passRate: number } };
    };
    expect(run.codeHash, "Sophie's prompt, tools, model or briefs changed: run evals/ and record the run in evals/last-run.json").toBe(sophieCodeHash());
    // One 60-replay run swings by about two scenarios: the gate pools at least 3 replies per scenario, 100+ a side.
    expect(run.pooled.replays).toBeGreaterThanOrEqual(100);
    expect(run.baseline.pooled.replays).toBeGreaterThanOrEqual(100);
    expect(run.pooled.passRate).toBeGreaterThanOrEqual(run.baseline.pooled.passRate);
  });
});
