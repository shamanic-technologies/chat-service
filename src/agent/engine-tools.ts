// ---------------------------------------------------------------------------
// Distry calls any Engine (DISTRY-PRINCIPAL-1119, owner 2026-11-19: « access to
// all Engines as tools (by calling the most performing script ...), it just
// waits for the results »; « Make sure every outcome is callable by Distry »).
//
// The tool list is built at each turn from workflow-service's LIVE read of
// every Engine (`GET /internal/engines`): one tool per Engine that can run now,
// never a hard-coded list.
//
// Calling one is ALWAYS a campaign (DISTRY-CALL-IS-CAMPAIGN-1121, owner 2026-11-21:
// « tout appel de Distry sur un de ces engines est TOUJOURS une campagne,
// obligatoirement »): a normal campaign on campaign-service whose Target is the
// Engine's outcome, with the brief, max volume and/or max budget (one-off /
// daily / weekly / monthly, stated at billing on that campaign) and an optional
// offer Distry states. It answers at once with the campaign and when its first
// run happens (« It is okay to wait ... as long as Distry gets back the info
// about when it's going to start »); `read_engine_campaign` reads its progress
// later. There is NO direct Engine call any more: never call workflow-service's
// former `/internal/engines/{outcome}/calls` or `/internal/engine-calls/*` again
// (pinned by tests/unit/engine-tools.test.ts). chat-service picks nothing and
// runs nothing itself.
// ---------------------------------------------------------------------------

import type Anthropic from "@anthropic-ai/sdk";
import { ENGINE_TOOL_PREFIX } from "./principal-tools.js";
import { fillTemplate } from "../lib/prompt-template.js";

export const READ_ENGINE_CAMPAIGN_TOOL_NAME = "read_engine_campaign";

export interface EngineInputOption {
  units: string[];
  channel: string | null;
}

/** One Engine as workflow-service lists it. */
export interface EngineListing {
  outcome: string;
  name: string;
  callable: boolean;
  reason: string | null;
  inputs: EngineInputOption[];
  counts?: { scripts: number; live: number; runnable: number };
}

export interface EngineCallTarget {
  orgId: string;
  userId: string;
  brandId: string | null;
  /** The caller's own run under that org: every script run is its child. */
  runId: string;
}

export type WorkflowFetch = (path: string, init: { method: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export function workflowFetchFromEnv(env: NodeJS.ProcessEnv = process.env): WorkflowFetch {
  const base = (env.WORKFLOW_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = env.WORKFLOW_SERVICE_API_KEY ?? "";
  if (!base || !key) throw new Error("WORKFLOW_SERVICE_URL / WORKFLOW_SERVICE_API_KEY not configured: Engines cannot be listed or called");
  return (path, init) =>
    fetch(`${base}${path}`, {
      method: init.method,
      headers: { "content-type": "application/json", "x-api-key": key, ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(330_000),
    });
}

/** Every Engine of the live catalogue, callable or not (the read the dashboard renders too). */
export async function listEngines(fetchImpl: WorkflowFetch): Promise<EngineListing[]> {
  const res = await fetchImpl("/internal/engines", { method: "GET" });
  const text = await res.text();
  if (!res.ok) throw new Error(`workflow-service engine list ${res.status}: ${text.slice(0, 300)}`);
  const engines = (JSON.parse(text) as { engines?: unknown }).engines;
  if (!Array.isArray(engines)) throw new Error(`workflow-service answered no engines: ${text.slice(0, 300)}`);
  return engines as EngineListing[];
}

/** A tool name the model APIs accept (letters, digits, _ and -, 64 max), stable per outcome. */
export function engineToolName(outcome: string): string {
  return `${ENGINE_TOOL_PREFIX}${outcome.replace(/[^a-zA-Z0-9_-]+/g, "_")}`.slice(0, 64);
}

function waysToCall(e: EngineListing): string {
  if (e.inputs.length === 0) return "nothing handed.";
  return (
    e.inputs
      .map((i) => {
        const units = i.units.length > 0 ? `Units of ${i.units.join(", ")}` : "nothing handed";
        return i.channel ? `${units} (channel ${i.channel})` : units;
      })
      .join("; or ") + ", which the campaign finds itself."
  );
}

/** The words of every Engine tool's description (Distry's editor part `engine-tool`, DISTRY-PROMPT-PARTS-1120). */
export const ENGINE_TOOL_DESCRIPTION_TEMPLATE =
  `Engine "{{engineName}}": starts a campaign that makes Units of this outcome, run by the Engine's best scripts (the Rating picks them). ` +
  `State the brief, and a max volume (how many Units) and/or a max budget, each one-off, daily, weekly or monthly: the campaign stops by itself at its cap. ` +
  `It answers at once with the campaign and when its first run happens (nothing is made during this call): tell the person, or read its progress later with ${READ_ENGINE_CAMPAIGN_TOOL_NAME}. ` +
  `The same outcome on the same brand (and the same offer, or none) is always the same campaign: a new call restates its brief and caps and starts it again, and a one-off max volume counts every Unit it ever made, so state the total you want. ` +
  `Its scripts work from: {{waysToCall}} ` +
  `It runs on distribute.you's own account unless orgId and brandId name another one, billed to that account. What it makes can reach real people: run it only when its outcome serves our goal.`;

const PERIODS = ["one_off", "daily", "weekly", "monthly"] as const;
const periodSchema = { type: "string", enum: [...PERIODS], description: "one_off = in all; daily / weekly / monthly = per period, again each period." };

export function engineTool(e: EngineListing, template: string = ENGINE_TOOL_DESCRIPTION_TEMPLATE): Anthropic.Tool {
  return {
    name: engineToolName(e.outcome),
    description: fillTemplate(template, { engineName: e.name, waysToCall: waysToCall(e) }),
    input_schema: {
      type: "object",
      properties: {
        brief: { type: "string", description: "What the campaign is for, in plain words: the scripts read it as their request (the topic, who it is for, words to say...)." },
        maxVolume: {
          type: "object",
          properties: { count: { type: "integer", minimum: 1 }, period: periodSchema },
          required: ["count", "period"],
          description: "How many Units at most. Omit when you state a max budget only.",
        },
        maxBudget: {
          type: "object",
          properties: { usd: { type: "number", exclusiveMinimum: 0 }, period: periodSchema },
          required: ["usd", "period"],
          description: "How many dollars at most, to avoid bad surprises. Omit when you state a max volume only.",
        },
        offerId: { type: "string", description: "The offer it sells, when it sells one. Omit = no offer." },
        orgId: { type: "string", description: "Another account to run it for (with brandId). Omit = distribute.you's own." },
        brandId: { type: "string", description: "That account's brand." },
      },
      required: ["brief"],
    },
  };
}

export const READ_ENGINE_CAMPAIGN_TOOL: Anthropic.Tool = {
  name: READ_ENGINE_CAMPAIGN_TOOL_NAME,
  description: "Read the progress of a campaign an Engine tool started: the Units made so far, its spend, whether it has finished, and why it is idle when it is.",
  input_schema: {
    type: "object",
    properties: {
      campaignId: { type: "string", description: "The campaignId the Engine tool answered." },
      orgId: { type: "string", description: "The account it runs for, when not distribute.you's own." },
    },
    required: ["campaignId"],
  },
};

/** The tools of the Engines that can run now, and the outcome each name stands for. */
export function engineToolsFrom(
  engines: readonly EngineListing[],
  template: string = ENGINE_TOOL_DESCRIPTION_TEMPLATE,
): { tools: Anthropic.Tool[]; outcomeOf: Map<string, string> } {
  const callable = engines.filter((e) => e.callable);
  const tools = callable.map((e) => engineTool(e, template));
  const outcomeOf = new Map(callable.map((e) => [engineToolName(e.outcome), e.outcome]));
  if (outcomeOf.size !== callable.length) throw new Error("two Engines map to the same tool name: their outcome keys differ only in punctuation");
  return { tools: tools.length > 0 ? [...tools, READ_ENGINE_CAMPAIGN_TOOL] : [], outcomeOf };
}

// --- The campaign: campaign-service makes it, billing holds its caps --------------------------

/** A call to campaign-service or billing-service with its service key and the target's identity. */
export type CampaignFetch = (service: "campaign" | "billing", path: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export function campaignFetchFromEnv(env: NodeJS.ProcessEnv = process.env): CampaignFetch {
  const cfg = {
    campaign: { url: (env.CAMPAIGN_SERVICE_URL ?? "").replace(/\/$/, ""), key: env.CAMPAIGN_SERVICE_API_KEY ?? "" },
    billing: { url: (env.BILLING_SERVICE_URL ?? "").replace(/\/$/, ""), key: env.BILLING_SERVICE_API_KEY ?? "" },
  };
  for (const [name, c] of Object.entries(cfg)) {
    if (!c.url || !c.key) throw new Error(`${name.toUpperCase()}_SERVICE_URL / ${name.toUpperCase()}_SERVICE_API_KEY not configured: an Engine campaign cannot be started or read`);
  }
  return (service, path, init) =>
    fetch(`${cfg[service].url}${path}`, {
      method: init.method,
      headers: { "content-type": "application/json", "x-api-key": cfg[service].key, ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(60_000),
    });
}

const enc = encodeURIComponent;

function headersFor(t: EngineCallTarget): Record<string, string> {
  return { "x-org-id": t.orgId, "x-user-id": t.userId, "x-run-id": t.runId, ...(t.brandId ? { "x-brand-id": t.brandId } : {}) };
}

async function send(fetchImpl: CampaignFetch, service: "campaign" | "billing", what: string, path: string, method: string, t: EngineCallTarget, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetchImpl(service, path, { method, headers: headersFor(t), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${service}-service ${what} ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new EngineCampaignRefusedError(service, what, res.status, parsed);
  return parsed;
}

/** A refusal in the producer's own words: answered to the model as a result, never a guess. */
export class EngineCampaignRefusedError extends Error {
  constructor(
    public readonly service: string,
    public readonly what: string,
    public readonly status: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(`${service}-service ${what} ${status}: ${String(body.error ?? JSON.stringify(body)).slice(0, 300)}`);
    this.name = "EngineCampaignRefusedError";
  }
}

function capArgs(outcome: string, args: Record<string, unknown>): { maxVolume: { count: number; period: string } | null; maxBudget: { amountCents: number; period: string } | null } {
  const period = (name: string, v: unknown): string => {
    if (!(PERIODS as readonly unknown[]).includes(v)) throw new Error(`[${outcome}] ${name}.period must be one of ${PERIODS.join(", ")}`);
    return v as string;
  };
  let maxVolume = null;
  if (args.maxVolume !== undefined && args.maxVolume !== null) {
    const v = args.maxVolume as { count?: unknown; period?: unknown };
    if (typeof v !== "object" || typeof v.count !== "number" || !Number.isInteger(v.count) || v.count < 1) throw new Error(`[${outcome}] maxVolume.count must be a whole number of at least 1`);
    maxVolume = { count: v.count, period: period("maxVolume", v.period) };
  }
  let maxBudget = null;
  if (args.maxBudget !== undefined && args.maxBudget !== null) {
    const b = args.maxBudget as { usd?: unknown; period?: unknown };
    if (typeof b !== "object" || typeof b.usd !== "number" || !(b.usd > 0)) throw new Error(`[${outcome}] maxBudget.usd must be a number of dollars above 0`);
    const amountCents = Math.round(b.usd * 100);
    if (amountCents < 1) throw new Error(`[${outcome}] maxBudget.usd must be at least $0.01`);
    maxBudget = { amountCents, period: period("maxBudget", b.period) };
  }
  if (!maxVolume && !maxBudget) throw new Error(`[${outcome}] state a max volume, a max budget, or both: a campaign never runs without a cap`);
  return { maxVolume, maxBudget };
}

/**
 * One Engine call = one campaign on its outcome: created stopped, its caps stated at billing on
 * that campaign, then activated, so the first run time it answers counts the caps.
 */
export async function startEngineCampaign(
  outcome: string,
  args: Record<string, unknown>,
  target: EngineCallTarget & { brandId: string },
  fetchImpl: CampaignFetch,
): Promise<Record<string, unknown>> {
  const brief = typeof args.brief === "string" ? args.brief.trim() : "";
  if (!brief) throw new Error(`[${outcome}] brief is required: say what the campaign is for`);
  const caps = capArgs(outcome, args);
  const offerId = typeof args.offerId === "string" && args.offerId.trim() ? args.offerId.trim() : null;
  try {
    const created = await send(fetchImpl, "campaign", "campaign create", "/sales-funnel-campaigns", "POST", target, {
      brandId: target.brandId,
      ...(offerId ? { offerId } : {}),
      target: outcome,
      brief,
      status: "stopped",
    });
    const campaign = created.salesFunnelCampaign as { id?: unknown; salesFunnelId?: unknown; salesFunnelName?: unknown } | undefined;
    if (!campaign || typeof campaign.id !== "string" || typeof campaign.salesFunnelId !== "string") {
      throw new Error(`campaign-service answered no campaign: ${JSON.stringify(created).slice(0, 300)}`);
    }
    const capsPath = `/v1/brands/${enc(target.brandId)}${offerId ? `/offers/${enc(offerId)}` : ""}/sales-funnels/${enc(campaign.salesFunnelId)}/campaigns/${enc(campaign.id)}/caps`;
    const capsView = await send(fetchImpl, "billing", "campaign caps", capsPath, "PUT", target, caps);
    const activated = await send(fetchImpl, "campaign", "campaign start", `/sales-funnel-campaigns/${enc(campaign.id)}`, "PATCH", target, { status: "activate" });
    const after = (activated.salesFunnelCampaign ?? {}) as { status?: unknown; stopReason?: unknown };
    return {
      campaignId: campaign.id,
      name: campaign.salesFunnelName ?? null,
      created: created.created ?? null,
      status: after.status ?? null,
      stopReason: after.stopReason ?? null,
      nextRun: activated.nextRun ?? created.nextRun ?? null,
      caps: { maxVolume: capsView.maxVolume ?? null, maxBudget: capsView.maxBudget ?? null, funded: capsView.funded ?? null },
      note: `Nothing is made during this call: say when its first run happens (nextRun), then read its progress with ${READ_ENGINE_CAMPAIGN_TOOL_NAME}.`,
    };
  } catch (err) {
    if (err instanceof EngineCampaignRefusedError && err.status < 500) {
      return { status: "refused", by: `${err.service}-service`, step: err.what, reason: err.body.reason ?? null, error: err.body.error ?? null };
    }
    throw err;
  }
}

/** What the model reads of a campaign's progress: the producer's own figures, cut to a readable size. */
export async function readEngineCampaign(campaignId: string, target: EngineCallTarget, fetchImpl: CampaignFetch): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) throw new Error(`[${READ_ENGINE_CAMPAIGN_TOOL_NAME}] ${campaignId} is not a campaign id`);
  const served = await send(fetchImpl, "campaign", "campaign progress", `/sales-funnel-campaigns/${enc(campaignId)}/progress`, "GET", target);
  const text = JSON.stringify(served);
  return text.length > 6000 ? { progress: `${text.slice(0, 6000)}… (cut)` } : served;
}
