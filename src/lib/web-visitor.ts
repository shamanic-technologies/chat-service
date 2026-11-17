/**
 * The Copilot in our public site's pages (DISTRY-WEB-CHAT-1117, owner
 * 2026-11-17: « Tu ne penses pas qu'il pourrait parler au client comme sur WA ou
 * par email, tout centralisé en terme de skill de communication quel que soit le
 * canal ? »).
 *
 * A visitor clicks the avatar on distribute.you and talks to Sophie in the page:
 * the same agent, config, voice (client-comms) and public offer (our-offer) as a
 * WhatsApp guest. Only the FORM differs (the web block below), plus one delivery
 * tool: `continue_on_channel`, when the visitor gives their WhatsApp number.
 *
 *  1. the site's server calls POST /internal/copilot/web-messages with the
 *     visitor's opaque id (its own first-party cookie) and their words;
 *  2. the visitor id IS the identity: one guest Copilot session per visitor
 *     (`sessions.web_visitor_id`), under distribute.you's own org (the
 *     Copilot's line, `COPILOT_FOLLOWUP_*`), so a reload finds the conversation;
 *  3. the turn runs through POST /chat on this process, on a Copilot support
 *     run under our org (`copilot-web`), and its answer is the HTTP response;
 *  4. a number they give is tied to that session (`channel_phone`), the answer
 *     is ALSO sent on WhatsApp from the Copilot's own line, and their WhatsApp
 *     reply (a Lead event) lands in the same session: the lead turn's guest
 *     session is found by that number, history included.
 *
 * Anonymous answers cost us: a visitor gets WEB_MAX_VISITOR_MESSAGES answers
 * before handing over a number, the page is told to ask for one from
 * WEB_ASK_CONTACT_AFTER on, and the whole surface answers at most
 * WEB_DAILY_TURN_CAP messages a UTC day.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, count, desc, eq, gte } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { channelInboundMessages, messages, sessions } from "../db/schema.js";
import {
  CHANNEL_FAILURE_TEXT,
  CONVERSATION_LINES,
  isIntendedSilence,
  parseChatStream,
  renderChannelReply,
  toPlainText,
  toWhatsappText,
  WhatsappSendError,
  type ChannelTurnResult,
} from "./channel-copilot.js";
import type { ChoicesRecord } from "../schemas.js";
import { COPILOT_CONFIG_KEY } from "./copilot-unibox.js";
import { isShownMessage } from "./session-history.js";
import type { CopilotLine, WhatsappReach } from "./copilot-proactive.js";

export const WEB_CHANNEL = "web";
export const WEB_TASK_NAME = "copilot-web";
export const WEB_CONTINUE_TOOL_NAME = "continue_on_channel";
/** From this many answered visitor messages on (no number yet), the page asks for a number. */
export const WEB_ASK_CONTACT_AFTER = 4;
/** Answers a visitor gets with no number given: the next message runs nothing (`contact_needed`). */
export const WEB_MAX_VISITOR_MESSAGES = 12;
/** Messages the whole web surface answers a UTC day (anonymous spend bound). */
export const WEB_DAILY_TURN_CAP = 400;
export const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const SITE_URL = "https://distribute.you";

/** The turn context block of a web turn: the form of this surface and how to continue elsewhere. */
export function buildWebBlock(state: { whatsapp: string | null }): string {
  const lines = [
    "\n\n---\n## Channel: our website (this turn)",
    `You are answering a visitor of ${SITE_URL}, in the chat window of the page they are reading. You are the distribute.you Copilot: same person, same rules, same personality as on WhatsApp and email.`,
    "The chat window shows plain text only: no markup at all (no *, no _, no tables, no headings, no markdown links: write the URL itself). Write short messages, like a person in a chat. Never use the long dash characters.",
    "Clickable choices (present_choices) are shown as a numbered list: the visitor answers with a number or in words.",
    ...CONVERSATION_LINES,
    "We do not know who this visitor is and they have no account you can read: never claim to see their brands, campaigns or figures. Answer every question about distribute.you at once, from what we offer everyone (what we do, how pricing works, how to start): those answers need no account.",
    `When they want to start, the way is ${SITE_URL} (the start button of the page), in their own time.`,
  ];
  if (state.whatsapp) {
    lines.push(
      `They gave their WhatsApp number (${state.whatsapp}) earlier in this conversation: your answers here also reach them there. Never ask for it again.`,
    );
  } else {
    lines.push(
      `When the conversation would go on better somewhere they keep (they want to think it over, come back later, be told when something is ready), you may offer once to continue on WhatsApp. ` +
        `When THEY give their WhatsApp number to continue there, call ${WEB_CONTINUE_TOOL_NAME} with it before you answer: your answer then reaches them on WhatsApp too, as the next message of this same conversation, so say in a few words that you are writing from there now.`,
    );
  }
  return lines.join("\n");
}

export const WEB_CONTINUE_TOOL: Anthropic.Tool = {
  name: WEB_CONTINUE_TOOL_NAME,
  description:
    "The visitor gave their WhatsApp number to continue this conversation there. Call it BEFORE your answer, with the number exactly as they wrote it, international form with the country code (+33612345678). " +
    "It ties the number to this conversation: your answer of this turn is also sent to them on WhatsApp, and when they answer there you read this whole conversation. " +
    "Only a number THEY gave for themselves, never one you guessed. A refusal comes back as {refused, reason, error}: then answer here and, when it was unreadable, ask for it again once.",
  input_schema: {
    type: "object" as const,
    properties: {
      phone: { type: "string", description: "Their WhatsApp number, international form with the country code (+33612345678)." },
    },
    required: ["phone"],
  },
};

/** PURE: the number the model passed, normalized, or why it is refused. */
export function parseContinueArgs(args: Record<string, unknown>): { ok: true; phone: string } | { ok: false; refused: Record<string, unknown> } {
  const raw = typeof args.phone === "string" ? args.phone : "";
  const phone = raw.replace(/[\s().-]/g, "").replace(/^00/, "+");
  if (!E164.test(phone)) {
    return {
      ok: false,
      refused: {
        refused: true,
        reason: "unreadable_number",
        error: `"${raw}" is not a WhatsApp number in international form (+ then the country code and number). Ask for it once more, with the country code.`,
      },
    };
  }
  return { ok: true, phone };
}

// ---------------------------------------------------------------------------
// Dependencies (injected so the flow is testable without the network)
// ---------------------------------------------------------------------------

export interface WebDeps {
  db: typeof Db;
  /** The Copilot's own line (distribute.you's org, brand and the user its work runs under). */
  copilotLine: () => CopilotLine;
  /** runs-service: a root Copilot support run under our org. */
  createRootRun: (identity: { orgId: string; userId: string }) => Promise<string>;
  /** POST /chat on this process, unlocked by the stored message row. */
  runChat: (args: { orgId: string; userId: string; runId: string; sessionId: string; message: string; channelMessageId: string; visitorId: string }) => Promise<{ status: number; body: string }>;
  /** crm-service POST /orgs/whatsapp/reach on the Copilot's own line. */
  reachWhatsapp: (args: { line: CopilotLine; runId: string; phone: string }) => Promise<WhatsappReach>;
  /** crm-service POST /orgs/whatsapp/messages. Throws when it did not leave. */
  sendWhatsapp: (args: { orgId: string; brandId: string; userId: string; runId: string | null; phone: string; fromAccount: string; text: string; idempotencyKey: string }) => Promise<void>;
  now?: () => Date;
}

export interface WebMessageInput {
  visitorId: string;
  messageId: string;
  text: string;
}

export interface WebState {
  sessionId: string | null;
  /** Visitor messages answered so far. */
  visitorMessages: number;
  whatsapp: string | null;
}

/** The visitor's conversation: one guest Copilot session under our org, null before their first message. */
export async function findWebSession(db: typeof Db, visitorId: string) {
  const [s] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.webVisitorId, visitorId), eq(sessions.configKey, COPILOT_CONFIG_KEY)))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);
  return s ?? null;
}

async function answeredCount(db: typeof Db, visitorId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(channelInboundMessages)
    .where(and(eq(channelInboundMessages.channel, WEB_CHANNEL), eq(channelInboundMessages.senderPhone, visitorId), eq(channelInboundMessages.status, "answered")));
  return Number(row?.n ?? 0);
}

export async function readWebState(db: typeof Db, visitorId: string): Promise<WebState> {
  const session = await findWebSession(db, visitorId);
  return { sessionId: session?.id ?? null, visitorMessages: await answeredCount(db, visitorId), whatsapp: session?.channelPhone ?? null };
}

/** PURE: what the page should do next. */
export function webSignals(state: Pick<WebState, "visitorMessages" | "whatsapp">) {
  const handedOver = state.whatsapp !== null;
  return {
    askForContact: !handedOver && state.visitorMessages >= WEB_ASK_CONTACT_AFTER,
    messagesLeft: handedOver ? null : Math.max(0, WEB_MAX_VISITOR_MESSAGES - state.visitorMessages),
    continuedOn: handedOver ? ("whatsapp" as const) : null,
  };
}

export type WebAccept =
  | { status: "accepted"; rowId: string }
  | { status: "duplicate"; rowId: string }
  | { status: "contact_needed" }
  | { status: "busy" };

/**
 * One visitor message: stored once (a retry of the same messageId runs nothing
 * twice), refused before any spend when the visitor used their answers without
 * giving a number, or when the surface used its day.
 */
export async function acceptWebMessage(deps: Pick<WebDeps, "db" | "copilotLine" | "now">, msg: WebMessageInput): Promise<WebAccept> {
  const { db } = deps;
  const key = `web:${msg.visitorId}:${msg.messageId}`;
  const [existing] = await db.select({ id: channelInboundMessages.id }).from(channelInboundMessages).where(eq(channelInboundMessages.messageId, key));
  if (existing) return { status: "duplicate", rowId: existing.id };
  const state = await readWebState(db, msg.visitorId);
  if (!state.whatsapp && state.visitorMessages >= WEB_MAX_VISITOR_MESSAGES) return { status: "contact_needed" };
  const now = deps.now?.() ?? new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [today] = await db
    .select({ n: count() })
    .from(channelInboundMessages)
    .where(and(eq(channelInboundMessages.channel, WEB_CHANNEL), gte(channelInboundMessages.createdAt, dayStart)));
  if (Number(today?.n ?? 0) >= WEB_DAILY_TURN_CAP) return { status: "busy" };
  const line = deps.copilotLine();
  const [row] = await db
    .insert(channelInboundMessages)
    .values({ messageId: key, channel: WEB_CHANNEL, senderPhone: msg.visitorId, orgId: line.orgId, userId: line.userId, status: "received", payload: msg })
    .onConflictDoNothing({ target: channelInboundMessages.messageId })
    .returning({ id: channelInboundMessages.id });
  if (!row) {
    const [raced] = await db.select({ id: channelInboundMessages.id }).from(channelInboundMessages).where(eq(channelInboundMessages.messageId, key));
    return { status: "duplicate", rowId: raced!.id };
  }
  return { status: "accepted", rowId: row.id };
}

/** The visitor's session, created on their first message (guest, our org, tied to the visitor id). */
export async function pickWebSession(db: typeof Db, line: CopilotLine, visitorId: string, runId: string): Promise<string> {
  const existing = await findWebSession(db, visitorId);
  if (existing) return existing.id;
  const [created] = await db
    .insert(sessions)
    .values({ orgId: line.orgId, userId: line.userId, parentRunId: runId, configKey: COPILOT_CONFIG_KEY, guest: true, webVisitorId: visitorId, brandIds: [line.brandId] })
    .returning({ id: sessions.id });
  return created.id;
}

export interface WebAnswer {
  reply: string;
  /** Where the answer went beside the page: their WhatsApp, when they gave it in this turn. */
  handOff: { channel: "whatsapp"; delivered: boolean; reason: string | null } | null;
  failed: boolean;
}

/** The /chat answer as the text the page shows, or the failure line + why. */
export function webTurnOutcome(status: number, body: string): { reply: string; failure: string | null } {
  if (status !== 200) return { reply: CHANNEL_FAILURE_TEXT, failure: `POST /chat ${status}: ${body.slice(0, 500)}` };
  const turn = parseChatStream(body);
  if (turn.error && !turn.text) return { reply: CHANNEL_FAILURE_TEXT, failure: `chat stream error: ${turn.error}` };
  if (!turn.text.trim() && !turn.choices) return { reply: CHANNEL_FAILURE_TEXT, failure: "the turn answered nothing" };
  return { reply: renderChannelReply(turn, toPlainText), failure: null };
}

/** One stored visitor message, end to end: the turn, then (when they gave their number) the WhatsApp send. Never throws. */
export async function processWebMessage(deps: WebDeps, rowId: string): Promise<WebAnswer> {
  const { db } = deps;
  const [row] = await db.select().from(channelInboundMessages).where(eq(channelInboundMessages.id, rowId));
  if (!row || row.channel !== WEB_CHANNEL) throw new Error(`web message ${rowId} vanished`);
  const msg = row.payload as WebMessageInput;
  const line = deps.copilotLine();
  await db.update(channelInboundMessages).set({ status: "processing", updatedAt: new Date() }).where(eq(channelInboundMessages.id, rowId));
  let reply = CHANNEL_FAILURE_TEXT;
  let failure: string | null = null;
  let handOff: WebAnswer["handOff"] = null;
  let runId: string | null = null;
  try {
    runId = await deps.createRootRun(line);
    const sessionId = await pickWebSession(db, line, msg.visitorId, runId);
    const [before] = await db.select({ channelPhone: sessions.channelPhone }).from(sessions).where(eq(sessions.id, sessionId));
    await db.update(channelInboundMessages).set({ sessionId, updatedAt: new Date() }).where(eq(channelInboundMessages.id, rowId));
    const { status, body } = await deps.runChat({ orgId: line.orgId, userId: line.userId, runId, sessionId, message: msg.text, channelMessageId: rowId, visitorId: msg.visitorId });
    ({ reply, failure } = webTurnOutcome(status, body));
    const [after] = await db.select({ channelPhone: sessions.channelPhone }).from(sessions).where(eq(sessions.id, sessionId));
    const phone = after?.channelPhone ?? null;
    // A number given in THIS turn: the answer is their first message on WhatsApp.
    // A number given earlier: every answer reaches them there too.
    if (!failure && phone) {
      handOff = await deliverOnWhatsapp(deps, { line, runId, phone, text: reply, key: `${row.messageId}:whatsapp`, firstTime: before?.channelPhone !== phone });
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    reply = CHANNEL_FAILURE_TEXT;
  }
  if (failure) console.error(`[chat-service] web message "${row.messageId}": turn failed: ${failure}`);
  await db
    .update(channelInboundMessages)
    .set({ status: failure ? "failed" : "answered", replyText: reply, error: failure, sentAt: failure ? null : new Date(), updatedAt: new Date() })
    .where(eq(channelInboundMessages.id, rowId));
  return { reply, handOff, failed: failure !== null };
}

async function deliverOnWhatsapp(
  deps: Pick<WebDeps, "reachWhatsapp" | "sendWhatsapp">,
  args: { line: CopilotLine; runId: string; phone: string; text: string; key: string; firstTime: boolean },
): Promise<NonNullable<WebAnswer["handOff"]>> {
  try {
    const reach = await deps.reachWhatsapp({ line: args.line, runId: args.runId, phone: args.phone });
    if (!reach.reachable) {
      console.error(`[chat-service] web hand-off to ${args.phone}: not reachable on WhatsApp (${reach.code}): ${reach.error}`);
      return { channel: "whatsapp", delivered: false, reason: reach.code };
    }
    await deps.sendWhatsapp({ ...args.line, runId: args.runId, phone: args.phone, fromAccount: reach.fromAccount, text: toWhatsappText(args.text), idempotencyKey: args.key });
    return { channel: "whatsapp", delivered: true, reason: null };
  } catch (err) {
    const code = err instanceof WhatsappSendError ? err.code : null;
    if (!isIntendedSilence(code)) console.error(`[chat-service] web hand-off to ${args.phone}: WhatsApp send failed: ${err instanceof Error ? err.message : String(err)}`);
    return { channel: "whatsapp", delivered: false, reason: code ?? "send_failed" };
  }
}

function shownChoices(c: ChoicesRecord | null): ChannelTurnResult["choices"] {
  if (!c) return null;
  return {
    ...(c.question ? { question: c.question } : {}),
    choices: c.choices.map((x) => ({ label: x.label, ...(x.description ? { description: x.description } : {}) })),
  };
}

/** The conversation the page shows on load: shown messages, oldest first, as plain text. */
export async function readWebConversation(db: typeof Db, visitorId: string) {
  const state = await readWebState(db, visitorId);
  if (!state.sessionId) return { visitorId, messages: [], ...webSignals(state) };
  const rows = await db.select().from(messages).where(eq(messages.sessionId, state.sessionId)).orderBy(asc(messages.createdAt), asc(messages.id));
  const shown = rows
    .filter((m) => (m.role === "user" || m.role === "assistant") && isShownMessage(m))
    .map((m) => ({
      role: m.role === "user" ? ("visitor" as const) : ("assistant" as const),
      text: m.role === "assistant" ? renderChannelReply({ text: m.content, choices: shownChoices(m.choices), inputLabel: null, creditsRequired: null, error: null }, toPlainText) : m.content,
      at: m.createdAt.toISOString(),
    }))
    .filter((m) => m.text.trim());
  return { visitorId, messages: shown, ...webSignals(state) };
}
