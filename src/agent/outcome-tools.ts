// ---------------------------------------------------------------------------
// Distry uses Outcomes exactly like a Script does (ENGINE-GET-ASK-1123, owner
// 2026-11-23: « Distry must use Outcomes exactly like a Script (no special
// case) »; « Pourquoi ne pas ... juste avoir une doc OpenAPI interne où l'agent
// peut lire pour savoir comment appeler les get/ask de chq Engine/Provider »).
//
//   find_outcome  reads the doc: for an outcome, its Provider's reads (every
//                 operation tagged `provider:<outcome>` in a service's SERVED
//                 OpenAPI, as the api-registry holds it) and its Engine's ask
//                 (workflow-service's live Engine list: can it make one now,
//                 what it takes). Nothing is spent.
//   get_units     = a Script's `ctx.get(outcome, filters)`: READ Units that
//                 already exist, through the read the Provider documents, as
//                 the conversation's org. Nothing is spent.
//   ask_engine    = a Script's `ctx.ask(outcome, inputs)`: MAKE one new Unit
//                 now (workflow-service `POST /internal/engines/{outcome}/make`,
//                 the Rating picks the script), on a run of ours under the
//                 conversation's org. It spends that org's money, so it runs
//                 only from a later message after the person's yes (the same
//                 yes rule as run_operation).
//
// Nothing here knows an outcome, an Engine or a Provider: the lists are read at
// run time. The model never names a service, a path or an org: a read is
// resolved from the tag index (only `provider:<outcome>` operations are
// callable), an ask from the outcome, and both carry the conversation's org.
// A Campaign (Target, budget, brief, ongoing production) is created as before,
// through the client API (run_operation): an Engine ask is never a Campaign.
// ---------------------------------------------------------------------------

import { assertSafeRoutePath } from "../lib/route-path.js";
import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";

export const FIND_OUTCOME_TOOL_NAME = "find_outcome";
export const GET_UNITS_TOOL_NAME = "get_units";
export const ASK_ENGINE_TOOL_NAME = "ask_engine";
export const OUTCOME_TOOL_NAMES = [FIND_OUTCOME_TOOL_NAME, GET_UNITS_TOOL_NAME, ASK_ENGINE_TOOL_NAME] as const;

/** The run an Engine ask rides under the conversation's org (an order of work, not support). */
export const DISTRY_ENGINE_ASK_TASK_NAME = "distry-engine-ask";

/** The OpenAPI tag a Provider puts on the operation that reads its outcome's Units (byte-equal to workflow-service). */
const TAG_PREFIX = "provider:";
export const providerTag = (outcome: string) => `${TAG_PREFIX}${outcome}`;

/** A tool answer larger than this is cut (one read never floods the context). */
export const OUTCOME_RESULT_MAX_CHARS = 6000;

// --- Tools ------------------------------------------------------------------

export const FIND_OUTCOME_TOOL: Anthropic.Tool = {
  name: FIND_OUTCOME_TOOL_NAME,
  description:
    "Whether we already did something for a person or company (emailed them, queued an email, found or checked an address, read a page) and how to make a new one. No outcome = the list of kinds. With one = how to read what we hold (get_units) and what its Engine needs (ask_engine). Free.",
  input_schema: {
    type: "object",
    properties: {
      outcome: { type: "string" },
      q: { type: "string", description: "Words to narrow the list." },
    },
  },
};

export const GET_UNITS_TOOL: Anthropic.Tool = {
  name: GET_UNITS_TOOL_NAME,
  description: "Read what we already hold for an outcome, for this account (e.g. the emails we sent someone, the verdicts held for an address). Free. `filters` = the read's request as find_outcome documents it.",
  input_schema: {
    type: "object",
    properties: {
      outcome: { type: "string" },
      filters: { type: "object", description: "{route?, params?, query?, body?}" },
    },
    required: ["outcome"],
  },
};

export const ASK_ENGINE_TOOL: Anthropic.Tool = {
  name: ASK_ENGINE_TOOL_NAME,
  description:
    "Make ONE new result now, when nothing held fits. Costs money: the first call only proposes; after the person's yes in a later message, call again with the confirmationToken. Ongoing production is a campaign.",
  input_schema: {
    type: "object",
    properties: {
      outcome: { type: "string" },
      inputs: { type: "object", description: "{units?, request?, channel?} as find_outcome documents it." },
      confirmationToken: { type: "string" },
    },
  },
};

export const OUTCOME_TOOLS: readonly Anthropic.Tool[] = [FIND_OUTCOME_TOOL, GET_UNITS_TOOL, ASK_ENGINE_TOOL];

// --- Producers --------------------------------------------------------------

export interface ProviderOperation {
  service: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  operationId: string | null;
  op: Record<string, unknown>;
}

/** One Engine as workflow-service lists it (`GET /internal/engines`). */
export interface EngineListing {
  outcome: string;
  name: string;
  callable: boolean;
  reason: string | null;
  inputs: Array<{ units: string[]; channel: string | null }>;
  counts?: { scripts: number; live: number; runnable: number };
  /** Whether a DIRECT ask (no campaign) can make one now (workflow-service, ENGINE-GET-ASK-1123). */
  ask?: { possible: boolean; needsNothing: boolean; reason: string | null };
  /** Each live script, with the top-level `request` fields its code reads (read off the script by workflow-service). */
  scripts?: Array<{ dynasty: string; name: string | null; units: string[]; requestFields?: string[]; requestHandedOn?: boolean }>;
}

/** One live script of an Engine, as workflow-service serves it: what it does, in its author's words. */
export interface EngineScript {
  dynasty: string;
  name: string | null;
  description: string | null;
  materials: string[];
  runnable: boolean;
}

/** Who the call is for: the conversation's org and person, and the turn's run. */
export interface OutcomeIdentity {
  orgId: string;
  userId: string;
  runId: string;
}

export interface OutcomeDeps {
  /** Every service the api-registry lists. */
  listServices(): Promise<string[]>;
  /** One service's served OpenAPI, as the registry holds it (null = unreadable). */
  fetchSpec(service: string): Promise<Record<string, unknown> | null>;
  /** One call to a service, through the registry (the target's service key, our identity headers). */
  callService(service: string, req: { method: string; path: string; body?: unknown; headers: Record<string, string> }): Promise<{ status: number; ok: boolean; data: unknown }>;
  /** workflow-service's live Engine list for this org. */
  listEngines(orgId: string): Promise<EngineListing[]>;
  /** The active scripts of one Engine (what each does: the request it reads is in its description). */
  engineScripts(outcome: string): Promise<EngineScript[]>;
  /** workflow-service's ask door. */
  makeUnit(outcome: string, body: Record<string, unknown>, headers: Record<string, string>): Promise<{ status: number; data: unknown }>;
  /** A run of ours under the org, for one ask. */
  openAskRun(identity: { orgId: string; userId: string }): Promise<string>;
  now?(): number;
}

const CALLABLE = ["get", "post", "put"] as const;

/** Every operation tagged `provider:<outcome>` in these specs, by outcome (service then path order: stable). */
export function providerOperationsOf(specs: ReadonlyMap<string, Record<string, unknown>>): Map<string, ProviderOperation[]> {
  const out = new Map<string, ProviderOperation[]>();
  for (const service of [...specs.keys()].sort()) {
    const paths = specs.get(service)?.paths;
    if (!paths || typeof paths !== "object") continue;
    for (const path of Object.keys(paths as Record<string, unknown>).sort()) {
      const item = (paths as Record<string, unknown>)[path];
      if (!item || typeof item !== "object") continue;
      for (const method of CALLABLE) {
        const op = (item as Record<string, unknown>)[method];
        if (!op || typeof op !== "object") continue;
        const { tags, operationId } = op as { tags?: unknown; operationId?: unknown };
        if (!Array.isArray(tags)) continue;
        for (const tag of tags) {
          if (typeof tag !== "string" || !tag.startsWith(TAG_PREFIX) || tag.length === TAG_PREFIX.length) continue;
          const outcome = tag.slice(TAG_PREFIX.length);
          const list = out.get(outcome) ?? [];
          list.push({
            service,
            method: method.toUpperCase() as ProviderOperation["method"],
            path,
            operationId: typeof operationId === "string" && operationId ? operationId : null,
            op: op as Record<string, unknown>,
          });
          out.set(outcome, list);
        }
      }
    }
  }
  return out;
}

/** A whole index is kept this long; one missing a service's spec only this long. */
export const PROVIDER_INDEX_TTL_MS = 10 * 60_000;
export const PROVIDER_INDEX_PARTIAL_TTL_MS = 60_000;

type Index = { until: number; byOutcome: Map<string, ProviderOperation[]>; unread: string[] };

/** A cached reader of the fleet's Provider reads: one registry walk per TTL, shared by concurrent turns. */
export function createProviderIndex(deps: Pick<OutcomeDeps, "listServices" | "fetchSpec" | "now">): () => Promise<{ byOutcome: Map<string, ProviderOperation[]>; unread: string[] }> {
  const now = deps.now ?? Date.now;
  let held: Index | null = null;
  let loading: Promise<Index> | null = null;
  const load = async (): Promise<Index> => {
    const services = await deps.listServices();
    const specs = new Map<string, Record<string, unknown>>();
    await Promise.all(
      services.map(async (s) => {
        const spec = await deps.fetchSpec(s).catch((err) => {
          console.error(`[outcome-tools] spec of ${s} unreadable:`, err instanceof Error ? err.message : err);
          return null;
        });
        if (spec) specs.set(s, spec);
      }),
    );
    const unread = services.filter((s) => !specs.has(s)).sort();
    return { until: now() + (unread.length > 0 ? PROVIDER_INDEX_PARTIAL_TTL_MS : PROVIDER_INDEX_TTL_MS), byOutcome: providerOperationsOf(specs), unread };
  };
  return async () => {
    let index = held;
    if (!index || index.until <= now()) {
      loading ??= load().finally(() => (loading = null));
      index = held = await loading;
    }
    return { byOutcome: index.byOutcome, unread: index.unread };
  };
}

// --- Helpers ----------------------------------------------------------------

const plainRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const cut = (s: unknown, max: number): string | null => {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}… (cut)` : t;
};

function outcomeArg(tool: string, v: unknown): string {
  const o = str(v);
  if (!o) throw new Error(`[${tool}] outcome is required (find_outcome lists them)`);
  if (!/^[a-z0-9_.:-]{1,80}$/i.test(o)) throw new Error(`[${tool}] ${o} is not an outcome key`);
  return o;
}

/** A body cut to a readable size, saying so. */
export function compactAnswer(data: unknown): unknown {
  const raw = typeof data === "string" ? data : JSON.stringify(data);
  if (raw === undefined || raw.length <= OUTCOME_RESULT_MAX_CHARS) return data;
  return {
    truncated: true,
    totalChars: raw.length,
    preview: raw.slice(0, OUTCOME_RESULT_MAX_CHARS),
    note: `Cut at ${OUTCOME_RESULT_MAX_CHARS} of ${raw.length} characters. Narrow the read (its filters, a limit) to see the rest.`,
  };
}

/** What the model reads of one Provider read: route, filters and answer, as its service documents them. */
function readDoc(p: ProviderOperation) {
  const params = Array.isArray(p.op.parameters)
    ? (p.op.parameters as Array<Record<string, unknown>>)
        .filter((x) => x && (x.in === "query" || x.in === "path"))
        .map((x) => {
          const schema = plainRecord(x.schema) ? x.schema : {};
          return {
            name: x.name,
            in: x.in,
            required: x.required === true,
            ...(schema.type ? { type: schema.type } : {}),
            ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
            description: cut(x.description ?? schema.description, 300),
          };
        })
    : [];
  const body = plainRecord(p.op.requestBody) ? cut(JSON.stringify(p.op.requestBody), 1200) : null;
  return {
    route: p.operationId,
    service: p.service,
    method: p.method,
    summary: cut(p.op.summary, 300),
    description: cut(p.op.description, 2000),
    filters: params,
    ...(body ? { body } : {}),
  };
}

// --- find_outcome -----------------------------------------------------------

export async function findOutcome(args: Record<string, unknown>, identity: Pick<OutcomeIdentity, "orgId">, deps: OutcomeDeps, index: ReturnType<typeof createProviderIndex>): Promise<unknown> {
  const [{ byOutcome, unread }, engines] = await Promise.all([index(), deps.listEngines(identity.orgId)]);
  const engineOf = new Map(engines.map((e) => [e.outcome, e]));
  const outcome = str(args.outcome);
  if (!outcome) {
    const q = (str(args.q) ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const keys = [...new Set([...engines.map((e) => e.outcome), ...byOutcome.keys()])].sort();
    const rows = keys
      .map((k) => {
        const e = engineOf.get(k);
        return { outcome: k, name: e?.name ?? null, reads: byOutcome.get(k)?.length ?? 0, engineCanMake: e?.ask?.possible ?? false };
      })
      .filter((r) => q.every((w) => `${r.outcome} ${r.name ?? ""}`.toLowerCase().includes(w)));
    return {
      outcomes: rows,
      ...(unread.length ? { notRead: `the docs of ${unread.join(", ")} could not be read: their reads are unknown this turn` } : {}),
      note: "find_outcome(outcome) for one outcome's reads and its Engine's ask.",
    };
  }
  const key = outcomeArg(FIND_OUTCOME_TOOL_NAME, outcome);
  const reads = (byOutcome.get(key) ?? []).map(readDoc);
  const e = engineOf.get(key);
  const described = e ? new Map((await deps.engineScripts(key)).filter((x) => x.runnable).map((x) => [x.dynasty, x])) : new Map<string, EngineScript>();
  const scripts = (e?.scripts ?? [])
    .filter((x) => described.has(x.dynasty))
    .map((x) => ({
      name: x.name,
      does: cut(described.get(x.dynasty)!.description, 600),
      takes: x.units,
      readsRequest: x.requestFields ?? [],
      ...(x.requestHandedOn ? { alsoHandsItsRequestOn: true } : {}),
    }));
  return {
    outcome: key,
    name: e?.name ?? null,
    get: reads.length ? reads : `no Provider read is documented for ${key}: no held Unit can be read`,
    ask: e
      ? {
          canMake: e.ask?.possible ?? false,
          needsNothing: e.ask?.needsNothing ?? false,
          ...(e.ask?.reason ? { whyNot: e.ask.reason } : {}),
          scripts,
          note: "The Rating picks one of these scripts. inputs.units = the materials a script takes (by outcome); inputs.request = the fields it reads (readsRequest; alsoHandsItsRequestOn = it passes the request on to another Engine, whose fields count too); nothing else.",
        }
      : `no Engine makes ${key}`,
    ...(unread.length ? { notRead: `the docs of ${unread.join(", ")} could not be read: a read they document is unknown this turn` } : {}),
  };
}

// --- get_units --------------------------------------------------------------

/** The Provider read a call names: the only read of the outcome, or the one `route` names. Never a guess. */
export function pickProviderRead(outcome: string, route: unknown, operations: readonly ProviderOperation[], unread: readonly string[]): ProviderOperation {
  const listed = operations.map((o) => `${o.operationId ?? "(no operationId)"} = ${o.service} ${o.method} ${o.path}`).join("; ");
  if (operations.length === 0) {
    throw new Error(`[${GET_UNITS_TOOL_NAME}] no Provider read is documented for ${outcome} (no served operation carries the tag ${providerTag(outcome)}${unread.length ? `; docs not read: ${unread.join(", ")}` : ""})`);
  }
  if (route !== undefined && route !== null) {
    if (typeof route !== "string") throw new Error(`[${GET_UNITS_TOOL_NAME}] filters.route is the read's operationId`);
    const named = operations.filter((o) => o.operationId === route);
    if (named.length !== 1) throw new Error(`[${GET_UNITS_TOOL_NAME}] no Provider read of ${outcome} is named ${route} (documented: ${listed})`);
    return named[0]!;
  }
  if (operations.length > 1) throw new Error(`[${GET_UNITS_TOOL_NAME}] ${outcome} has several Provider reads: name one in filters.route (${listed})`);
  return operations[0]!;
}

/** The concrete path + body of a read, from its documented template and the filters (same rules as a Script's door). */
export function buildRead(op: ProviderOperation, filters: Record<string, unknown>): { path: string; body?: Record<string, unknown> } {
  const params = filters.params ?? {};
  const query = filters.query ?? {};
  if (!plainRecord(params) || !plainRecord(query)) throw new Error(`[${GET_UNITS_TOOL_NAME}] params and query are objects`);
  let path = op.path;
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string" && typeof v !== "number") throw new Error(`[${GET_UNITS_TOOL_NAME}] param ${k} is a string or a number`);
    if (String(v).trim() === "") throw new Error(`[${GET_UNITS_TOOL_NAME}] param ${k} is empty`);
    path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
  }
  const unfilled = path.match(/\{(\w+)\}/);
  if (unfilled) throw new Error(`[${GET_UNITS_TOOL_NAME}] this read needs params.${unfilled[1]}`);
  assertSafeRoutePath(path);
  const q: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    q.push([k, Array.isArray(v) ? v.map(String).join(",") : typeof v === "object" ? JSON.stringify(v) : String(v)]);
  }
  if (q.length) path += `?${new URLSearchParams(q)}`;
  if (op.method === "GET") {
    if (filters.body !== undefined) throw new Error(`[${GET_UNITS_TOOL_NAME}] this read is a GET: it takes no body`);
    return { path };
  }
  if (filters.body !== undefined && !plainRecord(filters.body)) throw new Error(`[${GET_UNITS_TOOL_NAME}] body is an object`);
  return { path, body: (filters.body as Record<string, unknown> | undefined) ?? {} };
}

export async function getUnits(args: Record<string, unknown>, identity: OutcomeIdentity, deps: OutcomeDeps, index: ReturnType<typeof createProviderIndex>): Promise<unknown> {
  const outcome = outcomeArg(GET_UNITS_TOOL_NAME, args.outcome);
  if (args.filters !== undefined && args.filters !== null && !plainRecord(args.filters)) throw new Error(`[${GET_UNITS_TOOL_NAME}] filters is an object ({route?, params?, query?, body?})`);
  const filters = (args.filters as Record<string, unknown> | undefined) ?? {};
  const { byOutcome, unread } = await index();
  const op = pickProviderRead(outcome, filters.route, byOutcome.get(outcome) ?? [], unread);
  const { path, body } = buildRead(op, filters);
  // The org is the conversation's, always: the registry forces it over anything else, and the model never names one.
  const out = await deps.callService(op.service, { method: op.method, path, ...(body !== undefined ? { body } : {}), headers: { "x-run-id": identity.runId } });
  return { outcome, route: op.operationId, status: out.status, ok: out.ok, answer: compactAnswer(out.data) };
}

// --- ask_engine -------------------------------------------------------------

interface HistoryMessage {
  toolCalls: Array<{ name: string; args?: Record<string, unknown>; result?: unknown }> | null;
}

export interface AskProposal {
  outcome: string;
  inputs: Record<string, unknown>;
}

function askInputs(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!plainRecord(v)) throw new Error(`[${ASK_ENGINE_TOOL_NAME}] inputs is one object ({units?, request?, channel?})`);
  const allowed = new Set(["units", "request", "channel"]);
  const extra = Object.keys(v).filter((k) => !allowed.has(k));
  if (extra.length) throw new Error(`[${ASK_ENGINE_TOOL_NAME}] inputs takes units, request and channel only (got ${extra.join(", ")})`);
  if (v.units !== undefined && v.units !== null && !plainRecord(v.units)) throw new Error(`[${ASK_ENGINE_TOOL_NAME}] inputs.units is an object of materials by outcome`);
  if (v.request !== undefined && v.request !== null && !plainRecord(v.request)) throw new Error(`[${ASK_ENGINE_TOOL_NAME}] inputs.request is an object`);
  if (v.channel !== undefined && v.channel !== null && !str(v.channel)) throw new Error(`[${ASK_ENGINE_TOOL_NAME}] inputs.channel is a channel name`);
  return v;
}

/** The ask behind a token, from the history BEFORE this turn's message (a user message always sits in between). */
export function resolveAskProposal(token: string, priorHistory: readonly HistoryMessage[]): AskProposal {
  let proposed: AskProposal | null = null;
  for (const m of priorHistory) {
    for (const tc of m.toolCalls ?? []) {
      if (tc.name !== ASK_ENGINE_TOOL_NAME) continue;
      const r = tc.result as { confirmationToken?: string; ask?: AskProposal; ran?: boolean } | undefined;
      if (r?.confirmationToken === token && r.ask) proposed = r.ask;
      if (tc.args?.confirmationToken === token && r?.ran === true) throw new Error(`[${ASK_ENGINE_TOOL_NAME}] this confirmationToken was already used: that ask already ran`);
    }
  }
  if (!proposed) throw new Error(`[${ASK_ENGINE_TOOL_NAME}] unknown confirmationToken for this conversation: call ask_engine without it, show the person the proposal, and wait for their yes`);
  return proposed;
}

export async function askEngine(
  args: Record<string, unknown>,
  identity: Pick<OutcomeIdentity, "orgId" | "userId">,
  priorHistory: readonly HistoryMessage[],
  deps: OutcomeDeps,
  opts: { readOnly?: boolean } = {},
): Promise<unknown> {
  if (opts.readOnly) throw new Error(`[${ASK_ENGINE_TOOL_NAME}] this turn only reads: an ask waits for the person's own words`);
  const token = str(args.confirmationToken);
  if (!token) {
    const ask: AskProposal = { outcome: outcomeArg(ASK_ENGINE_TOOL_NAME, args.outcome), inputs: askInputs(args.inputs) };
    const engine = (await deps.listEngines(identity.orgId)).find((e) => e.outcome === ask.outcome);
    if (!engine) throw new Error(`[${ASK_ENGINE_TOOL_NAME}] no Engine makes ${ask.outcome} (find_outcome lists the outcomes)`);
    return {
      yesRequired: true,
      confirmationToken: randomUUID(),
      ask,
      instruction:
        "Nothing ran. Tell the person in one line what the Engine will make (one Unit of this outcome, for them) and that it costs money from their account, then ask yes or no. Only after their yes, in a later message, call ask_engine with just this confirmationToken.",
    };
  }
  const { outcome, inputs } = resolveAskProposal(token, priorHistory);
  const runId = await deps.openAskRun({ orgId: identity.orgId, userId: identity.userId });
  const body: Record<string, unknown> = {
    units: plainRecord(inputs.units) ? inputs.units : {},
    ...(plainRecord(inputs.request) ? { request: inputs.request } : {}),
    ...(str(inputs.channel) ? { channel: str(inputs.channel) } : {}),
  };
  const out = await deps.makeUnit(outcome, body, { "x-org-id": identity.orgId, "x-user-id": identity.userId, "x-run-id": runId });
  const data = plainRecord(out.data) ? out.data : { body: out.data };
  if (out.status >= 200 && out.status < 300) {
    const pick = plainRecord(data.pick) ? data.pick : {};
    return {
      ran: true,
      outcome,
      status: data.status ?? null,
      // workflow-service's RunScriptResponse: `unit` = {outcome, subject, content} when made; `error` = why not
      // (an `unmade` status is the world's answer, e.g. a page already held); any `answer` it carries is handed on.
      unit: compactAnswer(data.unit ?? null),
      ...(data.status === "made" ? {} : { why: cut(data.error, 600) }),
      ...(data.answer !== undefined ? { answer: compactAnswer(data.answer) } : {}),
      script: pick.dynasty ? `${String(pick.dynasty)} v${String(pick.version ?? "?")}` : null,
      runId: data.runId ?? runId,
    };
  }
  // A refusal in workflow-service's own words: nothing was made (a 502 with `details` = the script ran and failed).
  return { ran: true, outcome, refused: true, httpStatus: out.status, code: data.code ?? null, error: cut(data.error, 600), runId };
}

// --- Production deps --------------------------------------------------------

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} not configured: Outcomes cannot be read or asked`);
  return v.replace(/\/$/, "");
}

export function outcomeDepsFromEnv(identity: { orgId: string; userId: string }, openAskRun: OutcomeDeps["openAskRun"], env: NodeJS.ProcessEnv = process.env): OutcomeDeps {
  const registry = () => ({ url: need(env, "API_REGISTRY_SERVICE_URL"), key: need(env, "API_REGISTRY_SERVICE_API_KEY") });
  const workflow = () => ({ url: need(env, "WORKFLOW_SERVICE_URL"), key: need(env, "WORKFLOW_SERVICE_API_KEY") });
  return {
    async listServices() {
      const { url, key } = registry();
      const res = await fetch(`${url}/services`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`api-registry services ${res.status}`);
      const body = (await res.json()) as { services?: Array<{ name?: unknown }> };
      if (!Array.isArray(body.services)) throw new Error("api-registry answered no services list");
      return body.services.map((s) => String(s.name ?? "")).filter(Boolean);
    },
    async fetchSpec(service) {
      const { url, key } = registry();
      const res = await fetch(`${url}/openapi/${encodeURIComponent(service)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    },
    async callService(service, req) {
      // SSRF-1127: a param value like ".." would walk the documented read onto another route of that service.
      assertSafeRoutePath(req.path);
      const { url, key } = registry();
      const res = await fetch(`${url}/call/${encodeURIComponent(service)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "x-org-id": identity.orgId, "x-user-id": identity.userId },
        body: JSON.stringify({ method: req.method, path: req.path, ...(req.body !== undefined ? { body: req.body } : {}), headers: req.headers }),
        signal: AbortSignal.timeout(35_000),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`api-registry call ${service} ${res.status}: ${raw.slice(0, 300)}`);
      return JSON.parse(raw) as { status: number; ok: boolean; data: unknown };
    },
    async listEngines(orgId) {
      const { url, key } = workflow();
      const res = await fetch(`${url}/internal/engines?orgId=${encodeURIComponent(orgId)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`workflow-service engine list ${res.status}: ${text.slice(0, 300)}`);
      const engines = (JSON.parse(text) as { engines?: unknown }).engines;
      if (!Array.isArray(engines)) throw new Error(`workflow-service answered no engines: ${text.slice(0, 300)}`);
      return engines as EngineListing[];
    },
    async engineScripts(outcome) {
      const { url, key } = workflow();
      const res = await fetch(`${url}/internal/scripts?outcome=${encodeURIComponent(outcome)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`workflow-service scripts of ${outcome} ${res.status}: ${text.slice(0, 300)}`);
      const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
      if (!Array.isArray(scripts)) throw new Error(`workflow-service answered no scripts: ${text.slice(0, 300)}`);
      return (scripts as Array<Record<string, unknown>>).map((x) => ({
        dynasty: String(x.dynasty ?? ""),
        name: typeof x.name === "string" ? x.name : null,
        description: typeof x.description === "string" ? x.description : null,
        materials: Array.isArray(x.materials) ? x.materials.map(String) : [],
        runnable: x.runnable === true,
      }));
    },
    async makeUnit(outcome, body, headers) {
      const { url, key } = workflow();
      const res = await fetch(`${url}/internal/engines/${encodeURIComponent(outcome)}/make`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(330_000),
      });
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        /* a non-JSON answer is handed back as text */
      }
      return { status: res.status, data };
    },
    openAskRun,
  };
}

/** One production index for the process. */
let productionIndex: ReturnType<typeof createProviderIndex> | null = null;
export function productionProviderIndex(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof createProviderIndex> {
  if (!productionIndex) {
    const deps = outcomeDepsFromEnv({ orgId: "", userId: "" }, async () => {
      throw new Error("no ask from the index");
    }, env);
    productionIndex = createProviderIndex({ listServices: deps.listServices, fetchSpec: deps.fetchSpec });
  }
  return productionIndex;
}
