/**
 * The Copilot on Telegram (SOPHIE-TELEGRAM-1103, owner 2026-11-03): a client
 * who linked their org's Telegram through the platform bot (dashboard card
 * "Telegram updates", one-time code) writes to the bot and Sophie answers in
 * that chat, as on WhatsApp: same agent, same skills and tools, same billing.
 *
 *  1. the platform bot's webhook (distribute.you landing app) hands every
 *     message a chat other than the team's writes to POST
 *     /internal/copilot/telegram-messages;
 *  2. the chat IS the identity: client-service names the org it is linked to
 *     and the member who linked it (newest link first);
 *  3. the turn runs through POST /chat on this process as that member, in their
 *     latest Copilot session (the thread the web shows: one memory), billed to
 *     their org on a Copilot support run, like a WhatsApp turn;
 *  4. the answer goes back to the chat that wrote, through the platform bot, as
 *     plain text.
 *
 * A chat linked to NO account is a visitor who opened the bot from our site
 * (DISTRY-START-DOOR-1125, owner 2026-11-25: three doors, WhatsApp / Telegram /
 * email, the dashboard goes away): it talks with the same Distry as a GUEST,
 * exactly like a website visitor or an unknown WhatsApp sender. One guest
 * session per chat (`sessions.telegram_chat_id`) under our own line; Distry
 * signs them up or in with the one agent-signup (email code, channel-sign-in.ts),
 * which re-keys the session to their account, answers at once with that access,
 * and links the chat to their org (client-service's own link code, made and
 * used here: nothing for them to type). `/start` (the bot's deep link, with
 * their website when the page knew it: `site-<base64url>`) opens the
 * conversation without words of theirs.
 *
 * Only the FORM differs from the other surfaces (one Sophie, the channel is a
 * detail): the Telegram block below says how to write here, the strategy lines
 * are the WhatsApp ones.
 */
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { channelInboundMessages, messages, sessions } from "../db/schema.js";
import type { TelegramMessageRequest } from "../schemas.js";
import {
  CHANNEL_FAILURE_TEXT,
  CONVERSATION_LINES,
  PAGE_LINKS_LINE,
  identityLines,
  parseChatStream,
  renderChannelReply,
  toPlainText,
} from "./channel-copilot.js";
import { COPILOT_CONFIG_KEY } from "./copilot-unibox.js";
import type { CopilotLine } from "./copilot-proactive.js";
import type { DistryGate } from "./distry-spend.js";

export const TELEGRAM_CHANNEL = "telegram";
export const TELEGRAM_TASK_NAME = "copilot-telegram";

/** A photo, voice note or file with no text: no turn runs, the person is told in one line. */
export const TELEGRAM_TEXT_ONLY =
  "I can only read text messages here for now. Please write your message and I will answer right away.";

export function telegramMessageKey(chatId: string, messageId: string): string {
  return `telegram:${chatId}:${messageId}`;
}

/** The turn context block of a Telegram turn: the form of this surface, nothing else. */
export function buildTelegramBlock(): string {
  return [
    "\n\n---\n## Channel: Telegram (this turn)",
    "You are answering in Telegram, in the chat this person linked to their distribute.you account. You are the distribute.you Copilot: same person, same conversation as on the web, same rules, same personality.",
    "This chat shows plain text only: no markup at all (no *, no _, no tables, no headings, no markdown links: write the URL itself). Write short messages. Never use the long dash characters.",
    "Clickable choices (present_choices) are shown as a numbered list: the person answers with a number or in words.",
    PAGE_LINKS_LINE,
    ...CONVERSATION_LINES,
    ...identityLines({ guest: false, place: "This Telegram chat", numberKnown: false, canSignIn: false }),
  ].join("\n");
}

/** What /chat knows of a Telegram turn in a chat's own conversation (a chat that opened the bot with no account). */
export interface TelegramDoorFacts {
  /** No account of ours acts in this turn. */
  guest: boolean;
  /** This turn is the answer that follows their sign-in at once. */
  afterSignIn: boolean;
}

/**
 * The turn context block of a Telegram turn in a chat's own conversation: the
 * same form, and the shared identity lines (channel-copilot.ts `identityLines`,
 * the same builder as WhatsApp and the website) with the sign-in where the
 * conversation can become theirs. Never a Telegram-only rule about what Distry knows or does.
 */
export function buildTelegramDoorBlock(state: TelegramDoorFacts): string {
  return [
    "\n\n---\n## Channel: Telegram (this turn)",
    "You are answering in Telegram, in the chat this person opened with our bot. You are the distribute.you Copilot: same person, same rules, same personality as on the web, WhatsApp and email.",
    "This chat shows plain text only: no markup at all (no *, no _, no tables, no headings, no markdown links: write the URL itself). Write short messages. Never use the long dash characters.",
    "Clickable choices (present_choices) are shown as a numbered list: the person answers with a number or in words.",
    PAGE_LINKS_LINE,
    ...CONVERSATION_LINES,
    ...identityLines({ guest: state.guest, place: "This Telegram chat", numberKnown: false, canSignIn: true, afterSignIn: state.afterSignIn }),
  ].join("\n");
}

/** The prefix of the bot's start parameter that carries the visitor's website (Telegram allows [A-Za-z0-9_-], up to 64). */
export const TELEGRAM_SITE_PREFIX = "site-";
const WEBSITE = /^(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?$/i;

/**
 * PURE: the bot's deep link opened (`/start`, `/start site-<base64url of their
 * website>`): the conversation opens with no words of theirs. Null for any other
 * text. A parameter that is not a readable website opens it without one.
 */
export function telegramOpening(text: string | null | undefined): { website: string | null } | null {
  const m = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/.exec((text ?? "").trim());
  if (!m) return null;
  const param = m[1] ?? "";
  if (!param.startsWith(TELEGRAM_SITE_PREFIX)) return { website: null };
  const decoded = Buffer.from(param.slice(TELEGRAM_SITE_PREFIX.length), "base64url").toString("utf8").trim();
  return { website: WEBSITE.test(decoded) ? decoded : null };
}

/**
 * PURE: the deep link a page puts on its Telegram button, with the visitor's
 * website when it fits Telegram's 64 characters. Without one it is the bot
 * itself: Telegram sends `/start` when they tap Start.
 */
export function telegramStartLink(botUsername: string, website: string | null): string {
  const base = `https://t.me/${botUsername}`;
  if (!website?.trim()) return base;
  const param = TELEGRAM_SITE_PREFIX + Buffer.from(website.trim(), "utf8").toString("base64url");
  return param.length <= 64 ? `${base}?start=${param}` : base;
}

/** The hidden message of the opening turn (never their words). */
export function telegramOpeningTrigger(website: string | null): string {
  return `(Not their words: they just opened this chat from distribute.you to get started with you${website ? `, and their website is ${website}` : ""}. Greet them in one short line and take them to the first step.)`;
}

/** The hidden trigger of the answer that follows a sign-in at once (never their words); the website's own. */
export const TELEGRAM_AFTER_SIGN_IN_TRIGGER = "(They just signed in, in this same exchange. With their account, take them one step further from where they stopped.)";

// ---------------------------------------------------------------------------
// Dependencies (injected so the flow is testable without the network)
// ---------------------------------------------------------------------------

export interface TelegramChatLink {
  orgId: string;
  userId: string;
}

export interface TelegramDeps {
  db: typeof Db;
  /** The Copilot's own line (distribute.you's org, brand and the user its work runs under): who a guest's turn runs as. */
  copilotLine: () => CopilotLine;
  /** client-service: the orgs this chat is linked to, newest link first (empty = not linked). */
  resolveChat: (chatId: string) => Promise<TelegramChatLink[]>;
  listBrandIds: (identity: { orgId: string; userId: string; runId: string }) => Promise<string[]>;
  /** runs-service: a root Copilot support run under the person's org. */
  createRootRun: (identity: { orgId: string; userId: string }) => Promise<string>;
  /** POST /chat on this process as the person, unlocked by the stored message row. */
  runChat: (args: { orgId: string; userId: string; runId: string; sessionId: string; message: string; channelMessageId: string }) => Promise<{ status: number; body: string }>;
  /** The platform bot: one message to the chat that wrote. Throws when it did not leave. */
  sendReply: (args: { chatId: string; text: string }) => Promise<void>;
  /** client-service: this chat becomes the account's linked chat (a link code made and used at once). */
  linkChat: (args: { chatId: string; orgId: string; userId: string }) => Promise<void>;
  /** Distry's limits on our money (distry-spend.ts): a linked account that never paid stops at the day's non-client limit. */
  spend: DistryGate;
}

export type TelegramAccept =
  | { status: "duplicate" }
  | { status: "accepted"; rowId: string };

type SessionRow = typeof sessions.$inferSelect;

/** Who a chat's turn runs as: the member who linked it, else its own conversation's account, else a guest on our line. */
export type TelegramWho =
  | { kind: "linked"; orgId: string; userId: string; guest: false; session: null }
  | { kind: "door"; orgId: string; userId: string; guest: boolean; session: SessionRow | null };

/** The chat's own conversation (opened with no account), latest first. */
export async function findTelegramDoorSession(db: typeof Db, chatId: string): Promise<SessionRow | null> {
  const [s] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.telegramChatId, chatId), eq(sessions.configKey, COPILOT_CONFIG_KEY)))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);
  return s ?? null;
}

/**
 * Routing: a chat linked to an org runs as the member who linked it (the newest
 * link when several); a chat linked to none talks in its own conversation: as the
 * account it signed in to there, else as a guest on our line (DISTRY-START-DOOR-1125).
 */
export async function whoIsChat(deps: Pick<TelegramDeps, "db" | "resolveChat" | "copilotLine">, chatId: string): Promise<TelegramWho> {
  const [link] = await deps.resolveChat(chatId);
  if (link) return { kind: "linked", orgId: link.orgId, userId: link.userId, guest: false, session: null };
  const session = await findTelegramDoorSession(deps.db, chatId);
  if (session && !session.guest && session.userId) return { kind: "door", orgId: session.orgId, userId: session.userId, guest: false, session };
  const line = deps.copilotLine();
  return { kind: "door", orgId: line.orgId, userId: line.userId, guest: true, session };
}

/** Every Telegram message is stored once and answered; the same message twice (a webhook retry) is a `duplicate`. */
export async function acceptTelegramMessage(deps: Pick<TelegramDeps, "db" | "resolveChat" | "copilotLine">, msg: TelegramMessageRequest): Promise<TelegramAccept> {
  const who = await whoIsChat(deps, msg.chatId);
  const [row] = await deps.db
    .insert(channelInboundMessages)
    .values({
      messageId: telegramMessageKey(msg.chatId, msg.messageId),
      channel: TELEGRAM_CHANNEL,
      senderPhone: msg.chatId,
      orgId: who.orgId,
      userId: who.userId,
      status: "received",
      payload: msg,
    })
    .onConflictDoNothing({ target: channelInboundMessages.messageId })
    .returning({ id: channelInboundMessages.id });
  if (!row) return { status: "duplicate" };
  return { status: "accepted", rowId: row.id };
}

/** A chat's own conversation, opened on its first message: a guest under our line, tied to the chat. */
export async function openTelegramDoorSession(db: typeof Db, line: CopilotLine, chatId: string, runId: string): Promise<string> {
  const [created] = await db
    .insert(sessions)
    .values({ orgId: line.orgId, userId: line.userId, parentRunId: runId, configKey: COPILOT_CONFIG_KEY, guest: true, telegramChatId: chatId, brandIds: [line.brandId] })
    .returning({ id: sessions.id });
  return created.id;
}

/** The person's own Copilot thread (never a lead thread, never a guest one), else a new one. */
export async function pickTelegramSession(
  deps: Pick<TelegramDeps, "db" | "listBrandIds">,
  identity: { orgId: string; userId: string },
  runId: string,
): Promise<string> {
  const { db } = deps;
  const [latest] = await db
    .select({ id: sessions.id, brandIds: sessions.brandIds })
    .from(sessions)
    .where(
      and(
        eq(sessions.orgId, identity.orgId),
        eq(sessions.userId, identity.userId),
        eq(sessions.configKey, COPILOT_CONFIG_KEY),
        eq(sessions.guest, false),
        eq(sessions.leadThread, false),
      ),
    )
    .orderBy(desc(sessions.updatedAt))
    .limit(1);
  if (latest) return latest.id;
  const brandIds = await deps.listBrandIds({ ...identity, runId });
  const [created] = await db
    .insert(sessions)
    .values({
      orgId: identity.orgId,
      userId: identity.userId,
      parentRunId: runId,
      configKey: COPILOT_CONFIG_KEY,
      guest: false,
      brandIds: brandIds.length > 0 ? brandIds : null,
    })
    .returning({ id: sessions.id });
  return created.id;
}

/** The /chat answer as one Telegram message, or the failure line + why. */
export function telegramTurnOutcome(status: number, body: string): { replyText: string; failure: string | null } {
  if (status === 200) {
    const turn = parseChatStream(body);
    if (turn.error && !turn.text) return { replyText: CHANNEL_FAILURE_TEXT, failure: `chat stream error: ${turn.error}` };
    return { replyText: renderChannelReply(turn, toPlainText), failure: null };
  }
  if (status === 402) {
    // An org opened by the API agent signup is refused with a 402 JSON: still an answer.
    const json = JSON.parse(body || "{}") as Record<string, unknown>;
    const message = String(json.message ?? json.error ?? "You're out of credits. Add credits to keep going.");
    return {
      replyText: renderChannelReply({ text: "", choices: null, inputLabel: null, error: null, creditsRequired: { message, label: "Add credits" } }, toPlainText),
      failure: null,
    };
  }
  return { replyText: CHANNEL_FAILURE_TEXT, failure: `POST /chat ${status}: ${body.slice(0, 500)}` };
}

/** A turn past Distry's limits: the notice is the answer, no model ran. */
class DistryLimitReached extends Error {
  constructor(public readonly notice: string) {
    super("distry limit reached");
    this.name = "DistryLimitReached";
  }
}

/**
 * One stored message, end to end: the turn; when they signed in during it, the
 * chat is linked to their account and the answer with that access comes at once,
 * in place of the sign-in turn's words; then the reply in the chat. Never throws.
 */
export async function processTelegramMessage(deps: TelegramDeps, rowId: string): Promise<void> {
  const { db } = deps;
  const [row] = await db.select().from(channelInboundMessages).where(eq(channelInboundMessages.id, rowId));
  if (!row || row.channel !== TELEGRAM_CHANNEL || (row.status !== "received" && row.status !== "processing")) return;
  const msg = row.payload as TelegramMessageRequest;
  const chatId = row.senderPhone;
  let replyText = CHANNEL_FAILURE_TEXT;
  let failure: string | null = null;
  let limited: string | null = null;
  try {
    // Who the turn runs as NOW (a sign-in in the message before this one already moved it).
    const who = await whoIsChat(deps, chatId);
    const identity = { orgId: who.orgId, userId: who.userId };
    await db.update(channelInboundMessages).set({ status: "processing", ...identity, updatedAt: new Date() }).where(eq(channelInboundMessages.id, rowId));
    const opening = telegramOpening(msg.text);
    if (!msg.text?.trim()) {
      replyText = TELEGRAM_TEXT_ONLY;
    } else {
      // Distry's limits on our money: a guest under the visitor limit, an account that never paid under the day's.
      const verdict = await deps.spend.gate({
        key: who.guest ? `telegram:${chatId}` : `org:${identity.orgId}`,
        surface: "telegram",
        guest: who.guest,
        turnOrgId: identity.orgId,
        planOrgId: who.session?.planOrgId ?? null,
      });
      if (!verdict.run) {
        limited = `distry_limit:${verdict.reason}`;
        throw new DistryLimitReached(verdict.notice);
      }
      const runId = await deps.createRootRun(identity);
      const sessionId =
        who.kind === "linked"
          ? await pickTelegramSession(deps, identity, runId)
          : who.session?.id ?? (await openTelegramDoorSession(db, deps.copilotLine(), chatId, runId));
      const wasGuest = who.guest;
      await db.update(channelInboundMessages).set({ sessionId, updatedAt: new Date() }).where(eq(channelInboundMessages.id, rowId));
      const message = opening ? telegramOpeningTrigger(opening.website) : msg.text;
      const first = await deps.runChat({ ...identity, runId, sessionId, message, channelMessageId: rowId });
      ({ replyText, failure } = telegramTurnOutcome(first.status, first.body));
      const [after] = await db
        .select({ orgId: sessions.orgId, userId: sessions.userId, guest: sessions.guest, planOrgId: sessions.planOrgId })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      await deps.spend.record(verdict, runId, after?.planOrgId ?? null);
      // They signed up or in during this turn (complete_sign_in re-keyed the
      // session): the chat becomes their account's, and the answer with that
      // access comes now, IN PLACE of the sign-in turn's words (as on the website).
      if (!failure && wasGuest && after && !after.guest && after.userId) {
        const account = { orgId: after.orgId, userId: after.userId };
        await db.update(channelInboundMessages).set({ ...account, signedIn: true, updatedAt: new Date() }).where(eq(channelInboundMessages.id, rowId));
        try {
          await deps.linkChat({ chatId, ...account });
        } catch (err) {
          // The conversation is theirs either way (its session is): only the proactive updates wait for a link.
          console.error(`[chat-service] telegram chat ${chatId}: signed in to org ${account.orgId}, but the chat could not be linked: ${err instanceof Error ? err.message : String(err)}`);
        }
        const [signInWords] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.sessionId, sessionId), eq(messages.role, "assistant")))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(1);
        try {
          const second = await deps.runChat({ ...account, runId: await deps.createRootRun(account), sessionId, message: TELEGRAM_AFTER_SIGN_IN_TRIGGER, channelMessageId: rowId });
          const next = telegramTurnOutcome(second.status, second.body);
          if (next.failure) throw new Error(next.failure);
          replyText = next.replyText;
          // Kept for the model (it said it), never read again in the history.
          if (signInWords) await db.update(messages).set({ proactiveTrigger: true }).where(eq(messages.id, signInWords.id));
        } catch (err) {
          console.error(`[chat-service] telegram message "${row.messageId}": signed in, but the answer with their account failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    if (err instanceof DistryLimitReached) {
      replyText = err.notice;
    } else {
      failure = err instanceof Error ? err.message : String(err);
      replyText = CHANNEL_FAILURE_TEXT;
    }
  }
  if (failure) console.error(`[chat-service] telegram message "${row.messageId}" chat="${chatId}": turn failed: ${failure}`);
  let sentAt: Date | null = null;
  try {
    await deps.sendReply({ chatId, text: replyText });
    sentAt = new Date();
  } catch (err) {
    const sendError = err instanceof Error ? err.message : String(err);
    console.error(`[chat-service] telegram message "${row.messageId}" chat="${chatId}": reply not sent: ${sendError}`);
    failure = failure ? `${failure}; send: ${sendError}` : `send: ${sendError}`;
  }
  await db
    .update(channelInboundMessages)
    .set({ status: failure ? "failed" : "answered", replyText, error: failure ?? limited, sentAt, updatedAt: new Date() })
    .where(eq(channelInboundMessages.id, rowId));
}

// One chat at a time, in order: a second message waits for the first answer.
const queues = new Map<string, Promise<void>>();

export function enqueueTelegramMessage(deps: TelegramDeps, chatId: string, rowId: string): Promise<void> {
  const previous = queues.get(chatId) ?? Promise.resolve();
  const next = previous
    .then(() => processTelegramMessage(deps, rowId))
    .catch((err) => console.error(`[chat-service] telegram message row "${rowId}" crashed:`, err))
    .finally(() => {
      if (queues.get(chatId) === next) queues.delete(chatId);
    });
  queues.set(chatId, next);
  return next;
}

/** Messages a restart cut off in the last 30 minutes are answered once the port is up. */
export async function recoverTelegramMessages(deps: TelegramDeps, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 30 * 60_000);
  const rows = await deps.db
    .update(channelInboundMessages)
    .set({ status: "received", updatedAt: now })
    .where(
      and(
        eq(channelInboundMessages.channel, TELEGRAM_CHANNEL),
        inArray(channelInboundMessages.status, ["received", "processing"]),
        gt(channelInboundMessages.createdAt, since),
      ),
    )
    .returning({ id: channelInboundMessages.id, chatId: channelInboundMessages.senderPhone });
  for (const r of rows) void enqueueTelegramMessage(deps, r.chatId, r.id);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Default (network) dependencies: client-service
// ---------------------------------------------------------------------------

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}

export async function resolveTelegramChat(chatId: string, fetchImpl: typeof fetch = fetch): Promise<TelegramChatLink[]> {
  const res = await fetchImpl(`${env("CLIENT_SERVICE_URL")}/internal/owner-telegram/chats/${encodeURIComponent(chatId)}`, {
    headers: { "x-api-key": env("CLIENT_SERVICE_API_KEY") },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`client-service telegram chat links ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { links?: Array<Record<string, unknown>> };
  if (!Array.isArray(json.links)) throw new Error(`client-service telegram chat links answered without links: ${text.slice(0, 300)}`);
  return json.links.map((l) => {
    if (typeof l.orgId !== "string" || typeof l.userId !== "string") {
      throw new Error(`client-service telegram chat link without orgId/userId: ${JSON.stringify(l)}`);
    }
    return { orgId: l.orgId, userId: l.userId };
  });
}

/** The platform bot (Telegram Bot API, the same bot the landing webhook receives for): one message to a chat. Throws unless Telegram took it. */
export async function sendTelegramToChat(args: { chatId: string; text: string }, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: args.chatId, text: args.text.slice(0, 4096), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!res.ok || json?.ok !== true) throw new Error(`telegram sendMessage ${res.status}: ${json?.description ?? "no answer"}`);
}

/**
 * client-service: the chat becomes the org's linked chat, through the link the
 * dashboard card uses (a one-time code), made and used here at once: the person
 * proved their email in this chat, nothing for them to type.
 */
export async function linkTelegramChat(args: { chatId: string; orgId: string; userId: string }, fetchImpl: typeof fetch = fetch): Promise<void> {
  const call = async (path: string, body: unknown) => {
    const res = await fetchImpl(`${env("CLIENT_SERVICE_URL")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env("CLIENT_SERVICE_API_KEY") },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`client-service ${path.replace(/\/orgs\/[^/]+\//, "/orgs/:orgId/")} ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const made = await call(`/internal/orgs/${encodeURIComponent(args.orgId)}/owner-telegram/link-codes`, { userId: args.userId });
  if (typeof made.code !== "string") throw new Error("client-service link-codes answered without code");
  await call("/internal/owner-telegram/links", { code: made.code, chatId: args.chatId });
}

/** client-service POST /internal/orgs/:orgId/owner-telegram/messages: throws unless `sent`. */
export async function sendTelegramToOrg(args: { orgId: string; text: string; runId?: string | null }, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${env("CLIENT_SERVICE_URL")}/internal/orgs/${encodeURIComponent(args.orgId)}/owner-telegram/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env("CLIENT_SERVICE_API_KEY"),
      ...(args.runId ? { "x-run-id": args.runId } : {}),
    },
    body: JSON.stringify({ text: args.text.slice(0, 4096) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`client-service telegram send ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { outcome?: string; reason?: string };
  if (json.outcome !== "sent") throw new Error(`telegram ${json.outcome ?? "unknown outcome"}: ${json.reason ?? text.slice(0, 300)}`);
}

/**
 * The member who linked the org's OWN Telegram chat (client-service status
 * read), null when the org has none or only the platform owner's relay chat.
 */
export async function orgTelegramLinker(orgId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchImpl(`${env("CLIENT_SERVICE_URL")}/internal/orgs/${encodeURIComponent(orgId)}/owner-telegram`, {
    headers: { "x-api-key": env("CLIENT_SERVICE_API_KEY") },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`client-service owner telegram ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { reachable?: boolean; target?: string; linkedByUserId?: string | null };
  if (json.reachable !== true || json.target !== "linked_chat") return null;
  if (typeof json.linkedByUserId !== "string") throw new Error(`client-service owner telegram answered a linked chat without linkedByUserId: ${text.slice(0, 300)}`);
  return json.linkedByUserId;
}
