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
import { apiServiceFetch, type ApiCallParams } from "./api-client.js";
import { WhatsappSendError, parseChatStream, renderChannelReply, type ChatChannelContext } from "./channel-copilot.js";
import { COPILOT_CONFIG_KEY } from "./copilot-unibox.js";
import type { AskingCampaign } from "./funnel-campaign-client.js";

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

/** One message of the person's thread with the brand (crm-service merged timeline), as the turn reads it. */
export interface PersonThreadMessage {
  at: string | null;
  /** inbound = the person wrote; outbound = the brand did. */
  direction: "inbound" | "outbound" | "other" | null;
  channel: string;
  text: string;
}

export interface ProactiveTurnContext {
  /** The person's latest messages with the brand, oldest first (empty when none was read). */
  thread: PersonThreadMessage[];
  /** The campaign whose step asked for this turn (resolved from x-campaign-id), when the caller sent it. */
  asking: AskingCampaign | null;
}

/** "Lead Proposal Deals" (funnel start_to_paid_client@ai-lead-proposal, channel ai-lead-proposal). */
function askingWords(a: AskingCampaign): string {
  const what = [a.salesFunnelId ? `funnel ${a.salesFunnelId}` : null, a.channel ? `channel ${a.channel}` : null].filter(Boolean).join(", ");
  return `${a.name ? `"${a.name}"` : "the campaign"}${what ? ` (${what})` : ""}`;
}

/**
 * The asking campaign is kept OUT of what the turn reads (prod 2026-10-19: the
 * turn read it by its name in list_campaigns and proposed it). A row naming it
 * (its funnel campaign, its unit, its sales funnel in the catalogue) is dropped
 * and the result says why, so the turn can only propose something that acts
 * for the person. Pure: the tool result as the model will see it.
 */
export function withoutAskingCampaign(toolName: string, result: unknown, asking: AskingCampaign): unknown {
  if (!result || typeof result !== "object") return result;
  const ids = new Set(asking.ids);
  const note = `${askingWords(asking)} is hidden here: it is the campaign that asked you to notify the team, it only tells the team and never acts for the person.`;
  const r = result as Record<string, unknown>;
  if ((toolName === "list_campaigns" || toolName === "list_funnel_campaigns") && Array.isArray(r.campaigns)) {
    const named = (c: unknown) => {
      const row = c as Record<string, unknown>;
      return ids.has(String(row.id)) || ids.has(String(row.salesFunnelCampaignId));
    };
    const kept = (r.campaigns as unknown[]).filter((c) => !named(c));
    if (kept.length === r.campaigns.length) return result;
    return {
      ...r,
      campaigns: kept,
      ...("campaignCount" in r ? { campaignCount: kept.length } : {}),
      ...("shown" in r ? { shown: kept.length } : {}),
      hidden: note,
    };
  }
  if (toolName === "find_sales_funnels" && asking.salesFunnelId) {
    if (Array.isArray(r.rows)) {
      const kept = (r.rows as Array<Record<string, unknown>>).filter((row) => row.id !== asking.salesFunnelId);
      return kept.length === r.rows.length ? result : { ...r, rows: kept, hidden: note };
    }
    if (r.id === asking.salesFunnelId) return { id: r.id, hidden: note };
  }
  return result;
}

const THREAD_MESSAGES_SHOWN = 6;
const THREAD_TEXT_CHARS = 600;

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** The hidden user turn of a proactive turn: the facts, then the game (never canned wording). */
export function buildProactiveTriggerMessage(req: ProactiveTurnRequest, ctx: ProactiveTurnContext = { thread: [], asking: null }): string {
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
  const quote = req.inbound?.text ? `\nWhat they wrote: "${oneLine(req.inbound.text, 1500)}"` : "";
  const shown = ctx.thread.slice(-THREAD_MESSAGES_SHOWN);
  const thread = shown.length
    ? `\nTheir latest messages with the brand, oldest first:\n${shown
        .map((m) => `- ${m.direction === "inbound" ? "THEY wrote" : m.direction === "outbound" ? "the brand wrote" : "event"} on ${m.channel}${m.at ? ` (${m.at})` : ""}: "${oneLine(m.text, THREAD_TEXT_CHARS)}"`)
        .join("\n")}`
    : "";
  const hasWords = Boolean(req.inbound?.text) || shown.some((m) => m.direction === "inbound");
  return [
    "(Not written by the user. A campaign step of this brand asked you to speak first: a person who is not a customer and not a personal contact just wrote to the brand and wants business with it (a hot lead).",
    `Brand id: ${req.brandId}. The person: ${facts.join(", ")}.${wrote.length ? ` They wrote ${wrote.join(" ")}.` : ""}${quote}${thread}`,
    ctx.asking
      ? `\nThe campaign that asked you is ${askingWords(ctx.asking)}: it IS this notification. Its only job is to tell the team that this person is hot; it never writes to the person and sets nothing up for them. It is hidden from your reads in this turn, and it is never the answer to "what do we do for them".`
      : `\nThe campaign that asked you IS this notification: its only job is to tell the team that this person is hot. It never writes to the person and sets nothing up for them, so it is never the answer to "what do we do for them".`,
    "The proposal is something NEW for this person that acts for them; never answer that nothing new is needed.",
    "The game: the team decides, lead by lead, what we do for each hot lead. You are writing to the brand's own team, in their Copilot thread, to give them a choice they can answer with one word. Read what you need first with your tools: who this person is, the brand's offers, its running campaigns, and what we run today.",
    hasWords
      ? "Then write ONE short message, the size of a WhatsApp message: who the person is (name, company, how they reached us), what they wrote in a short quote of their own words, and ONE concrete proposal of what to set up FOR THEM from what we run today (a personal answer, the offer that fits what they asked, a campaign or funnel that writes to them, a meeting...), with its cap when it costs money. When they asked for something precise, the proposal answers that."
      : "Then write ONE short message, the size of a WhatsApp message: who the person is (name, company, how they reached us), say in a few plain words that you could not read a message from them and move on (never describe what else their thread holds: automatic emails, updates, events), and ONE concrete proposal of what to set up FOR THEM from what we run today (a personal answer, the offer that fits them, a campaign or funnel that writes to them, a meeting...), with its cap when it costs money.",
    "You do not know this person's pronouns: call them by their name (or first name), or say they/them; never he or she, never a gender guessed from a name or an address.",
    "End by asking the team for their go in one plain question. Do not set anything up, start anything, send anything to the person or spend anything now: nothing happens for them until a person of the team says go in this thread, and then your usual confirm rules apply.)",
  ].join(" ");
}

/**
 * The person's thread with the brand, read from crm-service's merged timeline
 * through the gateway (`GET /v1/orgs/people/timeline`, the Unibox thread), as
 * the recipient. Named by the first identity the caller gave: email, phone, then
 * crm person id. Messages with text only, the latest first page.
 */
export async function readPersonThread(
  args: { orgId: string; userId: string; runId: string; brandId: string; lead: ProactiveTurnRequest["lead"] },
  fetchImpl: (path: string, params: ApiCallParams) => Promise<Response> = (path, params) => apiServiceFetch(path, "GET", params),
): Promise<PersonThreadMessage[]> {
  const qs = new URLSearchParams({ brandId: args.brandId, limit: "30" });
  const { lead } = args;
  if (lead.email) qs.set("personKey", `email:${lead.email.trim().toLowerCase()}`);
  else if (lead.phone) qs.set("personKey", `phone:${lead.phone.trim()}`);
  else if (lead.personId && /^[0-9a-f-]{36}$/i.test(lead.personId)) qs.set("personId", lead.personId);
  else return [];
  const res = await fetchImpl(`/v1/orgs/people/timeline?${qs.toString()}`, { orgId: args.orgId, userId: args.userId, runId: args.runId });
  if (res.status === 404) return [];
  const raw = await res.text();
  if (!res.ok) throw new Error(`people timeline ${res.status}: ${raw.slice(0, 300)}`);
  const body = JSON.parse(raw) as { items?: Array<Record<string, unknown>> };
  return (body.items ?? [])
    .filter((i) => i.kind === "message" && typeof i.text === "string" && i.text.trim())
    .map((i) => ({
      at: typeof i.at === "string" ? i.at : null,
      direction: (i.direction as PersonThreadMessage["direction"]) ?? null,
      channel: typeof i.channel === "string" ? i.channel : "unknown",
      text: i.text as string,
    }));
}

/**
 * Delivery retries of a WhatsApp message already written: same text, same crm
 * idempotency key (crm sends it once at most), never a new turn. ~7.5 min in all.
 */
export const DELIVERY_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 240_000] as const;

/** A refusal that can clear by waiting: the account offline for a moment, a rate limit, a crm 5xx, a network cut. */
export function isRetryableDelivery(err: unknown): boolean {
  if (!(err instanceof WhatsappSendError)) return true;
  if (err.status >= 500 || err.status === 429) return true;
  return err.status === 422 && err.code === "whatsapp_not_connected";
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
  /** The person's thread with the brand (readPersonThread). */
  readThread: (args: { orgId: string; userId: string; runId: string; brandId: string; lead: ProactiveTurnRequest["lead"] }) => Promise<PersonThreadMessage[]>;
  /** campaign-service: the campaign whose step asked (resolveAskingCampaign). */
  resolveAskingCampaign: (args: { orgId: string; userId: string; runId: string; campaignId: string }) => Promise<AskingCampaign>;
  /** Waits between delivery attempts (injected for tests). */
  sleep?: (ms: number) => Promise<void>;
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
    // What they wrote: the caller's text, else their thread with the brand. A
    // failed read never blocks the notification; the turn is told it has no words.
    let thread: PersonThreadMessage[] = [];
    if (!req.inbound?.text) {
      try {
        thread = await deps.readThread({ orgId: row.orgId, userId: recipient.userId, runId: row.parentRunId, brandId: row.brandId, lead: req.lead });
      } catch (err) {
        console.error(`[chat-service] proactive turn "${row.id}": person thread read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // The campaign that asked: named in the turn and hidden from its reads (the
    // /chat handler resolves it again from the same header for the guard).
    const askingId = trackingHeaders["x-campaign-id"];
    const asking = askingId
      ? await deps.resolveAskingCampaign({ orgId: row.orgId, userId: recipient.userId, runId: row.parentRunId, campaignId: askingId })
      : null;
    const { status: http, body } = await deps.runChat({
      orgId: row.orgId,
      userId: recipient.userId,
      runId: row.parentRunId,
      sessionId: recipient.sessionId,
      message: buildProactiveTriggerMessage(req, { thread, asking }),
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
        const send = {
          orgId: w.inbound.orgId,
          brandId: w.inbound.brandId,
          userId: w.inbound.accountUserId,
          runId: row.parentRunId,
          phone: w.phone,
          fromAccount: w.inbound.fromAccount,
          text: replyText,
          idempotencyKey: `copilot-proactive:${row.id}`,
        };
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        for (let attempt = 1; ; attempt++) {
          try {
            await deps.sendWhatsapp(send);
            break;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            const delay = DELIVERY_RETRY_DELAYS_MS[attempt - 1];
            if (!isRetryableDelivery(err) || delay === undefined) {
              // The message is written and stored in the web Copilot thread; only the phone hop failed.
              throw new Error(`whatsapp delivery failed after ${attempt} attempt(s), the message waits in the web Copilot thread: ${reason}`);
            }
            console.warn(`[chat-service] proactive turn "${row.id}": whatsapp delivery attempt ${attempt} refused, retrying in ${delay / 1000}s: ${reason}`);
            await sleep(delay);
          }
        }
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
