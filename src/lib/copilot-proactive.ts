/**
 * The Copilot speaks first to the brand's TEAM because a campaign step asked it
 * to (HOT-LEAD-PROPOSAL-1019, owner 2026-10-19: « Sophie me notifie à chq fois
 * qu'une lead … nous écrit avec de l'interest business, pour me proposer quoi
 * mettre en place pour eux (sans le faire sans mon go bien sûr) »).
 *
 * A workflow calls POST /internal/copilot/proactive-turns with the fact (today:
 * `hot_lead`, a person who newly wrote to the brand with business interest).
 * Here:
 *  1. the recipient is ONE member of the org's team: the person who used the
 *     Copilot on that org most recently (a known customer email first, staff
 *     only when no customer member ever used it, an unknown email last), never
 *     the lead, never anyone outside the org;
 *  2. the turn runs through POST /chat itself on that member's latest Copilot
 *     session (the thread the web and WhatsApp share), with READ tools only:
 *     nothing is created, started, sent or spent for the lead in that turn;
 *  3. the answer goes out on WhatsApp when that thread is tied to a number (from
 *     the same linked account that last answered them), else it waits in the
 *     web Copilot thread. The team answers "go" in that thread and the Copilot
 *     continues with the whole context and its usual confirm rules.
 *
 * Cross-org: nothing here names a brand, an org or the assistant's persona.
 */
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { channelInboundMessages, copilotProactiveTurns, sessions } from "../db/schema.js";
import type { ChannelMessageRequest, ProactiveTurnRequest } from "../schemas.js";
import { parseChatStream, renderChannelReply, type ChatChannelContext } from "./channel-copilot.js";
import { COPILOT_CONFIG_KEY } from "./copilot-unibox.js";

/**
 * The tools a proactive turn may call: reads only. The model gathers what it
 * needs (the person, the brand's offers, its campaigns, the catalogue) and
 * writes; every write waits for the team's answer in a later, normal turn.
 * No cards either: the message ends on a plain question the team answers in words.
 */
export function isProactiveReadTool(name: string): boolean {
  return /^(get|list|find)_/.test(name) || name === "read_skill";
}

export function proactiveToolNames(allowed: readonly string[]): string[] {
  return allowed.filter(isProactiveReadTool);
}

/** The hidden user turn of a proactive turn: the facts, then the game (never canned wording). */
export function buildProactiveTriggerMessage(req: ProactiveTurnRequest): string {
  const lead = req.lead;
  const facts: string[] = [];
  if (lead.name) facts.push(`name: ${lead.name}`);
  if (lead.company) facts.push(`company: ${lead.company}`);
  if (lead.email) facts.push(`email: ${lead.email}`);
  if (lead.phone) facts.push(`phone: ${lead.phone}`);
  if (lead.leadId) facts.push(`lead id: ${lead.leadId}`);
  if (lead.personId) facts.push(`person id: ${lead.personId}`);
  const wrote: string[] = [];
  if (req.inbound?.channel) wrote.push(`on ${req.inbound.channel}`);
  if (req.inbound?.at) wrote.push(`at ${req.inbound.at}`);
  const quote = req.inbound?.text ? `\nWhat they wrote: "${req.inbound.text.replace(/\s+/g, " ").slice(0, 1500)}"` : "";
  return [
    "(Not written by the user. A campaign step of this brand asked you to speak first: a person who is not a customer and not a personal contact just wrote to the brand and wants business with it (a hot lead).",
    `Brand id: ${req.brandId}. The person: ${facts.join(", ")}.${wrote.length ? ` They wrote ${wrote.join(" ")}.` : ""}${quote}`,
    "You are writing to the brand's own team, in their Copilot thread. Read what you need first with your tools: who this person is, what they wrote, the brand's offers, its running campaigns, and what we run today.",
    "Then write ONE short message, the size of a WhatsApp message: who the person is (name, company, how they reached us), what they wrote in a short quote, and ONE concrete proposal of what to set up for them from what we run today (an offer, a campaign, a next step), with its cap when it costs money.",
    "End by asking the team for their go in one plain question. Do not set anything up, start anything, send anything to the person or spend anything now: nothing happens for them until a person of the team says go in this thread, and then your usual confirm rules apply.)",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Dependencies (injected so the flow is testable without the network)
// ---------------------------------------------------------------------------

export interface ProactiveDeps {
  db: typeof Db;
  /** client-service: a user's email (null when unknown). */
  fetchEmail: (userId: string) => Promise<string | null>;
  isStaffEmail: (email: string | null) => boolean;
  /** POST /chat on this process for the recipient. */
  runChat: (args: {
    orgId: string;
    userId: string;
    runId: string;
    sessionId: string;
    message: string;
    context: Record<string, unknown>;
    proactiveTurnId: string;
    trackingHeaders: Record<string, string>;
  }) => Promise<{ status: number; body: string }>;
  /** crm-service POST /orgs/whatsapp/messages. */
  sendWhatsapp: (args: { orgId: string; brandId: string; userId: string; runId: string | null; phone: string; fromAccount: string; text: string; idempotencyKey: string }) => Promise<void>;
}

export interface ProactiveRecipient {
  userId: string;
  sessionId: string;
  /** The WhatsApp hop when this person's thread is tied to a number, else null (web thread). */
  whatsapp: { phone: string; inbound: ChannelMessageRequest } | null;
}

const MAX_CANDIDATES = 10;

/**
 * The team member who receives it: the latest Copilot user of the org with a
 * known non-staff email (a customer member), else the latest with a known email
 * (staff are Clerk members of the client orgs they help set up; on a staff org
 * everyone is staff), else the latest at all. Their
 * latest Copilot session is the thread; null when nobody ever used the Copilot.
 */
export async function pickProactiveRecipient(
  deps: Pick<ProactiveDeps, "db" | "fetchEmail" | "isStaffEmail">,
  orgId: string,
): Promise<ProactiveRecipient | null> {
  const rows = await deps.db
    .select({ id: sessions.id, userId: sessions.userId, channelPhone: sessions.channelPhone })
    .from(sessions)
    .where(and(eq(sessions.orgId, orgId), eq(sessions.configKey, COPILOT_CONFIG_KEY), eq(sessions.guest, false)))
    .orderBy(desc(sessions.updatedAt))
    .limit(50);
  const latestPerUser: Array<{ id: string; userId: string; channelPhone: string | null }> = [];
  for (const r of rows) {
    if (!r.userId || latestPerUser.some((x) => x.userId === r.userId)) continue;
    latestPerUser.push({ id: r.id, userId: r.userId, channelPhone: r.channelPhone });
    if (latestPerUser.length >= MAX_CANDIDATES) break;
  }
  if (latestPerUser.length === 0) return null;
  // A customer member is POSITIVE evidence: a known email that is not staff.
  // A user with no known email never outranks a known team member (prod
  // 2026-10-19: an email-less one-session user would have taken Kevin's place).
  const emails = await Promise.all(latestPerUser.map((c) => deps.fetchEmail(c.userId)));
  const known = latestPerUser.filter((_, i) => Boolean(emails[i]));
  const pick = latestPerUser.find((_, i) => Boolean(emails[i]) && !deps.isStaffEmail(emails[i])) ?? known[0] ?? latestPerUser[0];

  let whatsapp: ProactiveRecipient["whatsapp"] = null;
  if (pick.channelPhone) {
    const [inbound] = await deps.db
      .select({ payload: channelInboundMessages.payload })
      .from(channelInboundMessages)
      .where(and(eq(channelInboundMessages.sessionId, pick.id), eq(channelInboundMessages.status, "answered")))
      .orderBy(desc(channelInboundMessages.createdAt))
      .limit(1);
    if (inbound) whatsapp = { phone: pick.channelPhone, inbound: inbound.payload as ChannelMessageRequest };
  }
  return { userId: pick.userId, sessionId: pick.id, whatsapp };
}

/** The `context.channel` block for a WhatsApp delivery: the persona of the account that answers them. */
export function proactiveChannelContext(w: NonNullable<ProactiveRecipient["whatsapp"]>): ChatChannelContext {
  return { kind: "whatsapp", assistant: w.inbound.assistant, sender: { phone: w.phone, name: w.inbound.sender.name ?? null }, thread: [] };
}

// ---------------------------------------------------------------------------
// One proactive turn, end to end (the row was inserted as `processing`)
// ---------------------------------------------------------------------------

export async function processProactiveTurn(
  deps: ProactiveDeps,
  rowId: string,
  recipient: ProactiveRecipient,
  trackingHeaders: Record<string, string>,
): Promise<void> {
  const { db } = deps;
  const [row] = await db.select().from(copilotProactiveTurns).where(eq(copilotProactiveTurns.id, rowId));
  if (!row || row.status !== "processing") return;
  const req = row.payload as ProactiveTurnRequest;
  let status: "delivered" | "out_of_credits" | "failed" = "failed";
  let replyText: string | null = null;
  let error: string | null = null;
  try {
    const { status: http, body } = await deps.runChat({
      orgId: row.orgId,
      userId: recipient.userId,
      runId: row.parentRunId,
      sessionId: recipient.sessionId,
      message: buildProactiveTriggerMessage(req),
      context: { brandId: row.brandId, ...(recipient.whatsapp ? { channel: proactiveChannelContext(recipient.whatsapp) } : {}) },
      proactiveTurnId: row.id,
      trackingHeaders,
    });
    if (http !== 200) throw new Error(`POST /chat ${http}: ${body.slice(0, 500)}`);
    const turn = parseChatStream(body);
    if (turn.error && !turn.text) throw new Error(`chat stream error: ${turn.error}`);
    if (turn.creditsRequired) {
      // The out-of-credits answer is stored in the thread; it says nothing about
      // the lead, so it is not pushed to anyone's phone.
      status = "out_of_credits";
      replyText = turn.text;
    } else {
      if (!turn.text.trim()) throw new Error("the turn ended with no answer");
      replyText = turn.text;
      if (recipient.whatsapp) {
        const w = recipient.whatsapp;
        replyText = renderChannelReply(turn);
        await deps.sendWhatsapp({
          orgId: w.inbound.orgId,
          brandId: w.inbound.brandId,
          userId: w.inbound.accountUserId,
          runId: row.parentRunId,
          phone: w.phone,
          fromAccount: w.inbound.fromAccount,
          text: replyText,
          idempotencyKey: `copilot-proactive:${row.id}`,
        });
      }
      status = "delivered";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[chat-service] proactive turn "${row.id}" (${row.kind}) org="${row.orgId}": ${error}`);
  }
  await db
    .update(copilotProactiveTurns)
    .set({ status, replyText, error, updatedAt: new Date() })
    .where(eq(copilotProactiveTurns.id, rowId));
}

/**
 * A deploy recreates the container mid-turn: a row left `processing` is marked
 * failed, never re-run (the answer may already be in the thread, and the step's
 * retry answers the stored row, so a second message never goes out).
 */
export async function failInterruptedProactiveTurns(db: typeof Db, bootedAt = new Date()): Promise<number> {
  const rows = await db
    .update(copilotProactiveTurns)
    .set({ status: "failed", error: "interrupted by a restart", updatedAt: bootedAt })
    .where(and(inArray(copilotProactiveTurns.status, ["processing"]), lt(copilotProactiveTurns.updatedAt, bootedAt)))
    .returning({ id: copilotProactiveTurns.id });
  return rows.length;
}
