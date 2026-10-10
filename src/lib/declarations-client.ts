import { STAFF_REQUEST_REPOS, type StaffRequestInput, type StaffRequestResult } from "./staff-requests.js";

// ---------------------------------------------------------------------------
// Copilot declarations — channels, legs, trigger types and sales paths are
// created LIVE as data (owner rule 2026-10-09), never through a PR.
//
// Owner: features-service `/internal/declarations/*` (staff-only, service key:
// a channel is shared by every client). chat-service calls it directly with
// its own features-service key, never through the gateway, and stamps
// `requestedByOrgId` = the chat's org and `createdBy` = the requester.
//
// What a declaration CANNOT do on its own, the chat files with the team in the
// same call, so the user never hits a dead end:
//   - a channel or leg lands UNPUBLISHED (invisible to every client read until
//     staff publishes it) → a staff request "publish it" (features-service);
//   - a reactive leg on a trigger nothing fires is refused (409
//     `trigger_not_fired`, nothing stored) → a staff request "build the
//     detector" (the service that fires it; campaign-service for the generic
//     delay / poll detectors) and the leg is reported ON HOLD, not as an error.
// The Copilot never publishes: publishing changes what every org can buy.
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

export async function features(operation: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const url = process.env.FEATURES_SERVICE_URL;
  const key = process.env.FEATURES_SERVICE_API_KEY;
  if (!url || !key) throw new Error("FEATURES_SERVICE_URL / FEATURES_SERVICE_API_KEY not configured");
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
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
  waitingFor: "staff_publish" | "trigger_detector";
  staffRequest: StaffRequestResult;
}

export const ON_HOLD_INSTRUCTION =
  "Tell the user plainly: this piece is created and on hold with the team (it goes live for them once staff does the step named in waitingFor). It is NOT an error. Then carry on with the rest of their request.";

function publishRequest(kindLabel: string, pieceKey: string, title: string, userRequest: string, what: string): StaffRequestInput {
  return {
    kind: "feature",
    repo: "features-service",
    pieceKey,
    title,
    userRequest,
    missingPiece: `${what} was declared by the Copilot and is UNPUBLISHED: no client sees it until staff reviews and publishes it (PATCH /internal/declarations/... { published: true }).`,
    decomposition: [
      { piece: `Declare the ${kindLabel}`, outcome: "create", detail: "done by the Copilot, unpublished" },
      { piece: `Publish the ${kindLabel} to clients`, outcome: "needs_code", detail: "staff action in features-service" },
    ],
  };
}

async function fileChannelPublish(slug: string, userRequest: string, file: FileStaffRequest): Promise<HeldPiece> {
  const staffRequest = await file(
    publishRequest("channel", `publish-channel-${kebab(slug)}`, `Publish declared channel ${slug}`, userRequest, `Channel \`${slug}\``),
  );
  return { piece: `channel ${slug}`, waitingFor: "staff_publish", staffRequest };
}

export async function fileLegPublish(slug: string, legKey: string, userRequest: string, file: FileStaffRequest): Promise<HeldPiece> {
  const staffRequest = await file(
    publishRequest(
      "leg",
      `publish-leg-${kebab(slug)}-${kebab(legKey)}`.slice(0, 80).replace(/-+$/, ""),
      `Publish declared leg ${legKey} on ${slug}`,
      userRequest,
      `Leg \`${legKey}\` on channel \`${slug}\` (a leg reaches clients only once its channel is published too)`,
    ),
  );
  return { piece: `leg ${legKey} on ${slug}`, waitingFor: "staff_publish", staffRequest };
}

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

/** POST /internal/declarations/channels → unpublished channel + staff request "publish it". */
export async function declareChannel(a: Record<string, unknown>, ctx: DeclarationContext, file: FileStaffRequest) {
  const userRequest = str("userRequest", a.userRequest);
  const channel = (await features("declare_channel", "POST", "/internal/declarations/channels", {
    ...pick(a, CHANNEL_FIELDS),
    ...provenance(ctx),
  })) as { slug: string; published?: boolean };
  const onHold: HeldPiece[] = channel.published ? [] : [await fileChannelPublish(channel.slug, userRequest, file)];
  return { status: onHold.length ? "declared_on_hold" : "declared", channel, onHold, ...(onHold.length ? { instruction: ON_HOLD_INSTRUCTION } : {}) };
}

/**
 * POST /internal/declarations/channels/:slug/legs. Unpublished leg (or its
 * channel) → publish request. `trigger_not_fired` → detector request, the leg
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
  let created: { leg: { legKey: string; published?: boolean }; channel: { slug: string; published?: boolean } };
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
  const onHold: HeldPiece[] = [];
  if (created.channel.published === false) onHold.push(await fileChannelPublish(created.channel.slug, userRequest, file));
  if (created.leg.published === false) onHold.push(await fileLegPublish(created.channel.slug, created.leg.legKey, userRequest, file));
  return { status: onHold.length ? "declared_on_hold" : "declared", ...created, onHold, ...(onHold.length ? { instruction: ON_HOLD_INSTRUCTION } : {}) };
}

/** POST /internal/declarations/trigger-types. Not coded → detector request (same piece key a refused leg files). */
export async function declareTriggerType(a: Record<string, unknown>, ctx: DeclarationContext, file: FileStaffRequest) {
  const userRequest = str("userRequest", a.userRequest);
  const trigger = (await features("declare_trigger_type", "POST", "/internal/declarations/trigger-types", {
    ...pick(a, ["id", "label", "description", "icon", "kind", "fromStep", "firedBy", "params"]),
    ...provenance(ctx),
  })) as TriggerTypeLite & { coded?: boolean };
  const onHold: HeldPiece[] = [];
  if (trigger.coded === false) {
    const staffRequest = await file(detectorRequest(trigger, userRequest, `Trigger type ${trigger.id}`));
    onHold.push({ piece: `trigger ${trigger.id}`, waitingFor: "trigger_detector", staffRequest });
  }
  return {
    status: onHold.length ? "declared_on_hold" : "declared",
    trigger,
    onHold,
    ...(onHold.length
      ? { instruction: `${ON_HOLD_INSTRUCTION} No reactive leg can name this trigger until its detector runs (declare_leg on it is put on hold the same way).` }
      : {}),
  };
}

interface SalesPathLegView {
  channelSlug: string;
  legKey: string;
  visibleToClients?: boolean;
}

/**
 * POST /internal/declarations/sales-paths. A path has no publish flag of its
 * own: it is visible once every leg (and channel) is. Each invisible leg gets
 * the SAME publish request a leg declaration files (deduped per org).
 */
export async function declareSalesPath(a: Record<string, unknown>, ctx: DeclarationContext, file: FileStaffRequest) {
  const userRequest = str("userRequest", a.userRequest);
  const salesPath = (await features("declare_sales_path", "POST", "/internal/declarations/sales-paths", {
    legs: a.legs,
    ...provenance(ctx),
  })) as { combinationKey: string; visibleToClients?: boolean; legs?: SalesPathLegView[] };
  const onHold: HeldPiece[] = [];
  if (salesPath.visibleToClients === false) {
    for (const l of salesPath.legs ?? []) {
      if (l.visibleToClients === false) onHold.push(await fileLegPublish(l.channelSlug, l.legKey, userRequest, file));
    }
  }
  return { status: onHold.length ? "declared_on_hold" : "declared", salesPath, onHold, ...(onHold.length ? { instruction: ON_HOLD_INSTRUCTION } : {}) };
}
