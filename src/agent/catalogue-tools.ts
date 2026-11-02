// ---------------------------------------------------------------------------
// find_operation / describe_operation / run_operation: Sophie's reach into everything the
// gateway serves (SOPHIE-REFONTE-1102 P2), the three meta-tools the MCP gives
// an outside AI, so both act through the same surface.
//
// run_operation acts AS THE PERSON (their org and user, chat-service's gateway
// client) and only on an operation of the public document: a staff-only,
// internal or unknown operation is refused before any request.
//
// The yes before anything spends, starts or sends: the gateway marks those
// operations in its served document (YES_MARKER). run_operation answers such an
// operation with a proposal and a token instead of calling it; in a LATER
// turn (after the person's message) run_operation with that token runs exactly the
// request that was proposed, never the model's new arguments. Same structural
// guarantee as propose_switch_on / confirm_switch_on.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { apiServiceFetch, type ApiCallParams } from "../lib/api-client.js";
import { COPILOT_TOOL_API_OPS } from "../lib/skill-api-ops.js";
import { findOperation, getCatalog, isPlatformInternal, matchPath, resolveSchema, searchOperations, type CatalogOperation } from "./catalogue.js";

export const FIND_API_TOOL_NAME = "find_operation";
export const DESCRIBE_API_TOOL_NAME = "describe_operation";
export const CALL_API_TOOL_NAME = "run_operation";
export const CATALOGUE_TOOL_NAMES = [FIND_API_TOOL_NAME, DESCRIBE_API_TOOL_NAME, CALL_API_TOOL_NAME] as const;

/**
 * The extension the gateway sets on an operation that spends, starts work or
 * sends (api-service SOPHIE-YES-GATE-1102, served shape): `{ because: string[],
 * why: string, notNeededWhen?: Array<Record<string, unknown>> }`. An entry of
 * `notNeededWhen` matches when every key equals the body's top-level field (a
 * campaign created `status: "stopped"`): such a call needs no yes.
 */
export const YES_MARKER = "x-needs-user-yes";

interface YesMarker {
  because?: string[];
  why?: string;
  notNeededWhen?: Array<Record<string, unknown>>;
}

/** Tool results stay small (owner rule: no tool result above ~2k tokens). */
const MAX_RESULT_CHARS = 8_000;
const MAX_SCHEMA_CHARS = 6_000;

const clip = (v: unknown, max: number): unknown => {
  const s = JSON.stringify(v);
  return s.length <= max ? v : { truncated: true, firstChars: s.slice(0, max), note: "Narrow the request (a filter, a limit, one id) to read the rest." };
};

export const CATALOGUE_TOOLS: Anthropic.Tool[] = [
  {
    name: FIND_API_TOOL_NAME,
    description:
      "Find the distribute.you API operations that do what you need, by intent in plain words (\"stop a campaign\", \"people who replied\", \"spend this week\"). Returns operation ids with their method, path and summary. Everything the client's account can do is in this API. Next: describe_operation on the one you pick.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to do or read, in plain words." },
        tag: { type: "string", description: "Optional: only operations of this tag." },
      },
      required: ["query"],
    },
  },
  {
    name: DESCRIBE_API_TOOL_NAME,
    description:
      "How to call one API operation: its parameters, its request body, what it answers, and whether it needs the person's yes before it runs. call it before run_operation on an operation you have not used in this conversation.",
    input_schema: {
      type: "object",
      properties: { operationId: { type: "string", description: "From find_operation." } },
      required: ["operationId"],
    },
  },
  {
    name: CALL_API_TOOL_NAME,
    description:
      "Call one API operation on the client's account, as them. An operation that spends money, starts work or sends something answers with a proposal and a confirmationToken instead of running: show the person exactly what will happen and ask yes or no; only after their yes, in a later message, call run_operation again with just that confirmationToken (it runs exactly what was proposed).",
    input_schema: {
      type: "object",
      properties: {
        operationId: { type: "string", description: "From find_operation / describe_operation." },
        method: { type: "string", description: "Instead of operationId: GET, POST, PUT, PATCH or DELETE, with path." },
        path: { type: "string", description: "Instead of operationId: the concrete path, ids filled in (/v1/billing/accounts)." },
        pathParams: { type: "object", description: "Values for the {placeholders} in the path." },
        query: { type: "object", description: "Query parameters (brandId, offerId, filters, limit)." },
        body: { type: "object", description: "The JSON request body, as describe_operation states it." },
        confirmationToken: { type: "string", description: "Only after the person said yes to a proposal from an earlier message." },
      },
    },
  },
];

function yesMarker(op: CatalogOperation): YesMarker | null {
  const m = op.extensions?.[YES_MARKER];
  return m && typeof m === "object" ? (m as YesMarker) : null;
}

/** Whether calling `op` with `body` needs the person's yes (the gateway's marker, its harmless cases excepted). */
export function needsYes(op: CatalogOperation, body?: unknown): boolean {
  const m = yesMarker(op);
  if (!m) return false;
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const harmless = (m.notNeededWhen ?? []).some((entry) => Object.entries(entry).every(([k, v]) => JSON.stringify(b[k]) === JSON.stringify(v)));
  return !harmless;
}

export async function findApi(args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.query !== "string" || !args.query.trim()) throw new Error("[find_operation] query is required");
  const { operations } = await getCatalog();
  const hits = searchOperations(operations, args.query, 8, typeof args.tag === "string" ? args.tag : undefined);
  return {
    operations: hits.map((h) => ({ operationId: h.operationId, method: h.method, path: h.path, summary: h.summary, required: h.required })),
    ...(hits.length === 0 ? { note: "Nothing matched: try other words for the same act." } : {}),
  };
}

export async function describeApi(args: Record<string, unknown>): Promise<unknown> {
  const { operations, components } = await getCatalog();
  const op = findOperation(operations, { operationId: String(args.operationId ?? "") });
  if (!op) throw new Error(`[describe_operation] no operation "${String(args.operationId)}": use find_operation`);
  return {
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    summary: op.summary,
    description: op.description.slice(0, 1500),
    params: op.params,
    body: op.hasBody ? clip(resolveSchema(op.bodySchema, components, 3), MAX_SCHEMA_CHARS) : null,
    answers: op.successResponses.map((r) => ({ status: r.status, description: r.description, schema: clip(resolveSchema(r.schema, components, 2), MAX_SCHEMA_CHARS) })),
    needsTheirYes: yesMarker(op)
      ? { why: yesMarker(op)!.why ?? null, because: yesMarker(op)!.because ?? [], notNeededWhen: yesMarker(op)!.notNeededWhen ?? [] }
      : false,
  };
}

interface PreparedRequest {
  operationId: string;
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

function prepare(op: CatalogOperation, args: Record<string, unknown>): PreparedRequest {
  const pathParams = (args.pathParams ?? {}) as Record<string, unknown>;
  const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = pathParams[name];
    if (v === undefined || v === null || String(v).trim() === "") throw new Error(`[run_operation] pathParams.${name} is required for ${op.operationId}`);
    return encodeURIComponent(String(v));
  });
  const query = Object.fromEntries(
    Object.entries((args.query ?? {}) as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
  return { operationId: op.operationId, method: op.method, path, query, body: args.body };
}

async function send(req: PreparedRequest, params: ApiCallParams): Promise<unknown> {
  const qs = new URLSearchParams(req.query).toString();
  const res = await apiServiceFetch(`${req.path}${qs ? `?${qs}` : ""}`, req.method, params, req.method === "GET" ? undefined : (req.body ?? {}));
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // a non-JSON answer is returned as text
  }
  if (!res.ok) return { ok: false, status: res.status, error: clip(data, 2_000) };
  return { ok: true, status: res.status, data: clip(data, MAX_RESULT_CHARS) };
}

export class CallApiConfirmationError extends Error {}

interface HistoryMessage {
  toolCalls: Array<{ name: string; args?: Record<string, unknown>; result?: unknown }> | null;
}

/** The proposal behind a token, from the history BEFORE this turn's message (a user message always sits in between). */
export function resolveCallApiProposal(token: string, priorHistory: readonly HistoryMessage[]): PreparedRequest {
  let proposed: PreparedRequest | null = null;
  for (const m of priorHistory) {
    for (const tc of m.toolCalls ?? []) {
      if (tc.name !== CALL_API_TOOL_NAME) continue;
      const r = tc.result as { confirmationToken?: string; request?: PreparedRequest; ok?: boolean } | undefined;
      if (r?.confirmationToken === token && r.request) proposed = r.request;
      if (tc.args?.confirmationToken === token && r?.ok === true) throw new CallApiConfirmationError("This confirmationToken was already used: that action already ran.");
    }
  }
  if (!proposed) throw new CallApiConfirmationError("Unknown confirmationToken for this conversation: call run_operation without it, show the person the proposal, and wait for their yes.");
  return proposed;
}

export async function callApi(
  args: Record<string, unknown>,
  params: ApiCallParams,
  priorHistory: readonly HistoryMessage[],
): Promise<unknown> {
  if (typeof args.confirmationToken === "string" && args.confirmationToken.trim()) {
    const req = resolveCallApiProposal(args.confirmationToken.trim(), priorHistory);
    return send(req, params);
  }
  const { operations } = await getCatalog();
  const byId = findOperation(operations, { operationId: String(args.operationId ?? "") });
  const concretePath = typeof args.path === "string" ? args.path.split("?")[0] : null;
  const fit = !byId && concretePath ? matchPath(operations, String(args.method ?? "GET"), concretePath) : null;
  const op = byId ?? fit?.operation ?? null;
  if (!op) {
    const known = operationsForTool(String(args.operationId ?? ""), operations);
    throw new Error(
      `[run_operation] no operation "${String(args.operationId ?? `${String(args.method ?? "GET")} ${concretePath ?? ""}`)}" in the client API: ` +
        (known.length ? `that act is ${known.map((o) => `${o.operationId} (${o.method} ${o.path})`).join(" or ")}` : "use find_operation"),
    );
  }
  if (op.staffOnly || isPlatformInternal(op.path)) throw new Error(`[run_operation] ${op.operationId} is not a client operation`);
  const req = byId || !concretePath ? prepare(op, args) : { ...prepare(op, { ...args, pathParams: pathParamsFrom(op.path, concretePath) }) };
  if (needsYes(op, req.body)) {
    return {
      yesRequired: true,
      why: yesMarker(op)?.why ?? null,
      confirmationToken: randomUUID(),
      request: req,
      instruction:
        "Nothing ran. Tell the person in plain words exactly what this will do (what starts, spends or is sent, to whom, how much) and ask yes or no. Only after their yes, in a later message, call run_operation with just this confirmationToken.",
    };
  }
  return send(req, params);
}

/** The {placeholders} of a template read back from a concrete path that fits it. */
function pathParamsFrom(template: string, concrete: string): Record<string, string> {
  const t = template.split("/");
  const c = concrete.split("/");
  return Object.fromEntries(t.flatMap((seg, i) => (/^\{[^}]+\}$/.test(seg) ? [[seg.slice(1, -1), decodeURIComponent(c[i] ?? "")]] : [])));
}

const normPath = (path: string) => path.replace(/\{[^}]+\}/g, "{}");

/** The chat tools that do what a gateway operation does (skill-api-ops.ts). */
export function toolsForOperation(method: string, path: string): string[] {
  const target = normPath(path);
  return Object.entries(COPILOT_TOOL_API_OPS)
    .filter(([, frags]) =>
      frags.some((f) => {
        const m = /^(GET|POST|PUT|PATCH|DELETE) (.+)$/.exec(f);
        const fp = normPath(m?.[2] ?? f);
        return fp.startsWith("/") && (!m?.[1] || m[1] === method) && (target === fp || target.endsWith(fp));
      }),
    )
    .map(([tool]) => tool);
}

/** The operations doing what an earlier chat tool did (a conversation from before P2 names those tools). */
export function operationsForTool(tool: string, operations: readonly CatalogOperation[]): CatalogOperation[] {
  if (!COPILOT_TOOL_API_OPS[tool]) return [];
  return operations.filter((o) => toolsForOperation(o.method, o.path).includes(tool)).slice(0, 2);
}
