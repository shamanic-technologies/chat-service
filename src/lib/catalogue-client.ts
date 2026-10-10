import { assertNotMixed } from "./funnel-mix.js";
import {
  DeclarationRefusedError,
  ON_HOLD_INSTRUCTION,
  detectorRequest,
  features,
  fileLegPublish,
  type DeclarationContext,
  type FileStaffRequest,
  type HeldPiece,
  type TriggerTypeLite,
} from "./declarations-client.js";

// ---------------------------------------------------------------------------
// Agent CATALOGUE ("chat first", owner 2026-10-10). The Copilot organizes a
// request by walking, in order, small lists of:
//   Steps -> Sales Paths -> Channels -> Pipes -> Sales Funnels -> Workflows
// Owner: features-service `/internal/catalogue/*` (service key, fleet grain,
// no identity). One tool per level, never a catch-all: each returns a page of
// at most 25 rows (id, name, icon, one line, costUsd, roi, status), or ONE
// object in detail when `id` is given. Bodies are returned verbatim — the
// owner owns the shape and the figures, the model quotes them.
//
// Creates stamp `createdBy` = the requester and `requestedByOrgId` = the chat's
// org. What a create cannot finish itself is filed with the team in the same
// call (an unpublished pipe -> "publish it"; a reactive pipe on a trigger
// nothing fires -> "build the detector") and reported ON HOLD, never thrown.
// ---------------------------------------------------------------------------

export const CATALOGUE_MAX_LIMIT = 25;

/**
 * Who reads. The Copilot is a CUSTOMER surface: by default every list is
 * `runnable=true` (what we run today, features-service) and a detail read of
 * something we do not run answers NOT_RUN_TODAY instead of its body (owner
 * rule 2026-10-10: never present a channel we do not run; prod: the Copilot
 * offered LinkedIn posting, which campaign-service refuses with 409
 * no_workflow). `includeNotRunnable: true` shows everything, staff only.
 */
export interface CatalogueReader {
  isStaff: () => Promise<boolean>;
}

export const NOT_RUN_TODAY = {
  runnable: false,
  weRunItToday: false,
  instruction:
    "We do not run this today. Tell the user so in one plain sentence, offer what we do run (the find_* lists show only that), and if they want it anyway, file request_staff (kind feature). Never describe its terms, price or how it would work.",
} as const;

/**
 * The declaration tools (list_declared_*, list_trigger_types, declare_*) build
 * what we do not run yet: staff only, and only when the call says so
 * (`staffBuild: true`, set when the person explicitly asked to build it).
 */
export async function assertStaffBuild(tool: string, a: Record<string, unknown>, reader: CatalogueReader): Promise<void> {
  if (a.staffBuild !== true) {
    throw new CatalogueArgError(
      `${tool} builds what we do not run yet: only when a staff member explicitly asked to build it (staffBuild: true). For a customer, use the find_* tools (what we run today) and request_staff (kind feature) for the rest.`,
    );
  }
  if (!(await reader.isStaff())) {
    throw new CatalogueArgError(`${tool} is staff only: a customer sees only what we run today (find_* tools); file request_staff (kind feature) for the rest.`);
  }
}

/** Lists filtered to what we run today unless a staff reader asked for everything. */
async function wantsEverything(a: Record<string, unknown>, reader: CatalogueReader): Promise<boolean> {
  if (a.includeNotRunnable !== true) return false;
  if (!(await reader.isStaff())) {
    throw new CatalogueArgError("includeNotRunnable is for staff only: a customer sees only what we run today");
  }
  return true;
}

export class CatalogueArgError extends Error {
  constructor(message: string) {
    super(`[catalogue] ${message}`);
    this.name = "CatalogueArgError";
  }
}

const enc = encodeURIComponent;

function optStr(name: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new CatalogueArgError(`${name} must be a string`);
  const t = v.trim();
  return t === "" ? null : t;
}

function reqStr(name: string, v: unknown): string {
  const s = optStr(name, v);
  if (!s) throw new CatalogueArgError(`${name} is required`);
  return s;
}

/** A list filter: an array of strings (or one comma-joined string), sent comma-joined. */
function optList(name: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!items || items.some((x) => typeof x !== "string")) throw new CatalogueArgError(`${name} must be a list of ids`);
  const clean = (items as string[]).map((x) => x.trim()).filter(Boolean);
  return clean.length ? clean.join(",") : null;
}

function optLimit(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > CATALOGUE_MAX_LIMIT) {
    throw new CatalogueArgError(`limit must be a whole number from 1 to ${CATALOGUE_MAX_LIMIT} (keep pages small)`);
  }
  return n;
}

function qs(params: Record<string, string | number | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

type Level = "steps" | "sales-paths" | "channels" | "pipes" | "sales-funnels" | "workflows";

/**
 * Every cost the model reads carries its unit IN the same field: a row with a
 * `costUsd` gets `cost: "$137.43 per positive reply"` built from the
 * producer's own `costPer` (features-service). Prod 2026-10-10: a per-reply
 * cost was quoted "per paying client" because the unit lived on the list.
 * A cost served WITHOUT its unit is a broken producer contract: fail loud.
 */
export function withCostUnits(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withCostUnits);
  if (!value || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof o.costUsd === "number") {
    if (typeof o.costPer !== "string" || o.costPer.trim() === "") {
      throw new Error(`[catalogue] features-service served a cost without its unit (costPer) on ${String(o.id ?? "a row")}`);
    }
    // An estimate says so in the same field (features-service `status: estimated`,
    // owner 2026-10-10: never present an estimate as measured).
    out.cost = `$${o.costUsd} ${o.costPer}${o.status === "estimated" ? " (estimated)" : ""}`;
  }
  if (typeof o.roi === "number") {
    if (o.roiBasis !== "measured" && o.roiBasis !== "estimated") {
      throw new Error(`[catalogue] features-service served a return without its basis (roiBasis) on ${String(o.id ?? "a row")}`);
    }
    out.return = `${o.roi}x (${o.roiBasis})`;
  }
  for (const [k, v] of Object.entries(o)) out[k] = withCostUnits(v);
  return out;
}

/** Levels whose objects can be run or not (features-service `runnable`). */
const RUNNABLE_LEVELS: ReadonlySet<Level> = new Set(["sales-paths", "channels", "pipes", "sales-funnels"]);

/** One level: a page (filters) or one object (`id`). */
function level(tool: string, path: Level, filters: Record<string, (v: unknown) => string | null>) {
  return async (a: Record<string, unknown>, reader: CatalogueReader): Promise<unknown> => {
    const id = optStr("id", a.id);
    const extra: Record<string, string | number | null> = {};
    for (const [k, read] of Object.entries(filters)) extra[k] = read(a[k]);
    const gated = RUNNABLE_LEVELS.has(path) && !(await wantsEverything(a, reader));
    if (id) {
      // A detail read keeps only the filters the owner reads there (`pipe` for workflows).
      const detailQs = path === "workflows" ? qs({ pipe: extra.pipe ?? null }) : "";
      const body = (await features(tool, "GET", `/internal/catalogue/${path}/${enc(id)}${detailQs}`)) as { runnable?: unknown; name?: unknown };
      if (gated && body.runnable === false) return { id, ...NOT_RUN_TODAY };
      return withCostUnits(body);
    }
    return withCostUnits(
      await features(
        tool,
        "GET",
        `/internal/catalogue/${path}${qs({ ...extra, ...(gated ? { runnable: "true" } : {}), q: optStr("q", a.q), limit: optLimit(a.limit) })}`,
      ),
    );
  };
}

export const findSteps = level("find_steps", "steps", {});
export const findSalesPaths = level("find_sales_paths", "sales-paths", {
  containsSteps: (v) => optList("containsSteps", v),
});
export const findChannels = level("find_channels", "channels", {
  forPaths: (v) => optList("forPaths", v),
  legKeys: (v) => optList("legKeys", v),
});
export const findPipes = level("find_pipes", "pipes", {
  paths: (v) => optList("paths", v),
  channels: (v) => optList("channels", v),
  legKeys: (v) => optList("legKeys", v),
});
export const findSalesFunnels = level("find_sales_funnels", "sales-funnels", {
  paths: (v) => optList("paths", v),
  containsChannels: (v) => optList("containsChannels", v),
});
const findWorkflowsRaw = level("find_workflows", "workflows", { pipe: (v) => optStr("pipe", v) });
/** Workflows are ranked per pipe: the owner refuses a read without one, so do we, before the call. */
export const findWorkflows = async (a: Record<string, unknown>, reader: CatalogueReader): Promise<unknown> => {
  reqStr("pipe", a.pipe);
  return findWorkflowsRaw(a, reader);
};

export const CATALOGUE_READ_TOOLS: Record<string, (a: Record<string, unknown>, reader: CatalogueReader) => Promise<unknown>> = {
  find_steps: findSteps,
  find_sales_paths: findSalesPaths,
  find_channels: findChannels,
  find_pipes: findPipes,
  find_sales_funnels: findSalesFunnels,
  find_workflows: findWorkflows,
};

// --- Creates (data, starts nothing) ------------------------------------------

const provenance = (ctx: DeclarationContext) => ({ createdBy: ctx.userId, requestedByOrgId: ctx.orgId });

function pick(a: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (a[k] !== undefined && a[k] !== null) out[k] = a[k];
  return out;
}

function stringArray(name: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || x.trim() === "")) {
    throw new CatalogueArgError(`${name} must be a non-empty list of ids, in order`);
  }
  return (v as string[]).map((x) => x.trim());
}

const STEP_FIELDS = ["key", "label", "description", "shortDescription", "icon", "towardStep", "towardRatePct", "producedBy"] as const;

/** POST /internal/catalogue/steps — a NEW step (stage a lead can reach). */
export async function createStep(a: Record<string, unknown>, ctx: DeclarationContext) {
  return features("create_step", "POST", "/internal/catalogue/steps", { ...pick(a, STEP_FIELDS), ...provenance(ctx) });
}

interface PipeDetail {
  id: string;
  channelSlug: string;
  legKey: string;
  draft?: boolean;
}

const PIPE_FIELDS = ["channelSlug", "fromStep", "toStep", "mode", "triggerId", "conversionRatePct"] as const;

/**
 * POST /internal/catalogue/pipes — a NEW pipe (one channel x one leg). A draft
 * pipe -> "publish it" filed with the team. A reactive pipe on a trigger
 * nothing fires is refused by the owner (nothing stored) -> "build the
 * detector" filed, reported on hold.
 */
export async function createPipe(a: Record<string, unknown>, ctx: DeclarationContext, file: FileStaffRequest, reader: CatalogueReader) {
  if (!(await reader.isStaff())) {
    throw new CatalogueArgError(
      "a new pipe is a channel we would have to run: staff only. For a customer, say we do not run it today and file request_staff (kind feature) if they want it.",
    );
  }
  const userRequest = reqStr("userRequest", a.userRequest);
  const channelSlug = reqStr("channelSlug", a.channelSlug);
  let pipe: PipeDetail;
  try {
    pipe = (await features("create_pipe", "POST", "/internal/catalogue/pipes", {
      ...pick(a, PIPE_FIELDS),
      channelSlug,
      fromStep: a.fromStep ?? null,
      ...provenance(ctx),
    })) as PipeDetail;
  } catch (err) {
    if (err instanceof DeclarationRefusedError && err.reason === "trigger_not_fired") {
      const triggerId = reqStr("triggerId", a.triggerId);
      const trigger = (await features("create_pipe:read_trigger", "GET", `/internal/declarations/trigger-types/${enc(triggerId)}`)) as TriggerTypeLite;
      const staffRequest = await file(
        detectorRequest(trigger, userRequest, `Reactive pipe ${String(a.fromStep)} → ${String(a.toStep)} on ${channelSlug}, run by ${triggerId}`),
      );
      return {
        status: "on_hold",
        reason: "trigger_not_fired",
        detail: `Nothing fires trigger ${triggerId} yet, so the pipe was NOT created. The team was asked to build its detector; once it runs, create this pipe again.`,
        onHold: [{ piece: `pipe on ${channelSlug} run by ${triggerId}`, waitingFor: "trigger_detector", staffRequest }] satisfies HeldPiece[],
        instruction: ON_HOLD_INSTRUCTION,
      };
    }
    throw err;
  }
  const onHold: HeldPiece[] = pipe.draft ? [await fileLegPublish(pipe.channelSlug, pipe.legKey, userRequest, file)] : [];
  return { status: onHold.length ? "created_on_hold" : "created", pipe, onHold, ...(onHold.length ? { instruction: ON_HOLD_INSTRUCTION } : {}) };
}

/** POST /internal/catalogue/sales-paths — a NEW chain of legs to Paid client (200 `created:false` when it exists). */
export async function createSalesPath(a: Record<string, unknown>, ctx: DeclarationContext) {
  return features("create_sales_path", "POST", "/internal/catalogue/sales-paths", {
    legKeys: stringArray("legKeys", a.legKeys),
    ...provenance(ctx),
  });
}

interface FunnelDetail {
  id: string;
  draft?: boolean;
  legs?: Array<{ legKey: string; pipe: { id: string } | null }>;
}

/**
 * POST /internal/catalogue/sales-funnels — a sales path with one pipe per leg.
 * A funnel is a draft while one of its pipes is: each draft pipe gets the SAME
 * publish request create_pipe files (deduped per org, so a repeat counts).
 */
export async function createSalesFunnel(a: Record<string, unknown>, ctx: DeclarationContext, file: FileStaffRequest, reader: CatalogueReader) {
  const userRequest = reqStr("userRequest", a.userRequest);
  const pipeIds = stringArray("pipeIds", a.pipeIds);
  // One kind per funnel (owner 2026-10-10): never compose proactive and reactive pipes together.
  const pipes = await Promise.all(
    pipeIds
      .filter((p) => p.includes("|"))
      .map(async (id) => ({ id, ...((await features("create_sales_funnel:read_pipe", "GET", `/internal/catalogue/pipes/${enc(id)}`)) as { mode?: unknown; runnable?: unknown }) })),
  );
  assertNotMixed(pipeIds.join("+"), pipes);
  // A customer only gets funnels we can run: every pipe must be runnable (a bare leg key is the buyer or their team).
  if (!(await reader.isStaff())) {
    for (const pipe of pipes) {
      if (pipe.runnable === false) {
        throw new CatalogueArgError(`pipe ${pipe.id} is not something we run today: a customer funnel uses only runnable pipes (find_pipes lists them).`);
      }
    }
  }
  const funnel = (await features("create_sales_funnel", "POST", "/internal/catalogue/sales-funnels", {
    pipeIds,
    ...provenance(ctx),
  })) as FunnelDetail;
  const onHold: HeldPiece[] = [];
  if (funnel.draft) {
    for (const leg of funnel.legs ?? []) {
      if (!leg.pipe) continue;
      const pipe = (await features("create_sales_funnel:read_pipe", "GET", `/internal/catalogue/pipes/${enc(leg.pipe.id)}`)) as PipeDetail;
      if (pipe.draft) onHold.push(await fileLegPublish(pipe.channelSlug, pipe.legKey, userRequest, file));
    }
  }
  return { status: onHold.length ? "created_on_hold" : "created", funnel, onHold, ...(onHold.length ? { instruction: ON_HOLD_INSTRUCTION } : {}) };
}

export const CATALOGUE_WRITE_TOOLS: Record<
  string,
  (a: Record<string, unknown>, ctx: DeclarationContext, file: FileStaffRequest, reader: CatalogueReader) => Promise<unknown>
> = {
  create_step: (a, ctx) => createStep(a, ctx),
  create_pipe: createPipe,
  create_sales_path: (a, ctx) => createSalesPath(a, ctx),
  create_sales_funnel: createSalesFunnel,
};
