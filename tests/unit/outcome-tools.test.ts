import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  askEngine,
  buildRead,
  createProviderIndex,
  findOutcome,
  getUnits,
  pickProviderRead,
  providerOperationsOf,
  resolveAskProposal,
  ASK_ENGINE_TOOL_NAME,
  OUTCOME_TOOL_NAMES,
  type EngineListing,
  type OutcomeDeps,
} from "../../src/agent/outcome-tools.js";
import { isProactiveReadTool } from "../../src/lib/copilot-proactive.js";
import { SOPHIE_TOOLS } from "../../src/agent/sophie.js";
import { TOOL_REGISTRY } from "../../src/lib/anthropic.js";
import { isPrincipalToolName } from "../../src/agent/principal-tools.js";
import { withOutcomeToolsForEngines } from "../../src/agent/distry-config.js";

const ORG = "06ffd332-b05d-4468-bc33-fe2789caad95";
const who = { orgId: ORG, userId: "user-1", runId: "turn-run" };

const specs = new Map<string, Record<string, unknown>>([
  [
    "instantly",
    {
      paths: {
        "/orgs/units/email-sent": {
          get: {
            operationId: "listEmailSentUnits",
            tags: ["provider:email_sent"],
            summary: "Units of email_sent",
            description: "Scope: every brand of the CALLING org.",
            parameters: [
              { name: "emails", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated addresses" },
              { name: "x-org-id", in: "header", required: true, schema: { type: "string" } },
            ],
          },
        },
        "/orgs/units/email-queued": { get: { operationId: "listEmailQueuedUnits", tags: ["provider:email_queued"] } },
        "/internal/admin/wipe": { post: { operationId: "wipe", tags: ["Admin"] } },
      },
    },
  ],
  ["apollo", { paths: { "/email-verifications/units": { get: { operationId: "listEmailFoundUnits", tags: ["provider:email_found"] } }, "/x/{id}": { post: { operationId: "readX", tags: ["provider:email_found"] } } } }],
]);

const engines: EngineListing[] = [
  { outcome: "email_checked", name: "Email checked", callable: true, reason: null, inputs: [{ units: [], channel: null }], counts: { scripts: 1, live: 1, runnable: 1 }, ask: { possible: true, needsNothing: true, reason: null }, scripts: [{ dynasty: "dy_email_check", name: "Email address check", units: [], requestFields: ["email"], requestHandedOn: false }] },
  { outcome: "backlink_earned", name: "Backlink earned", callable: false, reason: "No script can run now.", inputs: [], counts: { scripts: 0, live: 0, runnable: 0 }, ask: { possible: false, needsNothing: false, reason: "No script can run now." } },
];

type Seen = { kind: string; [k: string]: unknown };
function fakes(over: Partial<OutcomeDeps> = {}): { deps: OutcomeDeps; seen: Seen[] } {
  const seen: Seen[] = [];
  const deps: OutcomeDeps = {
    listServices: async () => ["instantly", "apollo", "broken"],
    fetchSpec: async (s) => specs.get(s) ?? null,
    callService: async (service, req) => {
      seen.push({ kind: "call", service, ...req });
      return { status: 200, ok: true, data: { units: [{ at: "2026-10-30T10:00:00Z", kind: "first" }], nextCursor: null } };
    },
    listEngines: async (orgId) => {
      seen.push({ kind: "engines", orgId });
      return engines;
    },
    engineScripts: async (outcome) =>
      outcome === "email_checked" ? [{ dynasty: "dy_email_check", name: "Email address check", description: "Checks one email address (request.email).", materials: [], runnable: true }] : [],
    makeUnit: async (outcome, body, headers) => {
      seen.push({ kind: "make", outcome, body, headers });
      return { status: 200, data: { status: "made", unit: { outcome: "email_checked", subject: { service: "runs-service", id: "ask-run" }, content: { verdict: "valid" } }, error: null, runId: "script-run", pick: { dynasty: "bounceban", version: 3 } } };
    },
    openAskRun: async (identity) => {
      seen.push({ kind: "run", ...identity });
      return "ask-run";
    },
    ...over,
  };
  return { deps, seen };
}

describe("the Provider reads are discovered by tag, never listed in code (ENGINE-GET-ASK-1123)", () => {
  it("indexes every `provider:<outcome>` operation, nothing else", () => {
    const idx = providerOperationsOf(specs);
    expect([...idx.keys()].sort()).toEqual(["email_found", "email_queued", "email_sent"]);
    expect(idx.get("email_found")!.map((o) => o.operationId)).toEqual(["listEmailFoundUnits", "readX"]);
    expect([...idx.values()].flat().some((o) => o.path.includes("/internal/admin"))).toBe(false);
  });

  it("a service whose doc cannot be read is named, and the index is re-read sooner", async () => {
    let t = 0;
    let walks = 0;
    const index = createProviderIndex({ listServices: async () => (walks++, ["instantly", "broken"]), fetchSpec: async (s) => specs.get(s) ?? null, now: () => t });
    expect((await index()).unread).toEqual(["broken"]);
    t = 30_000;
    await index();
    expect(walks).toBe(1);
    t = 61_000;
    await index();
    expect(walks).toBe(2);
  });
});

describe("find_outcome reads the doc, spends nothing", () => {
  it("without an outcome: every outcome known, from the Engines and the tags, with the org's Engine list", async () => {
    const { deps, seen } = fakes();
    const out = (await findOutcome({}, { orgId: ORG }, deps, createProviderIndex(deps))) as { outcomes: Array<{ outcome: string; reads: number; engineCanMake: boolean }>; notRead: string };
    expect(out.outcomes.map((o) => o.outcome)).toEqual(["backlink_earned", "email_checked", "email_found", "email_queued", "email_sent"]);
    expect(out.outcomes.find((o) => o.outcome === "email_found")).toMatchObject({ reads: 2, engineCanMake: false });
    expect(out.outcomes.find((o) => o.outcome === "email_checked")).toMatchObject({ reads: 0, engineCanMake: true });
    expect(out.notRead).toContain("broken");
    expect(seen).toEqual([{ kind: "engines", orgId: ORG }]);
  });

  it("with an outcome: each read's route, query and path filters (headers dropped), and the Engine's ask", async () => {
    const { deps } = fakes();
    const out = (await findOutcome({ outcome: "email_sent" }, { orgId: ORG }, deps, createProviderIndex(deps))) as { get: Array<Record<string, unknown>>; ask: unknown };
    expect(out.get[0]).toMatchObject({ route: "listEmailSentUnits", method: "GET", description: "Scope: every brand of the CALLING org." });
    expect(out.get[0].filters).toEqual([{ name: "emails", in: "query", required: false, type: "string", description: "Comma-separated addresses" }]);
    expect(out.ask).toBe("no Engine makes email_sent");
    const checked = (await findOutcome({ outcome: "email_checked" }, { orgId: ORG }, deps, createProviderIndex(deps))) as { ask: { scripts: unknown[]; canMake: boolean } };
    expect(checked.ask.canMake).toBe(true);
    expect(checked.ask.scripts).toEqual([{ name: "Email address check", does: "Checks one email address (request.email).", takes: [], readsRequest: ["email"] }]);
    const none = (await findOutcome({ outcome: "backlink_earned" }, { orgId: ORG }, deps, createProviderIndex(deps))) as { ask: { whyNot: string } };
    expect(none.ask.whyNot).toBe("No script can run now.");
  });
});

describe("get_units = a Script's ctx.get: only a tagged read, as the conversation's org", () => {
  it("reads through the one documented read, with the turn's run, never a path the model wrote", async () => {
    const { deps, seen } = fakes();
    const out = (await getUnits(
      { outcome: "email_sent", filters: { query: { emails: ["k.lourd+fp3n-dryrun1030@smartdistribute.com"] }, path: "/internal/admin/wipe" } },
      who,
      deps,
      createProviderIndex(deps),
    )) as Record<string, unknown>;
    expect(seen).toEqual([
      { kind: "call", service: "instantly", method: "GET", path: "/orgs/units/email-sent?emails=k.lourd%2Bfp3n-dryrun1030%40smartdistribute.com", headers: { "x-run-id": "turn-run" } },
    ]);
    expect(out).toMatchObject({ outcome: "email_sent", route: "listEmailSentUnits", status: 200, ok: true });
  });

  it("several reads = name one; a read nobody documents = a refusal naming the tag", async () => {
    const { deps } = fakes();
    const index = createProviderIndex(deps);
    await expect(getUnits({ outcome: "email_found" }, who, deps, index)).rejects.toThrow(/several Provider reads.*listEmailFoundUnits/);
    await expect(getUnits({ outcome: "backlink_earned" }, who, deps, index)).rejects.toThrow(/provider:backlink_earned/);
    await expect(getUnits({ outcome: "email_found", filters: { route: "wipe" } }, who, deps, index)).rejects.toThrow(/no Provider read of email_found is named wipe/);
  });

  it("fills path params and refuses an unfilled one or a body on a GET", () => {
    const op = pickProviderRead("email_found", "readX", providerOperationsOf(specs).get("email_found")!, []);
    expect(buildRead(op, { params: { id: "a/b" }, body: { x: 1 } })).toEqual({ path: "/x/a%2Fb", body: { x: 1 } });
    expect(() => buildRead(op, {})).toThrow(/params.id/);
    const get = pickProviderRead("email_sent", undefined, providerOperationsOf(specs).get("email_sent")!, []);
    expect(() => buildRead(get, { body: {} })).toThrow(/takes no body/);
  });
});

describe("ask_engine = a Script's ctx.ask: one Unit, after the person's yes, on a run of ours", () => {
  it("first call: nothing runs, a proposal; the token from a later message runs exactly that ask", async () => {
    const { deps, seen } = fakes();
    const proposal = (await askEngine({ outcome: "email_checked", inputs: { request: { email: "k.lourd@smartdistribute.com" } } }, who, [], deps)) as { confirmationToken: string };
    expect(proposal).toMatchObject({ yesRequired: true, ask: { outcome: "email_checked" } });
    expect(seen.some((s) => s.kind === "make" || s.kind === "run")).toBe(false);

    const history = [{ toolCalls: [{ name: ASK_ENGINE_TOOL_NAME, args: {}, result: proposal }] }];
    const ran = (await askEngine({ confirmationToken: proposal.confirmationToken, outcome: "backlink_earned" }, who, history, deps)) as Record<string, unknown>;
    expect(seen.filter((s) => s.kind !== "engines")).toEqual([
      { kind: "run", orgId: ORG, userId: "user-1" },
      { kind: "make", outcome: "email_checked", body: { units: {}, request: { email: "k.lourd@smartdistribute.com" } }, headers: { "x-org-id": ORG, "x-user-id": "user-1", "x-run-id": "ask-run" } },
    ]);
    expect(ran).toMatchObject({ ran: true, outcome: "email_checked", status: "made", unit: { outcome: "email_checked", subject: { service: "runs-service", id: "ask-run" }, content: { verdict: "valid" } }, script: "bounceban v3" });

    const used = [...history, { toolCalls: [{ name: ASK_ENGINE_TOOL_NAME, args: { confirmationToken: proposal.confirmationToken }, result: ran }] }];
    expect(() => resolveAskProposal(proposal.confirmationToken, used)).toThrow(/already used/);
    expect(() => resolveAskProposal("nope", history)).toThrow(/unknown confirmationToken/);
  });

  it("an outcome no Engine makes is refused; a proactive turn never asks; inputs carry nothing else", async () => {
    const { deps } = fakes();
    await expect(askEngine({ outcome: "email_sent_nowhere" }, who, [], deps)).rejects.toThrow(/no Engine makes/);
    await expect(askEngine({ outcome: "email_found" }, who, [], deps, { readOnly: true })).rejects.toThrow(/only reads/);
    await expect(askEngine({ outcome: "email_found", inputs: { orgId: "other" } }, who, [], deps)).rejects.toThrow(/units, request and channel only/);
    expect(isProactiveReadTool("find_outcome")).toBe(true);
    expect(isProactiveReadTool("get_units")).toBe(true);
    expect(isProactiveReadTool("ask_engine")).toBe(false);
  });

  it("a refusal is answered in workflow-service's words", async () => {
    const { deps } = fakes({ makeUnit: async () => ({ status: 404, data: { code: "no_runnable_script", error: "no script of Engine email_found can run" } }) });
    const p = (await askEngine({ outcome: "email_checked" }, who, [], deps)) as { confirmationToken: string };
    const out = await askEngine({ confirmationToken: p.confirmationToken }, who, [{ toolCalls: [{ name: ASK_ENGINE_TOOL_NAME, result: p }] }], deps);
    expect(out).toMatchObject({ ran: true, refused: true, httpStatus: 404, code: "no_runnable_script" });
  });
});

describe("one Distry on every surface: the Outcome tools are hers, not staff-only", () => {
  it("every account turn holds them; no tool takes an org", () => {
    for (const t of OUTCOME_TOOL_NAMES) {
      expect(SOPHIE_TOOLS).toContain(t);
      expect(TOOL_REGISTRY[t]).toBeDefined();
      expect(isPrincipalToolName(t)).toBe(false);
      expect(Object.keys((TOOL_REGISTRY[t].input_schema.properties ?? {}) as object)).not.toContain("orgId");
    }
  });

  it("a stored version's retired `engines` entry reads as the Outcome tools, in its place, once", () => {
    expect(withOutcomeToolsForEngines(["read_skill", "engines", "get_units"])).toEqual(["read_skill", "find_outcome", "get_units", "ask_engine"]);
    expect(withOutcomeToolsForEngines(["read_skill"])).toEqual(["read_skill"]);
  });

  it("no Engine call is a Campaign any more, and the deleted direct routes are never called", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
    for (const f of walk("src")) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\/internal\/engines\/[^"`]*\/calls|\/internal\/engine-calls/);
      expect(text, f).not.toMatch(/startEngineCampaign|engine__/);
    }
  });
});
