import { createPlatformRun } from "./runs-client.js";
import { fetchRequesterEmail } from "./staff-requests.js";

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
  offerId: string;
}

function scope(): Scope {
  const names = {
    orgId: "COPILOT_FOLLOWUP_ORG_ID",
    userId: "COPILOT_FOLLOWUP_USER_ID",
    brandId: "COPILOT_FOLLOWUP_BRAND_ID",
    offerId: "COPILOT_FOLLOWUP_OFFER_ID",
  } as const;
  const missing = Object.values(names).filter((n) => !process.env[n]);
  if (missing.length > 0) throw new Error(`[followups] not configured: ${missing.join(", ")}`);
  return {
    orgId: process.env[names.orgId]!,
    userId: process.env[names.userId]!,
    brandId: process.env[names.brandId]!,
    offerId: process.env[names.offerId]!,
  };
}

function service(prefix: "CAMPAIGN_SERVICE" | "BILLING_SERVICE"): { url: string; key: string } {
  const url = process.env[`${prefix}_URL`];
  const key = process.env[`${prefix}_API_KEY`];
  if (!url || !key) throw new Error(`${prefix}_URL / ${prefix}_API_KEY not configured`);
  return { url, key };
}

export interface FollowupDeps {
  fetchEmail: (userId: string) => Promise<string | null>;
  newRunId: () => Promise<string>;
  fetchImpl: typeof fetch;
}

export const defaultFollowupDeps: FollowupDeps = {
  fetchEmail: fetchRequesterEmail,
  newRunId: async () => (await createPlatformRun({ serviceName: "chat-service", taskName: "copilot-followup" })).id,
  fetchImpl: (...args) => fetch(...args),
};

async function send(
  deps: FollowupDeps,
  target: "CAMPAIGN_SERVICE" | "BILLING_SERVICE",
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
  if (!res.ok) throw new FollowupError(`${method} ${path.split("?")[0]} refused (${res.status}): ${raw || "no body"}`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
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
  const created = await send(deps, "CAMPAIGN_SERVICE", "POST", "/sales-funnel-campaigns", s, runId, {
    brandId: s.brandId,
    offerId: s.offerId,
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
  const enc = encodeURIComponent;
  await send(
    deps,
    "BILLING_SERVICE",
    "PUT",
    `/internal/brands/${enc(s.brandId)}/offers/${enc(s.offerId)}/sales-funnels/${enc(salesFunnelId)}/campaigns/${enc(campaign.id)}/caps`,
    s,
    null,
    { maxBudget: null, maxVolume: { count: 1, period: "one_off" } },
  );
  await send(deps, "CAMPAIGN_SERVICE", "PATCH", `/sales-funnel-campaigns/${enc(campaign.id)}`, s, runId, { status: "activate" });
  return {
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

export async function listFollowups(_a: Record<string, unknown>, ctx: FollowupContext, deps = defaultFollowupDeps) {
  const s = scope();
  const rows = await ownRows(await personEmail(ctx.userId, deps), s, deps, "ongoing");
  return { followUps: rows.slice(0, 15).map(view) };
}

export async function fireFollowup(a: Record<string, unknown>, ctx: FollowupContext, deps = defaultFollowupDeps) {
  const s = scope();
  const row = await ownRow(a.followUpId, await personEmail(ctx.userId, deps), s, deps);
  if (row.githubIssue) throw new FollowupError("this follow-up waits on its GitHub issue and fires by itself once it is live; nothing to fire.");
  const leadId = row.people?.[0]?.leadId;
  if (!leadId) throw new FollowupError("this follow-up has no lead id yet, so it cannot fire.");
  const event = await send(deps, "CAMPAIGN_SERVICE", "POST", "/internal/trigger-events", s, null, {
    triggerId: FOLLOWUP_TRIGGER_ID,
    brandId: s.brandId,
    offerId: s.offerId,
    leadId,
  });
  return { followUpId: row.id, event };
}

export const FOLLOWUP_TOOLS: Record<string, (a: Record<string, unknown>, ctx: FollowupContext) => Promise<unknown>> = {
  create_followup: (a, c) => createFollowup(a, c),
  update_followup: (a, c) => updateFollowup(a, c),
  cancel_followup: (a, c) => cancelFollowup(a, c),
  list_followups: (a, c) => listFollowups(a, c),
  fire_followup: (a, c) => fireFollowup(a, c),
};
