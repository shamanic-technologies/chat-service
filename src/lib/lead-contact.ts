/**
 * CONTACT-REDIRECT-1101 (owner 2026-11-01): a person asks to be reached
 * elsewhere ("please don't message me in this account, reach me here:
 * +8801952666418 (whatsapp)") and the assistant follows them there, alone.
 *
 * In a lead turn the assistant states the new handle through
 * `reach_person_elsewhere`: crm-service (the people owner) ties it to the
 * SAME person and, preferred, sends every later message of the brand to it,
 * the answer of this very turn included (the workflow's send asks crm for the
 * person, crm picks the preferred handle). A later message from that handle is
 * the same person in crm, one thread.
 *
 * The statement is the WRITING BRAND's, so crm is called as the caller of the
 * lead turn (the brand's org and the writer's run), never as the person's own
 * account the turn may run under. The model decides when, from the person's
 * words: no keyword rule, no check on its answer.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { LeadTurnRequest } from "../schemas.js";

export const REACH_ELSEWHERE_TOOL_NAME = "reach_person_elsewhere";

export const REACH_ELSEWHERE_TOOL: Anthropic.Tool = {
  name: REACH_ELSEWHERE_TOOL_NAME,
  description:
    "The person asked to be reached on another number or email from now on (\"don't message me here, reach me at +880... on WhatsApp\", \"write to my work address instead\"). " +
    "Call it BEFORE answer_person with the handle they gave, exactly as they wrote it: it ties that handle to this same person and makes it where every message to them goes from now on, the answer you are writing included. " +
    "Then write your answer as the next message of the same conversation, now on that handle (a short line that you are writing from here now is enough). " +
    "Only for a handle THEY gave for themselves, never one you guessed or someone else's. A refusal comes back as {refused, reason, error}: then answer where they wrote and ask for the handle again if it was unreadable.",
  input_schema: {
    type: "object" as const,
    properties: {
      phone: { type: "string", description: "Their new number, international form with the country code (+8801952666418). One of phone / email." },
      email: { type: "string", description: "Their new email address. One of phone / email." },
      channel: { type: "string", description: "Where they want to be reached on it, in one word: whatsapp, sms, call, email." },
      reason: { type: "string", description: "Their own words asking for it." },
    },
  },
};

/** Who states the handle: the lead turn's caller (the writing brand's org and the writer's run). */
export interface LeadContactCaller {
  orgId: string;
  userId: string;
  runId: string;
}

/**
 * The callers of the lead turns this process is running, by lead turn id.
 * `processLeadTurn` sets it before the /chat call on this process and clears it
 * after: the turn's tools read who asked without storing the caller's run.
 */
const leadTurnCallers = new Map<string, LeadContactCaller>();

export function registerLeadTurnCaller(leadTurnId: string, caller: LeadContactCaller): void {
  leadTurnCallers.set(leadTurnId, caller);
}

export function forgetLeadTurnCaller(leadTurnId: string): void {
  leadTurnCallers.delete(leadTurnId);
}

export function leadTurnCaller(leadTurnId: string): LeadContactCaller | null {
  return leadTurnCallers.get(leadTurnId) ?? null;
}

export interface Refused {
  refused: true;
  status: number;
  reason: string;
  error: string;
}

function text(name: string, v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`[${REACH_ELSEWHERE_TOOL_NAME}] ${name} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new Error(`[${REACH_ELSEWHERE_TOOL_NAME}] ${name} is longer than ${max} characters`);
  return t || undefined;
}

/** The person the lead turn writes to, by crm identity key: the number wins, like everywhere else. */
export function personKeyOf(recipient: LeadTurnRequest["recipient"]): string {
  if (recipient.phone) return `phone:${recipient.phone}`;
  if (recipient.email) return `email:${recipient.email.trim().toLowerCase()}`;
  throw new Error(`[${REACH_ELSEWHERE_TOOL_NAME}] the lead turn names no phone or email`);
}

/** PURE: the crm body for the model's arguments (refused when it gave no single handle). */
export function buildHandleBody(
  args: Record<string, unknown>,
  payload: LeadTurnRequest,
): { ok: true; body: Record<string, unknown> } | { ok: false; refused: Refused } {
  const phone = text("phone", args.phone, 40);
  const email = text("email", args.email, 320);
  if ((phone ? 1 : 0) + (email ? 1 : 0) !== 1) {
    return {
      ok: false,
      refused: { refused: true, status: 400, reason: "one_handle", error: "Give exactly one of phone or email: the handle the person asked to be reached on." },
    };
  }
  const channel = text("channel", args.channel, 40);
  const reason = text("reason", args.reason, 1000);
  return {
    ok: true,
    body: {
      brandId: payload.brandId,
      personKey: personKeyOf(payload.recipient),
      ...(phone ? { phone } : { email }),
      preferred: true,
      ...(channel ? { channel: channel.toLowerCase() } : {}),
      ...(reason ? { reason } : {}),
      evidence: { source: "lead_turn", channel: payload.medium, ...(reason ? { text: reason } : {}) },
    },
  };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}

/** crm-service POST /orgs/people/handles, as the writing brand. A crm refusal is an answer for the model. */
export async function reachPersonElsewhere(
  args: Record<string, unknown>,
  ctx: { payload: LeadTurnRequest; caller: LeadContactCaller },
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const built = buildHandleBody(args, ctx.payload);
  if (!built.ok) return built.refused as unknown as Record<string, unknown>;
  const res = await fetchImpl(`${env("CRM_SERVICE_URL")}/orgs/people/handles`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env("CRM_SERVICE_API_KEY"),
      "x-org-id": ctx.caller.orgId,
      "x-user-id": ctx.caller.userId,
      "x-run-id": ctx.caller.runId,
      "x-brand-id": ctx.payload.brandId,
    },
    body: JSON.stringify(built.body),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try {
    json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    if ((res.status === 404 || res.status === 422) && json.type === "refused") {
      return { refused: true, status: res.status, reason: String(json.reason ?? "refused"), error: String(json.error ?? raw) };
    }
    throw new Error(`crm-service POST /orgs/people/handles ${res.status}: ${raw.slice(0, 500)}`);
  }
  const handle = (json.handle ?? {}) as Record<string, unknown>;
  const whatsapp = (json.whatsapp ?? null) as Record<string, unknown> | null;
  return {
    stated: true,
    handle: handle.handle ?? null,
    kind: handle.kind ?? null,
    preferred: handle.preferred ?? true,
    alreadyStated: json.duplicate === true,
    ...(whatsapp ? { onWhatsapp: whatsapp.status ?? null } : {}),
    next: "Every message to this person now goes to this handle, your answer included: write it as the next message of the same conversation.",
  };
}
