/**
 * The Copilot in our public site's pages (DISTRY-WEB-CHAT-1117, owner 2026-11-17:
 * « tout centralisé en terme de skill de communication quel que soit le canal »;
 * DISTRY-ONE-AI-1118, owner 2026-11-18: « Je veux une unique AI quel que soit le
 * canal. Ça veut dire qu'on peut onboarder des gens depuis le widget sans qu'ils
 * aient besoin d'aller sur la page signup »).
 *
 * A visitor clicks the avatar on distribute.you and talks to the SAME assistant
 * as on WhatsApp and email: same config, voice, skill index and tools, keyed on
 * who they are (agent/person-tools.ts). Only the FORM differs (the web block
 * below), plus one delivery tool: `continue_on_channel`.
 *
 *  1. the site's server calls POST /internal/copilot/web-messages with the
 *     visitor's opaque id (its own first-party cookie) and their words;
 *  2. the visitor id finds the conversation: one Copilot session per visitor
 *     (`sessions.web_visitor_id`). Until they prove an email it is a GUEST
 *     session under distribute.you's own org (the Copilot's line,
 *     `COPILOT_FOLLOWUP_*`);
 *  3. the turn runs through POST /chat on this process, on a `copilot-web`
 *     support run, and its answer is the HTTP response;
 *  4. a visitor who signs up or in (email code, channel-sign-in.ts) re-keys the
 *     session to their account: the answer with that access comes in the SAME
 *     response, and every later message runs under THEIR identity (their org
 *     pays its own turns). The cookie then carries account access: a session
 *     idle for WEB_ACCOUNT_IDLE_MAX_MS is not picked again (they prove the
 *     email again);
 *  5. a number or email a guest gives to continue elsewhere is tied to the
 *     session (`channel_phone` / `channel_email`): answers also leave on
 *     WhatsApp from the Copilot's own line, or the conversation goes to their
 *     thread in crm (a Lead event writes by email).
 *
 * No answer count walls a visitor (the 12-answer wall protected ~1 cent: an
 * answer costs $0.0003 to $0.0014, measured 2026-11-18). What bounds anonymous
 * spend is a guard: a speed limit per visitor and a daily breaker on GUEST
 * turns (OWASP LLM10, unbounded consumption). Refusals are stored and served
 * in the daily reply series (Monitoring).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, count, desc, eq, gte, ne } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { channelInboundMessages, messages, sessions } from "../db/schema.js";
import {
  CHANNEL_FAILURE_TEXT,
  CONVERSATION_LINES,
  identityLines,
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
import { WEB_CONTINUE_TOOL_NAME } from "../agent/person-tools.js";

export { WEB_CONTINUE_TOOL_NAME };

export const WEB_CHANNEL = "web";
export const WEB_TASK_NAME = "copilot-web";
/** The speed guard: a visitor gets at most this many answers per window. A person onboarding never types that fast; a script does. */
export const WEB_SPEED_MAX_MESSAGES = 20;
export const WEB_SPEED_WINDOW_MS = 10 * 60_000;
/**
 * The daily breaker on GUEST turns (they run on our own org's money): at the
 * ~0.1 cent an answer costs (measured), the default bounds a day at about $5.
 * A signed-in visitor's turns are billed to their org and never counted.
 */
export const WEB_GUEST_DAILY_TURN_CAP_DEFAULT = 5000;
/** An account-bound web session idle this long is not picked again for its visitor: the cookie alone no longer opens the account. */
export const WEB_ACCOUNT_IDLE_MAX_MS = 30 * 86_400_000;
/** A turn still "processing" after this long was cut (a restart): its retry is answered as failed, never `in_progress` forever. */
export const WEB_TURN_STALE_MS = 10 * 60_000;
/** The hidden trigger of the answer that follows a sign-in at once (never the visitor's words). */
export const WEB_AFTER_SIGN_IN_TRIGGER = "(They just signed in, in this same exchange. Answer now, with their account, what they asked before signing in.)";
export const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const SITE_URL = "https://distribute.you";
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.distribute.you";

/** The daily cap on guest answers, tunable without a deploy of code (`WEB_GUEST_DAILY_TURN_CAP`). */
export function webGuestDailyTurnCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WEB_GUEST_DAILY_TURN_CAP;
  if (raw === undefined || raw.trim() === "") return WEB_GUEST_DAILY_TURN_CAP_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`WEB_GUEST_DAILY_TURN_CAP must be a whole number of answers a day, got "${raw}"`);
  return n;
}

/** What /chat knows of a website turn when it builds the block. */
export interface WebTurnFacts {
  whatsapp: string | null;
  email?: string | null;
  /** No account acts in this turn (the visitor has not proved an email). */
  guest: boolean;
  /** This turn is the answer that follows their sign-in at once. */
  afterSignIn?: boolean;
}

/**
 * The turn context block of a website turn: the FORM of this surface, the
 * shared identity lines (channel-copilot.ts `identityLines`, the same builder
 * as WhatsApp and Telegram) and the hand-off as a delivery fact. Never a
 * website-only rule about what the assistant knows or may do.
 */
export function buildWebBlock(state: WebTurnFacts): string {
  const lines = [
    "\n\n---\n## Channel: our website (this turn)",
    `You are answering a visitor of ${SITE_URL}, in the chat window of the page they are reading. You are the distribute.you Copilot: same person, same rules, same personality as on WhatsApp and email.`,
    "The chat window shows plain text only: no markup at all (no *, no _, no tables, no headings, no markdown links). Write short messages, like a person in a chat. A link you give, a payment link included, is written as the plain URL. Never use the long dash characters.",
    "Clickable choices (present_choices) are shown as buttons under your message: the visitor clicks one or answers in words.",
    `Pages you open (open_page) cannot be shown here: when a page helps, give the link ${DASHBOARD_URL}.`,
    ...CONVERSATION_LINES,
    ...identityLines({ guest: state.guest, place: "This conversation", numberKnown: false, canSignIn: true, afterSignIn: state.afterSignIn === true }),
  ];
  if (state.whatsapp) {
    lines.push(
      `They gave their WhatsApp number (${state.whatsapp}) earlier in this conversation: your answers here also reach them there. Never ask for it again.`,
    );
  }
  if (state.email) {
    lines.push(`They gave their email (${state.email}) earlier in this conversation: it continues by email too. Never ask for it again.`);
  }
  if (state.guest && !state.whatsapp && !state.email) {
    lines.push(
      `When the conversation would go on better somewhere they keep (they want to think it over, come back later, be told when something is ready), you may offer once to continue on WhatsApp or by email. ` +
        `When THEY give their WhatsApp number or their email to continue there, call ${WEB_CONTINUE_TOOL_NAME} with it before you answer. A number: your answer also reaches them on WhatsApp, as the next message of this same conversation, so say in a few words that you are writing from there now. An email: our next message reaches them by email shortly, following up on this conversation, so say that in plain words.`,
    );
  }
  return lines.join("\n");
}

export const WEB_CONTINUE_TOOL: Anthropic.Tool = {
  name: WEB_CONTINUE_TOOL_NAME,
  description:
    "The visitor gave their WhatsApp number or their email to continue this conversation there. Call it BEFORE your answer, with exactly one of phone / email, as they wrote it. " +
    "A number (international form with the country code, +33612345678): your answer of this turn is also sent to them on WhatsApp, and when they answer there you read this whole conversation. " +
    "An email: this conversation is handed to our team's thread for them, and our next message reaches them by email shortly, following up on what was said here; their reply continues it. " +
    "Only a handle THEY gave for themselves, never one you guessed. It only moves the conversation: creating their account is start_sign_in. A refusal comes back as {refused, reason, error}: then answer here and, when it was unreadable, ask for it again once.",
  input_schema: {
    type: "object" as const,
    properties: {
      phone: { type: "string", description: "Their WhatsApp number, international form with the country code (+33612345678). One of phone / email." },
      email: { type: "string", description: "Their email address. One of phone / email." },
    },
  },
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** PURE: the handle the model passed, normalized, or why it is refused. */
export function parseContinueArgs(
  args: Record<string, unknown>,
): { ok: true; phone: string } | { ok: true; email: string } | { ok: false; refused: Record<string, unknown> } {
  const rawEmail = typeof args.email === "string" ? args.email.trim() : "";
  const hasPhone = typeof args.phone === "string" && args.phone.trim() !== "";
  if (rawEmail && hasPhone) {
    return { ok: false, refused: { refused: true, reason: "one_handle", error: "Give exactly one of phone or email per call." } };
  }
  if (rawEmail) {
    const email = rawEmail.toLowerCase();
    if (!EMAIL.test(email) || email.length > 320) {
      return { ok: false, refused: { refused: true, reason: "unreadable_email", error: `"${rawEmail}" is not an email address. Ask for it once more.` } };
    }
    return { ok: true, email };
  }
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

export interface WebIdentity {
  orgId: string;
  userId: string;
}

export interface WebDeps {
  db: typeof Db;
  /** The Copilot's own line (distribute.you's org, brand and the user its work runs under). */
  copilotLine: () => CopilotLine;
  /** runs-service: a root Copilot support run under the identity the turn runs as (our line for a guest, the account once signed in). */
  createRootRun: (identity: WebIdentity) => Promise<string>;
  /** POST /chat on this process, unlocked by the stored message row. */
  runChat: (args: { orgId: string; userId: string; runId: string; sessionId: string; message: string; channelMessageId: string; visitorId: string }) => Promise<{ status: number; body: string }>;
  /** crm-service POST /orgs/whatsapp/reach on the Copilot's own line. */
  reachWhatsapp: (args: { line: CopilotLine; runId: string; phone: string }) => Promise<WhatsappReach>;
  /** crm-service POST /orgs/whatsapp/messages. Throws when it did not leave. */
  sendWhatsapp: (args: { orgId: string; brandId: string; userId: string; runId: string | null; phone: string; fromAccount: string; text: string; idempotencyKey: string }) => Promise<void>;
  /** crm-service POST /internal/copilot/web-conversations: the page conversation onto the person's thread (a Lead event writes by email). */
  handOverByEmail: (body: WebHandOverBody) => Promise<{ status: string }>;
  now?: () => Date;
  /** Test hook: the daily cap on guest answers (default: `webGuestDailyTurnCap()`). */
  guestDailyTurnCap?: () => number;
}

export interface WebMessageInput {
  visitorId: string;
  messageId: string;
  text: string;
}

export type WebChoices = { question?: string; choices: { label: string; description?: string }[] };
export type WebHandOff = { channel: "whatsapp" | "email"; delivered: boolean; reason: string | null };
export type WebAccount = { signedIn: boolean; email: string | null };

/** What the page reads beside an answer: where the conversation also goes on, and whose account acts. */
export interface WebFacts {
  continuedOn: "whatsapp" | "email" | null;
  account: WebAccount;
}

/** The answer of one visitor message, as served AND as stored on its row (a retry reads it back byte-equal). */
export interface WebStoredAnswer extends WebFacts {
  reply: string | null;
  choices: WebChoices | null;
  handOff: WebHandOff | null;
}

export interface WebMessageResponse extends WebStoredAnswer {
  status: "answered" | "failed" | "busy" | "in_progress";
}

export interface WebHandOverBody {
  conversationId: string;
  visitorId: string;
  email: string;
  phone?: string;
  messages: Array<{ messageId: string; role: "user" | "assistant"; text: string; at: string }>;
}

type SessionRow = typeof sessions.$inferSelect;

/** PURE: a session the visitor id may still open. An account-bound one idle past the limit is not: they prove the email again. */
export function isLiveWebSession(s: Pick<SessionRow, "guest" | "updatedAt">, now: Date): boolean {
  return s.guest || now.getTime() - s.updatedAt.getTime() <= WEB_ACCOUNT_IDLE_MAX_MS;
}

/** The visitor's conversation: their latest Copilot session, null before their first message or once an account session went idle. */
export async function findWebSession(db: typeof Db, visitorId: string, now: Date = new Date()) {
  const [s] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.webVisitorId, visitorId), eq(sessions.configKey, COPILOT_CONFIG_KEY)))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);
  return s && isLiveWebSession(s, now) ? s : null;
}

/** PURE: the identity a visitor's turn runs as: their account once they signed in, else our own line. */
export function webIdentityOf(session: Pick<SessionRow, "guest" | "orgId" | "userId"> | null, line: WebIdentity): WebIdentity & { guest: boolean } {
  if (session && !session.guest && session.userId) return { orgId: session.orgId, userId: session.userId, guest: false };
  return { orgId: line.orgId, userId: line.userId, guest: true };
}

/** PURE: what the page reads about the conversation. */
export function webFacts(session: Pick<SessionRow, "guest" | "userId" | "channelPhone" | "channelEmail" | "webAccountEmail"> | null): WebFacts {
  const signedIn = Boolean(session && !session.guest && session.userId);
  return {
    continuedOn: session?.channelPhone ? "whatsapp" : session?.channelEmail ? "email" : null,
    account: { signedIn, email: signedIn ? session?.webAccountEmail ?? null : null },
  };
}

export async function readWebFacts(db: typeof Db, visitorId: string, now: Date = new Date()): Promise<WebFacts> {
  return webFacts(await findWebSession(db, visitorId, now));
}

export type WebAccept =
  | { status: "accepted"; rowId: string }
  | { status: "duplicate"; rowId: string }
  | { status: "busy"; reason: "speed" | "daily" };

/** PURE: the guard's verdict from the stored counts (null = the message runs). */
export function webGuardVerdict(a: { visitorRecent: number; guest: boolean; guestToday: number; dailyCap: number }): "speed" | "daily" | null {
  if (a.visitorRecent >= WEB_SPEED_MAX_MESSAGES) return "speed";
  if (a.guest && a.guestToday >= a.dailyCap) return "daily";
  return null;
}

/**
 * One visitor message: stored once (a retry of the same messageId runs nothing
 * twice), or refused by the guard before any spend. A refusal is stored too
 * (status `refused`): the daily series counts it, and its retry answers `busy`.
 */
export async function acceptWebMessage(deps: Pick<WebDeps, "db" | "copilotLine" | "now" | "guestDailyTurnCap">, msg: WebMessageInput): Promise<WebAccept> {
  const { db } = deps;
  const key = `web:${msg.visitorId}:${msg.messageId}`;
  const [existing] = await db.select({ id: channelInboundMessages.id }).from(channelInboundMessages).where(eq(channelInboundMessages.messageId, key));
  if (existing) return { status: "duplicate", rowId: existing.id };
  const now = deps.now?.() ?? new Date();
  const line = deps.copilotLine();
  const identity = webIdentityOf(await findWebSession(db, msg.visitorId, now), line);
  const [recent] = await db
    .select({ n: count() })
    .from(channelInboundMessages)
    .where(
      and(
        eq(channelInboundMessages.channel, WEB_CHANNEL),
        eq(channelInboundMessages.senderPhone, msg.visitorId),
        ne(channelInboundMessages.status, "refused"),
        gte(channelInboundMessages.createdAt, new Date(now.getTime() - WEB_SPEED_WINDOW_MS)),
      ),
    );
  let guestToday = 0;
  if (identity.guest) {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // Guest turns run under our line's identity: its org on the row is what marks them.
    const [today] = await db
      .select({ n: count() })
      .from(channelInboundMessages)
      .where(
        and(
          eq(channelInboundMessages.channel, WEB_CHANNEL),
          eq(channelInboundMessages.orgId, line.orgId),
          ne(channelInboundMessages.status, "refused"),
          gte(channelInboundMessages.createdAt, dayStart),
        ),
      );
    guestToday = Number(today?.n ?? 0);
  }
  const refusedBy = webGuardVerdict({
    visitorRecent: Number(recent?.n ?? 0),
    guest: identity.guest,
    guestToday,
    dailyCap: (deps.guestDailyTurnCap ?? webGuestDailyTurnCap)(),
  });
  const [row] = await db
    .insert(channelInboundMessages)
    .values({
      messageId: key,
      channel: WEB_CHANNEL,
      senderPhone: msg.visitorId,
      orgId: identity.orgId,
      userId: identity.userId,
      status: refusedBy ? "refused" : "received",
      error: refusedBy ? `guard:${refusedBy}` : null,
      payload: msg,
    })
    .onConflictDoNothing({ target: channelInboundMessages.messageId })
    .returning({ id: channelInboundMessages.id });
  if (!row) {
    const [raced] = await db.select({ id: channelInboundMessages.id }).from(channelInboundMessages).where(eq(channelInboundMessages.messageId, key));
    return { status: "duplicate", rowId: raced!.id };
  }
  if (refusedBy) {
    console.warn(`[chat-service] web message from visitor ${msg.visitorId} refused by the guard (${refusedBy}): nothing ran`);
    return { status: "busy", reason: refusedBy };
  }
  return { status: "accepted", rowId: row.id };
}

/**
 * A message the site sent again (its wait was cut, it polls): `in_progress` at
 * once while the first is still running, then the FULL stored answer, byte-equal
 * to what the first call returned. A turn a restart cut is said failed.
 */
export async function answerOfStoredMessage(deps: Pick<WebDeps, "db" | "now">, rowId: string, visitorId: string): Promise<WebMessageResponse> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const [row] = await db.select().from(channelInboundMessages).where(eq(channelInboundMessages.id, rowId));
  if (!row) throw new Error(`web message ${rowId} vanished`);
  const stored = row.answer as WebStoredAnswer | null;
  if (row.status === "refused") return { status: "busy", reply: null, choices: null, handOff: null, ...(await readWebFacts(db, visitorId, now)) };
  if (row.status === "received" || row.status === "processing") {
    if (now.getTime() - row.updatedAt.getTime() <= WEB_TURN_STALE_MS) {
      return { status: "in_progress", reply: null, choices: null, handOff: null, ...(await readWebFacts(db, visitorId, now)) };
    }
    const answer: WebStoredAnswer = { reply: CHANNEL_FAILURE_TEXT, choices: null, handOff: null, ...(await readWebFacts(db, visitorId, now)) };
    console.error(`[chat-service] web message "${row.messageId}" was still ${row.status} after ${WEB_TURN_STALE_MS}ms (cut by a restart): answered as failed`);
    await db
      .update(channelInboundMessages)
      .set({ status: "failed", replyText: answer.reply, error: "the turn was cut before it answered", answer, updatedAt: now })
      .where(eq(channelInboundMessages.id, rowId));
    return { status: "failed", ...answer };
  }
  if (!stored) throw new Error(`web message "${row.messageId}" is ${row.status} with no stored answer`);
  return { status: row.status === "answered" ? "answered" : "failed", ...orderedAnswer(stored) };
}

/** PURE: the answer with every key in one fixed order, so a stored answer read back (jsonb reorders keys) serializes byte-equal to the first response. */
export function orderedAnswer(a: WebStoredAnswer): WebStoredAnswer {
  return {
    reply: a.reply,
    choices: a.choices
      ? {
          ...(a.choices.question ? { question: a.choices.question } : {}),
          choices: a.choices.choices.map((c) => ({ label: c.label, ...(c.description ? { description: c.description } : {}) })),
        }
      : null,
    handOff: a.handOff ? { channel: a.handOff.channel, delivered: a.handOff.delivered, reason: a.handOff.reason } : null,
    continuedOn: a.continuedOn,
    account: { signedIn: a.account.signedIn, email: a.account.email },
  };
}

const visitorQueues = new Map<string, Promise<unknown>>();

/** Test hook: how many visitors hold a turn right now. */
export function busyVisitors(): number {
  return visitorQueues.size;
}

/**
 * One message from the site, to its answer. A visitor's turns run one at a
 * time. The turn belongs to the VISITOR, never to the request that brought it:
 * nothing here listens to the caller's connection, so a wait the site cuts (an
 * onboarding turn can run past the browser path's 100 s) leaves the turn running
 * to its end, and the site reads the answer by sending the same messageId again.
 */
export async function answerWebMessage(deps: WebDeps, msg: WebMessageInput): Promise<WebMessageResponse> {
  const accepted = await acceptWebMessage(deps, msg);
  if (accepted.status === "busy") {
    return { status: "busy", reply: null, choices: null, handOff: null, ...(await readWebFacts(deps.db, msg.visitorId, deps.now?.() ?? new Date())) };
  }
  // Answered at once, never queued behind the turn it asks about.
  if (accepted.status === "duplicate") return answerOfStoredMessage(deps, accepted.rowId, msg.visitorId);
  const previous = visitorQueues.get(msg.visitorId) ?? Promise.resolve();
  const mine = previous.catch(() => undefined).then(() => processWebMessage(deps, accepted.rowId));
  visitorQueues.set(msg.visitorId, mine);
  try {
    const { failed, ...answer } = await mine;
    return { status: failed ? "failed" : "answered", ...orderedAnswer(answer) };
  } finally {
    if (visitorQueues.get(msg.visitorId) === mine) visitorQueues.delete(msg.visitorId);
  }
}

/** The visitor's session, created on their first message (guest, our org, tied to the visitor id). */
export async function pickWebSession(db: typeof Db, line: CopilotLine, visitorId: string, runId: string, now: Date = new Date()): Promise<string> {
  const existing = await findWebSession(db, visitorId, now);
  if (existing) return existing.id;
  const [created] = await db
    .insert(sessions)
    .values({ orgId: line.orgId, userId: line.userId, parentRunId: runId, configKey: COPILOT_CONFIG_KEY, guest: true, webVisitorId: visitorId, brandIds: [line.brandId] })
    .returning({ id: sessions.id });
  return created.id;
}

/** The /chat answer as the page shows it: the text (plain), the choices apart (the page draws buttons), or the failure line + why. */
export function webTurnOutcome(status: number, body: string): { reply: string; choices: WebChoices | null; failure: string | null } {
  if (status !== 200) return { reply: CHANNEL_FAILURE_TEXT, choices: null, failure: `POST /chat ${status}: ${body.slice(0, 500)}` };
  const turn = parseChatStream(body);
  if (turn.error && !turn.text) return { reply: CHANNEL_FAILURE_TEXT, choices: null, failure: `chat stream error: ${turn.error}` };
  if (!turn.text.trim() && !turn.choices) return { reply: CHANNEL_FAILURE_TEXT, choices: null, failure: "the turn answered nothing" };
  const choices = turn.choices ? plainChoices(turn.choices) : null;
  const text = turn.text.trim() || turn.inputLabel || turn.creditsRequired ? renderChannelReply({ ...turn, choices: null }, toPlainText) : "";
  // Cards with no text of their own: their question is the message above the buttons.
  if (!text && choices?.question) return { reply: choices.question, choices: { choices: choices.choices }, failure: null };
  return { reply: text, choices, failure: null };
}

function plainChoices(c: NonNullable<ChannelTurnResult["choices"]>): WebChoices {
  return {
    ...(c.question ? { question: toPlainText(c.question) } : {}),
    choices: c.choices.map((x) => ({ label: toPlainText(x.label), ...(x.description ? { description: toPlainText(x.description) } : {}) })),
  };
}

/** PURE: an answer with its choices as a numbered list, for a surface that draws no button (WhatsApp, the history). */
export function withChoicesList(reply: string, choices: WebChoices | null): string {
  if (!choices) return reply;
  const list = choices.choices.map((c, i) => `${i + 1}. ${c.label}${c.description ? ` (${c.description})` : ""}`).join("\n");
  return [reply, choices.question ?? "", list].filter(Boolean).join("\n\n");
}

export interface WebAnswer extends WebStoredAnswer {
  failed: boolean;
}

/**
 * One stored visitor message, end to end: the turn; when they signed in during
 * it, the answer with their account at once; then the hand-off when a number or
 * email is tied. The answer is stored on the row. Never throws.
 */
export async function processWebMessage(deps: WebDeps, rowId: string): Promise<WebAnswer> {
  const { db } = deps;
  const now = () => deps.now?.() ?? new Date();
  const [row] = await db.select().from(channelInboundMessages).where(eq(channelInboundMessages.id, rowId));
  if (!row || row.channel !== WEB_CHANNEL) throw new Error(`web message ${rowId} vanished`);
  const msg = row.payload as WebMessageInput;
  const line = deps.copilotLine();
  let reply = CHANNEL_FAILURE_TEXT;
  let choices: WebChoices | null = null;
  let failure: string | null = null;
  let handOff: WebHandOff | null = null;
  try {
    // The turn runs as the session's identity NOW (a sign-in in the message before this one already moved it).
    const { guest: asGuest, ...identity } = webIdentityOf(await findWebSession(db, msg.visitorId, now()), line);
    await db
      .update(channelInboundMessages)
      .set({ status: "processing", orgId: identity.orgId, userId: identity.userId, updatedAt: now() })
      .where(eq(channelInboundMessages.id, rowId));
    const runId = await deps.createRootRun(identity);
    const sessionId = await pickWebSession(db, line, msg.visitorId, runId, now());
    const [before] = await db.select({ channelPhone: sessions.channelPhone, guest: sessions.guest }).from(sessions).where(eq(sessions.id, sessionId));
    await db.update(channelInboundMessages).set({ sessionId, updatedAt: now() }).where(eq(channelInboundMessages.id, rowId));
    const first = await deps.runChat({ orgId: identity.orgId, userId: identity.userId, runId, sessionId, message: msg.text, channelMessageId: rowId, visitorId: msg.visitorId });
    ({ reply, choices, failure } = webTurnOutcome(first.status, first.body));
    let [after] = await db
      .select({ orgId: sessions.orgId, userId: sessions.userId, guest: sessions.guest, channelPhone: sessions.channelPhone, channelEmail: sessions.channelEmail })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    // They signed up or in during this turn (complete_sign_in re-keyed the
    // session): the answer with their account comes in the SAME response, in a
    // run of their own org. Its failure never hides that they are in.
    if (!failure && before?.guest && after && !after.guest && after.userId) {
      const account = { orgId: after.orgId, userId: after.userId };
      await db
        .update(channelInboundMessages)
        .set({ orgId: account.orgId, userId: account.userId, signedIn: true, updatedAt: now() })
        .where(eq(channelInboundMessages.id, rowId));
      try {
        const second = await deps.runChat({ ...account, runId: await deps.createRootRun(account), sessionId, message: WEB_AFTER_SIGN_IN_TRIGGER, channelMessageId: rowId, visitorId: msg.visitorId });
        const next = webTurnOutcome(second.status, second.body);
        if (next.failure) throw new Error(next.failure);
        reply = [reply, next.reply].filter(Boolean).join("\n\n");
        choices = next.choices;
      } catch (err) {
        console.error(`[chat-service] web message "${row.messageId}": signed in, but the answer with their account failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      [after] = await db
        .select({ orgId: sessions.orgId, userId: sessions.userId, guest: sessions.guest, channelPhone: sessions.channelPhone, channelEmail: sessions.channelEmail })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
    }
    const phone = after?.channelPhone ?? null;
    const email = after?.channelEmail ?? null;
    // An email given (this turn or before): the page conversation so far goes on
    // their thread in crm, whose Lead event campaign writes them by email. Every
    // later turn re-hands it (crm keeps one thread, one Lead event).
    if (!failure && email) {
      handOff = await handOverConversation(deps, { sessionId, visitorId: msg.visitorId, email, phone });
    }
    // A number given in THIS turn: the answer is their first message on WhatsApp.
    // A number given earlier: every answer reaches them there too. The send is the
    // line's own work: a run under the line, never a person-org run (runs-service 409).
    if (!failure && phone) {
      const lineRunId = asGuest ? runId : await deps.createRootRun({ orgId: line.orgId, userId: line.userId });
      handOff = await deliverOnWhatsapp(deps, { line, runId: lineRunId, phone, text: withChoicesList(reply, choices), key: `${row.messageId}:whatsapp`, firstTime: before?.channelPhone !== phone });
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    reply = CHANNEL_FAILURE_TEXT;
    choices = null;
  }
  if (failure) console.error(`[chat-service] web message "${row.messageId}": turn failed: ${failure}`);
  let facts: WebFacts = { continuedOn: null, account: { signedIn: false, email: null } };
  try {
    facts = await readWebFacts(db, msg.visitorId, now());
  } catch (err) {
    console.error(`[chat-service] web message "${row.messageId}": the conversation's facts could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const answer = orderedAnswer({ reply, choices, handOff, ...facts });
  await db
    .update(channelInboundMessages)
    .set({ status: failure ? "failed" : "answered", replyText: reply, error: failure, answer, sentAt: failure ? null : now(), updatedAt: now() })
    .where(eq(channelInboundMessages.id, rowId));
  return { ...answer, failed: failure !== null };
}

/** The conversation as crm-service takes it: every shown message, oldest first, as the page shows it. */
export async function conversationForHandOver(db: typeof Db, sessionId: string): Promise<WebHandOverBody["messages"]> {
  const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.createdAt), asc(messages.id));
  return rows
    .filter((m) => (m.role === "user" || m.role === "assistant") && isShownMessage(m))
    .map((m) => ({
      messageId: m.id,
      role: m.role as "user" | "assistant",
      text: m.role === "assistant" ? renderChannelReply({ text: m.content, choices: shownChoices(m.choices), inputLabel: null, creditsRequired: null, error: null }, toPlainText) : m.content,
      at: m.createdAt.toISOString(),
    }))
    .filter((m) => m.text.trim())
    .slice(-500);
}

async function handOverConversation(
  deps: Pick<WebDeps, "db" | "handOverByEmail">,
  args: { sessionId: string; visitorId: string; email: string; phone: string | null },
): Promise<WebHandOff> {
  try {
    const conversation = await conversationForHandOver(deps.db, args.sessionId);
    if (conversation.length === 0) return { channel: "email", delivered: false, reason: "empty_conversation" };
    const out = await deps.handOverByEmail({
      conversationId: args.sessionId,
      visitorId: args.visitorId,
      email: args.email,
      ...(args.phone ? { phone: args.phone } : {}),
      messages: conversation,
    });
    return { channel: "email", delivered: out.status !== "failed", reason: out.status === "failed" ? "lead_event_failed" : null };
  } catch (err) {
    console.error(`[chat-service] web hand-off to ${args.email}: crm-service refused the conversation: ${err instanceof Error ? err.message : String(err)}`);
    return { channel: "email", delivered: false, reason: "handover_failed" };
  }
}

/** crm-service POST /internal/copilot/web-conversations (service key, no identity headers). */
export async function handOverByEmailToCrm(body: WebHandOverBody, fetchImpl: typeof fetch = fetch): Promise<{ status: string }> {
  const url = process.env.CRM_SERVICE_URL;
  const key = process.env.CRM_SERVICE_API_KEY;
  if (!url || !key) throw new Error("CRM_SERVICE_URL / CRM_SERVICE_API_KEY not configured");
  const res = await fetchImpl(`${url}/internal/copilot/web-conversations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`crm-service web-conversations ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text) as { status?: unknown };
  if (typeof json.status !== "string") throw new Error(`crm-service web-conversations answered no status: ${text.slice(0, 300)}`);
  return { status: json.status };
}

async function deliverOnWhatsapp(
  deps: Pick<WebDeps, "reachWhatsapp" | "sendWhatsapp">,
  args: { line: CopilotLine; runId: string; phone: string; text: string; key: string; firstTime: boolean },
): Promise<WebHandOff> {
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

/** The conversation the page shows on load: shown messages, oldest first, as plain text (choices as a numbered list). */
export async function readWebConversation(db: typeof Db, visitorId: string, now: Date = new Date()) {
  const session = await findWebSession(db, visitorId, now);
  if (!session) return { visitorId, messages: [], ...webFacts(null) };
  const rows = await db.select().from(messages).where(eq(messages.sessionId, session.id)).orderBy(asc(messages.createdAt), asc(messages.id));
  const shown = rows
    .filter((m) => (m.role === "user" || m.role === "assistant") && isShownMessage(m))
    .map((m) => ({
      role: m.role === "user" ? ("visitor" as const) : ("assistant" as const),
      text: m.role === "assistant" ? renderChannelReply({ text: m.content, choices: shownChoices(m.choices), inputLabel: null, creditsRequired: null, error: null }, toPlainText) : m.content,
      at: m.createdAt.toISOString(),
    }))
    .filter((m) => m.text.trim());
  return { visitorId, messages: shown, ...webFacts(session) };
}
