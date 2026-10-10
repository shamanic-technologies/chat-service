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

/** One level: a page (filters) or one object (`id`). */
function level(tool: string, path: Level, filters: Record<string, (v: unknown) => string | null>) {
  return async (a: Record<string, unknown>): Promise<unknown> => {
    const id = optStr("id", a.id);
    const extra: Record<string, string | number | null> = {};
    for (const [k, read] of Object.entries(filters)) extra[k] = read(a[k]);
    if (id) {
      // A detail read keeps only the filters the owner reads there (`pipe` for workflows).
      const detailQs = path === "workflows" ? qs({ pipe: extra.pipe ?? null }) : "";
      return features(tool, "GET", `/internal/catalogue/${path}/${enc(id)}${detailQs}`);
    }
    return features(tool, "GET", `/internal/catalogue/${path}${qs({ ...extra, q: optStr("q", a.q), limit: optLimit(a.limit) })}`);
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
export const findWorkflows = async (a: Record<string, unknown>): Promise<unknown> => {
  reqStr("pipe", a.pipe);
  return findWorkflowsRaw(a);
};

export const CATALOGUE_READ_TOOLS: Record<string, (a: Record<string, unknown>) => Promise<unknown>> = {
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
export async function createPipe(a: Record<string, unknown>, ctx: DeclarationContext, file: FileStaffRequest) {
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
export async function createSalesFunnel(a: Record<string, unknown>, ctx: DeclarationContext, file: FileStaffRequest) {
  const userRequest = reqStr("userRequest", a.userRequest);
  const funnel = (await features("create_sales_funnel", "POST", "/internal/catalogue/sales-funnels", {
    pipeIds: stringArray("pipeIds", a.pipeIds),
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
  (a: Record<string, unknown>, ctx: DeclarationContext, file: FileStaffRequest) => Promise<unknown>
> = {
  create_step: (a, ctx) => createStep(a, ctx),
  create_pipe: createPipe,
  create_sales_path: (a, ctx) => createSalesPath(a, ctx),
  create_sales_funnel: createSalesFunnel,
};
