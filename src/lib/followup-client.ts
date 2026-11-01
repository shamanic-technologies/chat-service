import { messageVerdict, type ServedEvent } from "./delivery-truth.js";
import { judgeOnPlatform } from "./platform-judge.js";
import { createPlatformRun } from "./runs-client.js";
import { COPILOT_SUPPORT } from "./support-marks.js";
import { fetchRequesterEmail } from "./staff-requests.js";
import type { TypeSafeAnswer, TypeSafeQuestion } from "./typesafe.js";

// ---------------------------------------------------------------------------
// Copilot follow-ups (owner 2026-10-11): the Copilot is part of OUR staff, so it
// can reach the person it talks to LATER, through our normal outreach: a sales
// funnel campaign on distribute.you's own brand that names that one person,
// carries an instruction the workflow writes from, is capped at one send and is
// started by the agent itself (our brand, our money: no user gate). Same infra
// as every campaign (campaign-service runs it, billing caps it, the reply lands
// in the staff Unibox); nothing here is a special path.
//
// Recipe proven in prod by campaign-service (kelowna-v4, 2026-10-11):
//   create STOPPED -> cap (max volume 1, one_off) -> activate; edit/cancel by
//   PATCH; list by personEmail; fire = report the `follow_up_due` trigger for
//   the person's lead id.
// The person is ALWAYS the user of this chat (email from client-service): the
// Copilot can never write to anybody else, and every id it passes is checked
// against that person's own follow-ups.
//
// Every promise is a campaign that RUNS (owner 2026-10-14, PROMISE-ON-ARCHIVED-
// OFFER-1014): its offer is read LIVE from brand-service at create time (an
// archived offer is never served there), never pinned in env (the pinned offer
// was archived and the promise landed on it); billing must answer the cap
// write `funded: true` or the create fails loud. And it is never sent twice:
// the person's thread with us (crm timeline) is read first, and Jev judges
// whether a message we already sent them tells them what the promise would.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/** The follow-up funnel (features-service): trigger `follow_up_due` -> AI Follow-up Email. */
export const FOLLOWUP_FUNNEL_ID = "signup_to_paid_client@ai-follow-up-email";
export const FOLLOWUP_TRIGGER_ID = "follow_up_due";
/** Same channel, waiting on a GitHub issue: fires by itself once the issue is IN PROD (campaign-service detector). */
export const ISSUE_FOLLOWUP_FUNNEL_ID = "conversation_to_paid_client@ai-follow-up-email";

const ISSUE_URL = /^https:\/\/github\.com\/(shamanic-technologies\/[A-Za-z0-9._-]+)\/issues\/(\d+)\/?$/;

/** The issue a follow-up waits on, from the URL request_staff returned; only our own repos. */
export function githubIssueArg(v: unknown): { repo: string; number: number } | null {
  if (v === undefined || v === null || v === "") return null;
  const m = typeof v === "string" ? ISSUE_URL.exec(v.trim()) : null;
  if (!m) throw new FollowupError("waitForIssue must be the issue URL request_staff returned (https://github.com/shamanic-technologies/<repo>/issues/<n>).");
  return { repo: m[1], number: Number(m[2]) };
}
const MAX_INSTRUCTION = 4000;

export class FollowupError extends Error {
  constructor(message: string) {
    super(`[followups] ${message}`);
    this.name = "FollowupError";
  }
}

interface Scope {
  orgId: string;
  userId: string;
  brandId: string;
}

function scope(): Scope {
  const names = {
    orgId: "COPILOT_FOLLOWUP_ORG_ID",
    userId: "COPILOT_FOLLOWUP_USER_ID",
    brandId: "COPILOT_FOLLOWUP_BRAND_ID",
  } as const;
  const missing = Object.values(names).filter((n) => !process.env[n]);
  if (missing.length > 0) throw new Error(`[followups] not configured: ${missing.join(", ")}`);
  return {
    orgId: process.env[names.orgId]!,
    userId: process.env[names.userId]!,
    brandId: process.env[names.brandId]!,
  };
}

type Target = "CAMPAIGN_SERVICE" | "BILLING_SERVICE" | "CRM_SERVICE" | "API_SERVICE";

function service(prefix: Target): { url: string; key: string } {
  // The gateway is called with the admin key, like every other gateway read here (api-client.ts).
  const keyName = prefix === "API_SERVICE" ? "ADMIN_DISTRIBUTE_API_KEY" : `${prefix}_API_KEY`;
  const url = process.env[`${prefix}_URL`];
  const key = process.env[keyName];
  if (!url || !key) throw new Error(`${prefix}_URL / ${keyName} not configured`);
  return { url, key };
}

export type JudgeFn = (state: unknown, questions: Record<string, TypeSafeQuestion>) => Promise<Record<string, TypeSafeAnswer>>;

export interface FollowupDeps {
  fetchEmail: (userId: string) => Promise<string | null>;
  newRunId: () => Promise<string>;
  fetchImpl: typeof fetch;
  judge: JudgeFn;
}

export const defaultFollowupDeps: FollowupDeps = {
  fetchEmail: fetchRequesterEmail,
  newRunId: async () => (await createPlatformRun({ serviceName: "chat-service", taskName: "copilot-followup" })).id,
  fetchImpl: (...args) => fetch(...args),
  judge: (state, questions) => judgeOnPlatform("copilot-followup-already-kept", state, questions, COPILOT_SUPPORT),
};

class RefusedError extends FollowupError {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
  }
}

async function send(
  deps: FollowupDeps,
  target: Target,
  method: string,
  path: string,
  s: Scope,
  runId: string | null,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const { url, key } = service(target);
  const headers: Record<string, string> = { "x-api-key": key, "x-org-id": s.orgId, "x-user-id": s.userId };
  if (runId) headers["x-run-id"] = runId;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await deps.fetchImpl(`${url}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new RefusedError(`${method} ${path.split("?")[0]} refused (${res.status}): ${raw || "no body"}`, res.status, raw);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const enc = encodeURIComponent;

/**
 * The offer a new follow-up runs under: the brand's live offer, read from
 * brand-service now. Archived offers are dropped (brand-service hides them by
 * default; the status is checked again here). Several live offers: the oldest,
 * brand-service's own stable order. None: fail loud, nothing is created.
 */
export async function liveOfferId(s: Scope, runId: string, deps: FollowupDeps): Promise<string> {
  const body = await send(deps, "API_SERVICE", "GET", `/v1/brands/${enc(s.brandId)}/offers`, s, runId);
  const offers = body.offers as { offerId?: string; status?: string }[] | undefined;
  if (!Array.isArray(offers)) throw new FollowupError(`brand-service offers list carried no offers array: ${JSON.stringify(body).slice(0, 300)}`);
  const live = offers.filter((o) => o.status === "active" && typeof o.offerId === "string");
  if (live.length === 0) throw new FollowupError(`our brand ${s.brandId} has no live offer, so no follow-up can run; nothing was created.`);
  return live[0].offerId!;
}

/** Channels where WE write to the person (the Copilot chat and API calls are not a kept promise). */
const MESSAGE_CHANNELS = new Set(["email", "whatsapp", "telegram", "discord"]);
/** Sources that carry those messages: one unreadable = we cannot say whether we already wrote. */
const MESSAGE_SOURCES = new Set(["gmail", "instantly", "matrix", "gohighlevel"]);
const MAX_JUDGED_MESSAGES = 10;
/** Jev's probability that one of our messages already says it, at or above which nothing is created. */
export const ALREADY_KEPT_THRESHOLD = 0.5;

interface TimelineItem {
  at: string | null;
  channel: string;
  kind: string;
  direction: string | null;
  subject: string | null;
  text: string | null;
}

/** What we already sent this person, newest last (crm-service timeline on our brand). */
async function messagesWeSent(email: string, s: Scope, runId: string, deps: FollowupDeps): Promise<TimelineItem[]> {
  let body: Record<string, unknown>;
  try {
    body = await send(deps, "CRM_SERVICE", "GET", `/orgs/people/timeline?brandId=${enc(s.brandId)}&personKey=${enc(`email:${email}`)}`, s, runId);
  } catch (e) {
    // crm knows nobody under this email on our brand: we never wrote to them.
    if (e instanceof RefusedError && e.status === 404 && e.body.includes("person_not_found")) return [];
    throw e;
  }
  const broken = ((body.sources as { source: string; status: string; error?: string | null }[] | undefined) ?? [])
    .filter((x) => MESSAGE_SOURCES.has(x.source) && x.status === "error");
  if (broken.length > 0) {
    throw new FollowupError(
      `cannot read what we already sent this person (${broken.map((b) => `${b.source}: ${b.error ?? "error"}`).join("; ")}), so the follow-up was not created (it could repeat a message).`,
    );
  }
  const items = body.items as TimelineItem[] | undefined;
  if (!Array.isArray(items)) throw new FollowupError(`crm-service timeline carried no items array: ${JSON.stringify(body).slice(0, 300)}`);
  return items.filter((i) => i.kind === "message" && i.direction === "outbound" && MESSAGE_CHANNELS.has(i.channel));
}

/** The message we already sent that keeps this promise, or null (Jev judges). */
async function alreadyKept(instruction: string, sent: TimelineItem[], deps: FollowupDeps) {
  if (sent.length === 0) return null;
  const recent = sent.slice(-MAX_JUDGED_MESSAGES);
  const answers = await deps.judge(
    {
      whatTheFollowUpMustTellThem: instruction,
      messagesWeAlreadySentThem: recent.map((m) => ({ at: m.at, channel: m.channel, subject: m.subject, text: (m.text ?? "").slice(0, 4000) })),
    },
    {
      alreadyKept: {
        type: "noul",
        instructions:
          "We are about to send this person one email telling them what `whatTheFollowUpMustTellThem` says. Does at least one message in `messagesWeAlreadySentThem` already tell them that (the same news, answer or figure), so a new email would repeat it?",
        criteria: {
          true: "One of the messages already gives them that news, answer or figure.",
          false: "None of the messages gives it; the email would tell them something new.",
        },
      },
    },
  );
  const a = answers.alreadyKept;
  if (!a || a.type !== "noul" || typeof a.noul !== "number") throw new FollowupError(`Jev answered without a probability: ${JSON.stringify(a)}`);
  if (a.noul < ALREADY_KEPT_THRESHOLD) return null;
  const last = recent[recent.length - 1];
  return { probability: a.noul, lastMessageAt: last.at, lastMessageSubject: last.subject };
}

async function personEmail(userId: string, deps: FollowupDeps): Promise<string> {
  const email = await deps.fetchEmail(userId);
  if (!email) throw new FollowupError("this user has no email on file, so nobody can be followed up.");
  return email.trim().toLowerCase();
}

function instructionArg(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new FollowupError("instruction is required: what the email must tell this person.");
  if (v.length > MAX_INSTRUCTION) throw new FollowupError(`instruction is ${v.length} chars, ${MAX_INSTRUCTION} max.`);
  return v.trim();
}

interface Row {
  id: string;
  status: string;
  instruction: string | null;
  salesFunnelId: string;
  offerId: string;
  people: { email: string; leadId?: string | null }[];
  githubIssue?: { repo: string; number: number } | null;
  githubIssueCheck?: { state: string } | null;
}

function rowsOf(body: Record<string, unknown>): Row[] {
  const list = body.salesFunnelCampaigns as unknown;
  if (!Array.isArray(list)) throw new FollowupError(`campaign-service list carried no campaigns array: ${JSON.stringify(body).slice(0, 300)}`);
  return list as Row[];
}

function view(r: Row) {
  return {
    followUpId: r.id,
    status: r.status,
    instruction: r.instruction,
    salesFunnelId: r.salesFunnelId,
    ...(r.githubIssue ? { waitsForIssue: `https://github.com/${r.githubIssue.repo}/issues/${r.githubIssue.number}`, issueState: r.githubIssueCheck?.state ?? "not_checked_yet" } : {}),
  };
}

/** This person's own follow-ups (every status unless `status` is given). */
async function ownRows(email: string, s: Scope, deps: FollowupDeps, status?: string): Promise<Row[]> {
  const q = `personEmail=${encodeURIComponent(email)}${status ? `&status=${encodeURIComponent(status)}` : ""}`;
  return rowsOf(await send(deps, "CAMPAIGN_SERVICE", "GET", `/sales-funnel-campaigns?${q}`, s, null));
}

async function ownRow(followUpId: unknown, email: string, s: Scope, deps: FollowupDeps): Promise<Row> {
  if (typeof followUpId !== "string" || !followUpId.trim()) throw new FollowupError("followUpId is required (list_followups).");
  const row = (await ownRows(email, s, deps)).find((r) => r.id === followUpId.trim());
  if (!row) throw new FollowupError(`no follow-up "${followUpId}" for this user (list_followups shows theirs).`);
  return row;
}

export interface FollowupContext {
  userId: string;
}

export async function createFollowup(a: Record<string, unknown>, ctx: FollowupContext, deps = defaultFollowupDeps) {
  const s = scope();
  const instruction = instructionArg(a.instruction);
  const githubIssue = githubIssueArg(a.waitForIssue);
  const salesFunnelId = githubIssue ? ISSUE_FOLLOWUP_FUNNEL_ID : FOLLOWUP_FUNNEL_ID;
  const email = await personEmail(ctx.userId, deps);
  const runId = await deps.newRunId();
  const kept = await alreadyKept(instruction, await messagesWeSent(email, s, runId, deps), deps);
  if (kept) {
    return {
      created: false,
      reason: "already_told",
      tellUser: "We already sent this person a message that says this, so no follow-up was created and nothing more will be sent. Do not promise another email for it.",
      ...kept,
    };
  }
  const offerId = await liveOfferId(s, runId, deps);
  const created = await send(deps, "CAMPAIGN_SERVICE", "POST", "/sales-funnel-campaigns", s, runId, {
    brandId: s.brandId,
    offerId,
    salesFunnelId,
    status: "stopped",
    people: [{ email }],
    instruction,
    ...(githubIssue ? { githubIssue } : {}),
  });
  const campaign = created.salesFunnelCampaign as Row | undefined;
  if (!campaign?.id) throw new FollowupError(`campaign-service answered without a campaign id: ${JSON.stringify(created).slice(0, 300)}`);
  const refused = ((created.filing as { outcome?: string }[] | undefined) ?? [])
    .map((f) => f.outcome)
    .filter((o) => o !== "filed" && o !== "already_filed");
  if (refused.length > 0) {
    throw new FollowupError(`this person could not be filed as a lead (${refused.join(", ")}); the follow-up was created stopped and not started (${campaign.id}).`);
  }
  const caps = await send(
    deps,
    "BILLING_SERVICE",
    "PUT",
    `/internal/brands/${enc(s.brandId)}/offers/${enc(offerId)}/sales-funnels/${enc(salesFunnelId)}/campaigns/${enc(campaign.id)}/caps`,
    s,
    null,
    { maxBudget: null, maxVolume: { count: 1, period: "one_off" } },
  );
  // Billing's verdict, never our reading of the caps: an unfunded promise would never send.
  if (caps.funded !== true) {
    throw new FollowupError(`billing does not fund this follow-up (funded: ${JSON.stringify(caps.funded)}), so it was left stopped and will not send (${campaign.id}).`);
  }
  await send(deps, "CAMPAIGN_SERVICE", "PATCH", `/sales-funnel-campaigns/${enc(campaign.id)}`, s, runId, { status: "activate" });
  return {
    created: true,
    followUpId: campaign.id,
    status: "ongoing",
    to: email,
    instruction,
    sendsAtMost: 1,
    firesWhen: githubIssue ? "by itself, once that issue is shipped and live in production" : "fire_followup is called",
  };
}

export async function updateFollowup(a: Record<string, unknown>, ctx: FollowupContext, deps = defaultFollowupDeps) {
  const s = scope();
  const row = await ownRow(a.followUpId, await personEmail(ctx.userId, deps), s, deps);
  const instruction = instructionArg(a.instruction);
  const runId = await deps.newRunId();
  await send(deps, "CAMPAIGN_SERVICE", "PATCH", `/sales-funnel-campaigns/${encodeURIComponent(row.id)}`, s, runId, { instruction });
  return { ...view(row), instruction };
}

export async function cancelFollowup(a: Record<string, unknown>, ctx: FollowupContext, deps = defaultFollowupDeps) {
  const s = scope();
  const row = await ownRow(a.followUpId, await personEmail(ctx.userId, deps), s, deps);
  const runId = await deps.newRunId();
  await send(deps, "CAMPAIGN_SERVICE", "PATCH", `/sales-funnel-campaigns/${encodeURIComponent(row.id)}`, s, runId, { status: "stop" });
  return { ...view(row), status: "stopped" };
}

/**
 * The last emails we sent this person, newest first: what list_followups
 * shows so the Copilot can say an email LEFT only once one is here
 * (CHAT-TRUTH-1101). A source crm cannot read is said, never read as "none".
 */
async function emailsWeSentThem(email: string, s: Scope, deps: FollowupDeps) {
  try {
    const sent = await messagesWeSent(email, s, await deps.newRunId(), deps);
    return sent
      .filter((m) => m.channel === "email")
      .slice(-3)
      .reverse()
      .map((m) => ({ at: m.at, subject: m.subject }));
  } catch (e) {
    if (e instanceof FollowupError) return { unreadable: e.message };
    throw e;
  }
}

export async function listFollowups(_a: Record<string, unknown>, ctx: FollowupContext, deps = defaultFollowupDeps) {
  const s = scope();
  const email = await personEmail(ctx.userId, deps);
  const rows = await ownRows(email, s, deps, "ongoing");
  return {
    followUps: rows.slice(0, 15).map(view),
    lastEmailsWeSentThem: await emailsWeSentThem(email, s, deps),
  };
}

export async function fireFollowup(a: Record<string, unknown>, ctx: FollowupContext, deps = defaultFollowupDeps) {
  const s = scope();
  const row = await ownRow(a.followUpId, await personEmail(ctx.userId, deps), s, deps);
  if (row.githubIssue) throw new FollowupError("this follow-up waits on its GitHub issue and fires by itself once it is live; nothing to fire.");
  const leadId = row.people?.[0]?.leadId;
  if (!leadId) throw new FollowupError("this follow-up has no lead id yet, so it cannot fire.");
  if (!row.offerId) throw new FollowupError(`campaign-service served follow-up ${row.id} without its offer id, so it cannot fire.`);
  const answer = await send(deps, "CAMPAIGN_SERVICE", "POST", "/internal/trigger-events", s, null, {
    triggerId: FOLLOWUP_TRIGGER_ID,
    brandId: s.brandId,
    offerId: row.offerId,
    leadId,
  });
  const event = answer.event as ServedEvent | undefined;
  if (!event || typeof event !== "object") throw new FollowupError(`campaign-service answered the fire without an event: ${JSON.stringify(answer).slice(0, 300)}`);
  // Never the raw event: its `outcome: "ran"` reads as "sent" and is not (CHAT-TRUTH-1101).
  return { followUpId: row.id, eventId: event.id ?? null, ...messageVerdict(event) };
}

export const FOLLOWUP_TOOLS: Record<string, (a: Record<string, unknown>, ctx: FollowupContext) => Promise<unknown>> = {
  create_followup: (a, c) => createFollowup(a, c),
  update_followup: (a, c) => updateFollowup(a, c),
  cancel_followup: (a, c) => cancelFollowup(a, c),
  list_followups: (a, c) => listFollowups(a, c),
  fire_followup: (a, c) => fireFollowup(a, c),
};
