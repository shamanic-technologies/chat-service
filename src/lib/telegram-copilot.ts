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
 *     and the member who linked it (newest link first). An unlinked chat gets
 *     `not_linked` back and the webhook answers it with the linking guidance:
 *     never a turn on someone else's org;
 *  3. the turn runs through POST /chat on this process as that member, in their
 *     latest Copilot session (the thread the web shows: one memory), billed to
 *     their org on a Copilot support run, like a WhatsApp turn;
 *  4. the answer goes back through client-service's owner Telegram send (the
 *     org's linked chat), as plain text.
 *
 * Only the FORM differs from the other surfaces (one Sophie, the channel is a
 * detail): the Telegram block below says how to write here, the strategy lines
 * are the WhatsApp ones.
 */
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { channelInboundMessages, sessions } from "../db/schema.js";
import type { TelegramMessageRequest } from "../schemas.js";
import {
  CHANNEL_FAILURE_TEXT,
  CONVERSATION_LINES,
  WHOLE_WAY_TO_USE,
  parseChatStream,
  renderChannelReply,
  toPlainText,
} from "./channel-copilot.js";
import { COPILOT_CONFIG_KEY } from "./copilot-unibox.js";

export const TELEGRAM_CHANNEL = "telegram";
export const TELEGRAM_TASK_NAME = "copilot-telegram";
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.distribute.you";

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
    `Pages you open (open_page) cannot be shown here: when a page helps, give the link ${DASHBOARD_URL}.`,
    ...CONVERSATION_LINES,
    "This Telegram chat is tied to the distribute.you account you act for: you have exactly this person's access, nothing more. You know who they are: never ask for their email or name.",
    WHOLE_WAY_TO_USE,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Dependencies (injected so the flow is testable without the network)
// ---------------------------------------------------------------------------

export interface TelegramChatLink {
  orgId: string;
  userId: string;
}

export interface TelegramDeps {
  db: typeof Db;
  /** client-service: the orgs this chat is linked to, newest link first (empty = not linked). */
  resolveChat: (chatId: string) => Promise<TelegramChatLink[]>;
  listBrandIds: (identity: { orgId: string; userId: string; runId: string }) => Promise<string[]>;
  /** runs-service: a root Copilot support run under the person's org. */
  createRootRun: (identity: { orgId: string; userId: string }) => Promise<string>;
  /** POST /chat on this process as the person, unlocked by the stored message row. */
  runChat: (args: { orgId: string; userId: string; runId: string; sessionId: string; message: string; channelMessageId: string }) => Promise<{ status: number; body: string }>;
  /** client-service: one message to the org's linked chat. Throws when it did not leave. */
  sendReply: (args: { orgId: string; text: string }) => Promise<void>;
}

export type TelegramAccept =
  | { status: "not_linked" }
  | { status: "duplicate" }
  | { status: "accepted"; rowId: string };

/**
 * Routing: a chat linked to an org runs a turn as the member who linked it (the
 * newest link when several); any other chat runs nothing and is `not_linked`.
 * The same Telegram message twice (a webhook retry) is a `duplicate`.
 */
export async function acceptTelegramMessage(deps: Pick<TelegramDeps, "db" | "resolveChat">, msg: TelegramMessageRequest): Promise<TelegramAccept> {
  const links = await deps.resolveChat(msg.chatId);
  const link = links[0];
  if (!link) return { status: "not_linked" };
  const [row] = await deps.db
    .insert(channelInboundMessages)
    .values({
      messageId: telegramMessageKey(msg.chatId, msg.messageId),
      channel: TELEGRAM_CHANNEL,
      senderPhone: msg.chatId,
      orgId: link.orgId,
      userId: link.userId,
      status: "received",
      payload: msg,
    })
    .onConflictDoNothing({ target: channelInboundMessages.messageId })
    .returning({ id: channelInboundMessages.id });
  if (!row) return { status: "duplicate" };
  return { status: "accepted", rowId: row.id };
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

/** One stored message, end to end: the turn, then the reply in the chat. Never throws. */
export async function processTelegramMessage(deps: TelegramDeps, rowId: string): Promise<void> {
  const { db } = deps;
  const [row] = await db.select().from(channelInboundMessages).where(eq(channelInboundMessages.id, rowId));
  if (!row || row.channel !== TELEGRAM_CHANNEL || (row.status !== "received" && row.status !== "processing")) return;
  if (!row.orgId || !row.userId) return;
  const identity = { orgId: row.orgId, userId: row.userId };
  const msg = row.payload as TelegramMessageRequest;
  await db.update(channelInboundMessages).set({ status: "processing", updatedAt: new Date() }).where(eq(channelInboundMessages.id, rowId));
  let replyText = CHANNEL_FAILURE_TEXT;
  let failure: string | null = null;
  try {
    if (!msg.text?.trim()) {
      replyText = TELEGRAM_TEXT_ONLY;
    } else {
      const runId = await deps.createRootRun(identity);
      const sessionId = await pickTelegramSession(deps, identity, runId);
      await db.update(channelInboundMessages).set({ sessionId, updatedAt: new Date() }).where(eq(channelInboundMessages.id, rowId));
      const { status, body } = await deps.runChat({ ...identity, runId, sessionId, message: msg.text, channelMessageId: rowId });
      ({ replyText, failure } = telegramTurnOutcome(status, body));
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    replyText = CHANNEL_FAILURE_TEXT;
  }
  if (failure) console.error(`[chat-service] telegram message "${row.messageId}" org="${identity.orgId}": turn failed: ${failure}`);
  let sentAt: Date | null = null;
  try {
    await deps.sendReply({ orgId: identity.orgId, text: replyText });
    sentAt = new Date();
  } catch (err) {
    const sendError = err instanceof Error ? err.message : String(err);
    console.error(`[chat-service] telegram message "${row.messageId}" org="${identity.orgId}": reply not sent: ${sendError}`);
    failure = failure ? `${failure}; send: ${sendError}` : `send: ${sendError}`;
  }
  await db
    .update(channelInboundMessages)
    .set({ status: failure ? "failed" : "answered", replyText, error: failure, sentAt, updatedAt: new Date() })
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
