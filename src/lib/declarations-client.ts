import { STAFF_REQUEST_REPOS, type StaffRequestInput, type StaffRequestResult } from "./staff-requests.js";

// ---------------------------------------------------------------------------
// Copilot declarations — channels, legs and sales paths are created LIVE as
// data (owner rule 2026-10-09), never through a PR. A trigger type is NOT
// declared here: a new trigger is a feature request (request_staff +
// newStepOrTrigger), built with the backend that fires it (owner 2026-10-15).
//
// Owner: features-service `/internal/declarations/*` (staff-only, service key:
// a channel is shared by every client). chat-service calls it directly with
// its own features-service key, never through the gateway, and stamps
// `requestedByOrgId` = the chat's org and `createdBy` = the requester.
//
// A declaration is LIVE the moment it is created, for every customer (owner
// 2026-10-12): no draft, no staff publish step, no "publish it" request. Whether
// a piece can RUN is features-service's served verdict (`runnable`), never a
// staff click. What a declaration CANNOT do on its own, the chat files with the
// team in the same call, so the user never hits a dead end:
//   - a reactive leg on a trigger nothing fires is refused (409
//     `trigger_not_fired`, nothing stored) → a staff request "build the
//     detector" (the service that fires it; campaign-service for the generic
//     delay / poll detectors) and the leg is reported ON HOLD, not as an error.
// ---------------------------------------------------------------------------

export interface DeclarationContext {
  orgId: string;
  userId: string;
}

export type FileStaffRequest = (input: StaffRequestInput) => Promise<StaffRequestResult>;

export class DeclarationRefusedError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly reason: string | null,
    public readonly body: string,
  ) {
    super(`[declarations] ${operation} refused by features-service (${status}${reason ? ` ${reason}` : ""}): ${body}`);
    this.name = "DeclarationRefusedError";
  }
}

export async function features(
  operation: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const url = process.env.FEATURES_SERVICE_URL;
  const key = process.env.FEATURES_SERVICE_API_KEY;
  if (!url || !key) throw new Error("FEATURES_SERVICE_URL / FEATURES_SERVICE_API_KEY not configured");
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "x-api-key": key, ...(extraHeaders ?? {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    let reason: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { reason?: unknown };
      if (typeof parsed.reason === "string") reason = parsed.reason;
    } catch {
      // not JSON: the raw body is carried in the error as is
    }
    throw new DeclarationRefusedError(operation, res.status, reason, raw || "no body");
  }
  return raw ? (JSON.parse(raw) as unknown) : {};
}

function str(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`[declarations] ${name} is required`);
  return value.trim();
}

function optStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const enc = encodeURIComponent;
export const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Fields the Copilot may set on a create; everything else is refused here (never forwarded). */
function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

const provenance = (ctx: DeclarationContext) => ({ createdBy: ctx.userId, requestedByOrgId: ctx.orgId });

// --- Reads (free; coded + declared, each with published / visibleToClients) --

export const listDeclaredChannels = (a: Record<string, unknown>) => {
  const slug = optStr(a.slug);
  return slug
    ? features("list_declared_channels", "GET", `/internal/declarations/channels/${enc(slug)}`)
    : features("list_declared_channels", "GET", "/internal/declarations/channels");
};

export const listDeclaredLegs = (a: Record<string, unknown>) => {
  const channelSlug = optStr(a.channelSlug);
  return features(
    "list_declared_legs",
    "GET",
    `/internal/declarations/legs${channelSlug ? `?channelSlug=${enc(channelSlug)}` : ""}`,
  );
};

export const listTriggerTypes = (a: Record<string, unknown>) => {
  const id = optStr(a.triggerId);
  return id
    ? features("list_trigger_types", "GET", `/internal/declarations/trigger-types/${enc(id)}`)
    : features("list_trigger_types", "GET", "/internal/declarations/trigger-types");
};

export const listDeclaredSalesPaths = (a: Record<string, unknown>) => {
  const key = optStr(a.combinationKey);
  return key
    ? features("list_declared_sales_paths", "GET", `/internal/declarations/sales-paths/${enc(key)}`)
    : features("list_declared_sales_paths", "GET", "/internal/declarations/sales-paths");
};

// --- Staff requests for what a declaration cannot do itself -------------------

export interface HeldPiece {
  piece: string;
  waitingFor: "trigger_detector";
  staffRequest: StaffRequestResult;
}

export const ON_HOLD_INSTRUCTION =
  "Tell the user plainly: this piece is created and on hold with the team (it goes live for them once staff does the step named in waitingFor). It is NOT an error. Then carry on with the rest of their request.";

export interface TriggerTypeLite {
  id: string;
  kind?: string;
  firedBy?: string;
  params?: Record<string, unknown> | null;
  label?: string;
}

/**
 * The missing piece behind a trigger nothing fires. A `delay` / `poll` trigger
 * waits on ONE generic detector per kind (campaign-service): one build
 * unblocks every trigger of that kind, so the request is keyed on the kind.
 * An `event` trigger waits on the service that detects that event (`firedBy`
 * when it names a fleet repo, else campaign-service, which owns the door every
 * trigger event goes through), keyed on the trigger.
 */
export function detectorRequest(trigger: TriggerTypeLite, userRequest: string, context: string): StaffRequestInput {
  const kind = trigger.kind ?? "event";
  const generic = kind === "delay" || kind === "poll";
  const repo =
    !generic && trigger.firedBy && (STAFF_REQUEST_REPOS as readonly string[]).includes(trigger.firedBy)
      ? trigger.firedBy
      : "campaign-service";
  const pieceKey = generic ? `${kind}-trigger-detector` : `fire-${kebab(trigger.id)}-trigger`;
  const title = generic
    ? `Generic ${kind} trigger detector (unblocks ${trigger.id})`
    : `Fire the ${trigger.id} trigger`;
  const missingPiece = generic
    ? `Nothing fires \`${kind}\` triggers yet. Trigger \`${trigger.id}\` (params ${JSON.stringify(trigger.params ?? null)}) is declared but not coded, so features-service refuses any reactive leg on it (409 trigger_not_fired). Needed: the generic ${kind} detector in campaign-service, then \`${kind}\` added to features-service GENERIC_DETECTOR_KINDS.`
    : `Nothing fires trigger \`${trigger.id}\` today, so features-service refuses any reactive leg on it (409 trigger_not_fired). Needed: a detector that rings campaign-service with this event.`;
  return {
    kind: "feature",
    repo,
    pieceKey,
    title,
    userRequest,
    missingPiece,
    decomposition: [
      { piece: context, outcome: "needs_code", detail: `waits on a detector for trigger ${trigger.id} (${kind})` },
    ],
  };
}

// --- Writes -------------------------------------------------------------------

const CHANNEL_FIELDS = [
  "slug",
  "name",
  "description",
  "shortDescription",
  "icon",
  "channelType",
  "operatedBy",
  "performedBy",
  "dailyOperatingCostCents",
  "minimumCommitmentDays",
  "maxDaysToFirstProduction",
] as const;

/** POST /internal/declarations/channels: the channel is live once created. */
export async function declareChannel(a: Record<string, unknown>, ctx: DeclarationContext) {
  const channel = (await features("declare_channel", "POST", "/internal/declarations/channels", {
    ...pick(a, CHANNEL_FIELDS),
    ...provenance(ctx),
  })) as { slug: string };
  return { status: "declared", channel };
}

/**
 * POST /internal/declarations/channels/:slug/legs, live once created.
 * `trigger_not_fired` → detector request, the leg
 * reported on hold (nothing was stored by features-service). Every other
 * refusal propagates as an error the model reads.
 */
export async function declareLeg(a: Record<string, unknown>, ctx: DeclarationContext, file: FileStaffRequest) {
  const userRequest = str("userRequest", a.userRequest);
  const channelSlug = str("channelSlug", a.channelSlug);
  const body = {
    fromStep: a.fromStep ?? null,
    toStep: a.toStep,
    mode: a.mode,
    ...(a.triggerId !== undefined && a.triggerId !== null ? { triggerId: a.triggerId } : {}),
    ...provenance(ctx),
  };
  let created: { leg: { legKey: string }; channel: { slug: string } };
  try {
    created = (await features("declare_leg", "POST", `/internal/declarations/channels/${enc(channelSlug)}/legs`, body)) as typeof created;
  } catch (err) {
    if (err instanceof DeclarationRefusedError && err.reason === "trigger_not_fired") {
      const triggerId = str("triggerId", a.triggerId);
      const trigger = (await features("declare_leg:read_trigger", "GET", `/internal/declarations/trigger-types/${enc(triggerId)}`)) as TriggerTypeLite;
      const staffRequest = await file(
        detectorRequest(trigger, userRequest, `Reactive leg ${String(a.fromStep)} → ${String(a.toStep)} on ${channelSlug}, run by ${triggerId}`),
      );
      return {
        status: "on_hold",
        reason: "trigger_not_fired",
        detail: `Nothing fires trigger ${triggerId} yet, so the leg was NOT created. The team was asked to build its detector; once it runs, declare this leg again.`,
        trigger,
        onHold: [{ piece: `leg on ${channelSlug} run by ${triggerId}`, waitingFor: "trigger_detector", staffRequest }] satisfies HeldPiece[],
        instruction: ON_HOLD_INSTRUCTION,
      };
    }
    throw err;
  }
  return { status: "declared", ...created };
}

/** POST /internal/declarations/sales-paths: the path is live once created. */
export async function declareSalesPath(a: Record<string, unknown>, ctx: DeclarationContext) {
  const salesPath = await features("declare_sales_path", "POST", "/internal/declarations/sales-paths", {
    legs: a.legs,
    ...provenance(ctx),
  });
  return { status: "declared", salesPath };
}
