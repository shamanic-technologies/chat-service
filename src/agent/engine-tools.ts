// ---------------------------------------------------------------------------
// Distry calls any Engine (DISTRY-PRINCIPAL-1119, owner 2026-11-19: « access to
// all Engines as tools (by calling the most performing script ...), it just
// waits for the results »; « Make sure every outcome is callable by Distry »).
//
// The tool list is built at each turn from workflow-service's LIVE read of
// every Engine (`GET /internal/engines`): one tool per Engine that can run now,
// never a hard-coded list. Calling one asks workflow-service for one Unit of
// that Engine: the SAME Rating pick a campaign takes, run org-billed on a child
// run of the caller's, and waits for it (`POST /internal/engines/{outcome}/calls`,
// then `GET /internal/engine-calls/{callId}` while it runs). chat-service picks
// nothing and runs nothing itself.
// ---------------------------------------------------------------------------

import type Anthropic from "@anthropic-ai/sdk";
import { ENGINE_TOOL_PREFIX } from "./principal-tools.js";
import { fillTemplate } from "../lib/prompt-template.js";

export const READ_ENGINE_CALL_TOOL_NAME = "read_engine_call";

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
  if (e.inputs.length === 0) return "Hand nothing.";
  return e.inputs
    .map((i) => {
      const units = i.units.length > 0 ? `hand Units of: ${i.units.join(", ")}` : "hand nothing";
      return i.channel ? `${units}, channel ${i.channel}` : units;
    })
    .join("; or ");
}

/** The words of every Engine tool's description (Distry's editor part `engine-tool`, DISTRY-PROMPT-PARTS-1120). */
export const ENGINE_TOOL_DESCRIPTION_TEMPLATE =
  `Engine "{{engineName}}": makes one Unit of this outcome. Runs the Engine's best script (the Rating picks it, as for a campaign) and waits for the result, then answers the Unit or why none was made. ` +
  `Ways to call: {{waysToCall}} ` +
  `It runs on distribute.you's own account unless orgId and brandId name another one, billed to that account. What it makes can reach real people: run it only when its outcome serves our goal.`;

export function engineTool(e: EngineListing, template: string = ENGINE_TOOL_DESCRIPTION_TEMPLATE): Anthropic.Tool {
  const channels = [...new Set(e.inputs.map((i) => i.channel).filter((c): c is string => typeof c === "string"))];
  const unitOutcomes = [...new Set(e.inputs.flatMap((i) => i.units))];
  return {
    name: engineToolName(e.outcome),
    description: fillTemplate(template, { engineName: e.name, waysToCall: waysToCall(e) }),
    input_schema: {
      type: "object",
      properties: {
        request: { type: "object", description: "What the script reads as its request (the brief, a target, words to say...). Omit when nothing is needed." },
        ...(unitOutcomes.length > 0
          ? { units: { type: "object", description: `Units handed, keyed by outcome (${unitOutcomes.join(", ")}): each a Unit or a list of Units, as another Engine call returned them.` } }
          : {}),
        ...(channels.length > 0 ? { channel: { type: "string", enum: channels, description: "The channel the work is for." } } : {}),
        subject: {
          type: "object",
          properties: { service: { type: "string" }, id: { type: "string" } },
          required: ["service", "id"],
          description: "Who or what the Unit is about, when you know it (a lead: {service: \"lead-service\", id}). Omit = this request of yours.",
        },
        orgId: { type: "string", description: "Another account to run it for (with brandId). Omit = distribute.you's own." },
        brandId: { type: "string", description: "That account's brand." },
      },
    },
  };
}

export const READ_ENGINE_CALL_TOOL: Anthropic.Tool = {
  name: READ_ENGINE_CALL_TOOL_NAME,
  description: "Read an Engine call that was still running when its tool answered: waits up to a minute, then answers its Unit, why none was made, or that it still runs.",
  input_schema: {
    type: "object",
    properties: {
      callId: { type: "string", description: "The callId the Engine tool answered." },
      orgId: { type: "string", description: "The account it ran for, when not distribute.you's own." },
    },
    required: ["callId"],
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
  return { tools: tools.length > 0 ? [...tools, READ_ENGINE_CALL_TOOL] : [], outcomeOf };
}

/** How long one tool call waits in all before answering "still running" (the client side times out at 300 s). */
export const ENGINE_CALL_WAIT_BUDGET_S = 240;
/** One wait per request to workflow-service (its own cap). */
const WAIT_PER_REQUEST_S = 60;

function headersFor(t: Pick<EngineCallTarget, "orgId" | "userId" | "brandId" | "runId">): Record<string, string> {
  return { "x-org-id": t.orgId, "x-user-id": t.userId, "x-run-id": t.runId, ...(t.brandId ? { "x-brand-id": t.brandId } : {}) };
}

/** What the model reads: the call as workflow-service served it, the Unit cut to a readable size. */
export function callAnswer(served: Record<string, unknown>): Record<string, unknown> {
  const unit = served.unit;
  const unitText = unit === null || unit === undefined ? null : JSON.stringify(unit);
  return {
    callId: served.callId,
    status: served.status,
    ended: served.ended,
    ...(unitText === null ? { unit: null } : unitText.length > 6000 ? { unit: `${unitText.slice(0, 6000)}… (cut)` } : { unit }),
    error: served.error ?? null,
    pick: served.pick ?? null,
    ...(served.ended === false ? { note: `Still running: read it again with ${READ_ENGINE_CALL_TOOL_NAME}.` } : {}),
  };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`workflow-service ${res.status}: ${text.slice(0, 300)}`);
  }
}

export async function readEngineCall(callId: string, target: Pick<EngineCallTarget, "orgId">, waitSeconds: number, fetchImpl: WorkflowFetch): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f-]{36}$/i.test(callId)) throw new Error(`[${READ_ENGINE_CALL_TOOL_NAME}] ${callId} is not a call id`);
  const res = await fetchImpl(`/internal/engine-calls/${encodeURIComponent(callId)}?waitSeconds=${waitSeconds}`, { method: "GET", headers: { "x-org-id": target.orgId } });
  const body = await readJson(res);
  if (!res.ok) throw new Error(`workflow-service engine call ${res.status}: ${String(body.error ?? JSON.stringify(body)).slice(0, 300)}`);
  return body;
}

/** One Unit of an Engine: start the call, then wait on it within the budget. */
export async function callEngine(
  outcome: string,
  args: Record<string, unknown>,
  target: EngineCallTarget,
  fetchImpl: WorkflowFetch,
  budgetSeconds = ENGINE_CALL_WAIT_BUDGET_S,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { waitSeconds: Math.min(WAIT_PER_REQUEST_S, budgetSeconds) };
  if (args.request !== undefined && args.request !== null) {
    if (typeof args.request !== "object" || Array.isArray(args.request)) throw new Error(`[${outcome}] request must be an object`);
    body.request = args.request;
  }
  if (args.units !== undefined && args.units !== null) {
    if (typeof args.units !== "object" || Array.isArray(args.units)) throw new Error(`[${outcome}] units must be an object keyed by outcome`);
    body.units = args.units;
  }
  if (typeof args.channel === "string" && args.channel) body.channel = args.channel;
  // The ledger declares every Unit on a subject: the one the model names, else this call itself
  // (Distry's own request, its run): never a guess about someone else.
  const subject = args.subject as { service?: unknown; id?: unknown } | undefined;
  if (subject !== undefined && subject !== null) {
    if (typeof subject !== "object" || typeof subject.service !== "string" || !subject.service || typeof subject.id !== "string" || !subject.id) {
      throw new Error(`[${outcome}] subject must be {service, id}`);
    }
    body.subject = { service: subject.service, id: subject.id };
  } else {
    body.subject = { service: "chat-service", id: target.runId };
  }
  const res = await fetchImpl(`/internal/engines/${encodeURIComponent(outcome)}/calls`, { method: "POST", headers: headersFor(target), body: JSON.stringify(body) });
  const started = await readJson(res);
  if (res.status === 404 && started.code === "no_runnable_script") return { status: "not_callable", error: started.error ?? "no runnable script" };
  if (!res.ok && res.status !== 202) throw new Error(`workflow-service engine call ${res.status}: ${String(started.error ?? JSON.stringify(started)).slice(0, 300)}`);
  let served = started;
  let waited = Number(body.waitSeconds);
  while (served.ended === false && waited < budgetSeconds) {
    const step = Math.min(WAIT_PER_REQUEST_S, budgetSeconds - waited);
    served = await readEngineCall(String(served.callId), target, step, fetchImpl);
    waited += step;
  }
  return callAnswer(served);
}
