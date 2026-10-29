/**
 * The Copilot on WhatsApp (SOPHIE-COPILOT-WA-1018, owner 2026-10-18: "Le copilot
 * devient Sophie, une continuation Web, mais même accès, même règles, même
 * esprit, même personnalité").
 *
 * crm-service hands every inbound message of the assistant's linked account to
 * POST /internal/copilot/channel-messages and sends nothing itself. Here:
 *  1. the sender's number IS their identity (client-service users.phone):
 *     a known number continues that user's latest Copilot session (the same
 *     thread the web shows), an unknown one is a GUEST session that sees no
 *     account and can only sign in (channel-sign-in.ts);
 *  2. the turn runs through POST /chat itself (same config, tools, billing,
 *     refusals), called on this process with the person's identity;
 *  3. the answer goes out from the same linked account through crm-service
 *     POST /orgs/whatsapp/messages (a send crm records as the assistant's).
 *
 * The assistant's name and voice come from the linked account's persona
 * (crm data), never from this code.
 */
import { and, desc, eq, gt, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { COPILOT_SUPPORT } from "./support-marks.js";
import type { db as Db } from "../db/index.js";
import { channelInboundMessages, sessions } from "../db/schema.js";
import type { ChannelMessageRequest } from "../schemas.js";
import { COPILOT_CONFIG_KEY } from "./copilot-unibox.js";
import { listBrands } from "./funnel-client.js";

export const CHANNEL_TASK_NAME = "copilot-whatsapp";

/**
 * How crm-service writes a voice note into a message (SOPHIE-VOICE-1019): the
 * transcript after `VOICE_NOTE_PREFIX`, or `VOICE_NOTE_UNREADABLE` when it could
 * not be transcribed. Byte-equal to crm-service `src/lib/matrix/voice-notes.ts`.
 * The owner decided (2026-10-19) the assistant always answers in TEXT.
 */
export const VOICE_NOTE_PREFIX = "🎤 Voice note:";
export const VOICE_NOTE_UNREADABLE = "🎤 Voice note (could not be understood)";
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.distribute.you";

/** The `context.channel` block the internal route passes to /chat. */
export const ChatChannelContextSchema = z.object({
  kind: z.literal("whatsapp"),
  assistant: z.object({
    name: z.string().nullable(),
    role: z.string().nullable(),
    instructions: z.string().nullable(),
  }),
  sender: z.object({
    phone: z.string(),
    name: z.string().nullable().optional(),
    knownEmails: z.array(z.string()).optional(),
  }),
  /** The brand's line the person wrote to, when the answer goes out from another one (SOPHIE-INTRODUCES-HERSELF-ON-HER-LINE-1029). */
  receivedOn: z.object({ account: z.string(), name: z.string().nullable(), role: z.string().nullable() }).nullable().optional(),
  thread: z.array(
    z.object({
      at: z.string(),
      direction: z.enum(["inbound", "outbound"]),
      text: z.string(),
      kind: z.enum(["message", "call"]).optional(),
      /** The brand's number the line happened on, only when it is not the answering one. */
      account: z.string().optional(),
    }),
  ),
  /**
   * Set by processChannelMessage only, on the turn it runs right after a guest
   * turn that signed the person in (SOPHIE-WA-SIGNED-IN-1029): that turn's
   * message is our trigger, not their words, so it is stored hidden.
   */
  afterSignIn: z.literal(true).optional(),
});
export type ChatChannelContext = z.infer<typeof ChatChannelContextSchema>;

// ---------------------------------------------------------------------------
// System prompt block (only for a session the internal route tied to a number)
// ---------------------------------------------------------------------------

/** Per-message cap of the thread shown to the model: a whole message, bounded. */
export const THREAD_MESSAGE_MAX_CHARS = 4000;

/** A public question is answered at once: sign-in is never put in front of it (SOPHIE-WA-SIGNED-IN-1029). */
const PUBLIC_FIRST =
  "Answer every question about distribute.you at once, from what we offer everyone (what we do, how pricing works, free trial, how to start): those answers need no account, so never put a sign-in in front of them. ";

/** The account takes effect in the same exchange: no extra round for the person. */
const SIGN_IN_ANSWERS_AT_ONCE =
  "Signing in never costs them a message: right after complete_sign_in succeeds, you answer again with their account's access, so in that reply just say in a few words that they are in, and never ask them to send anything (\"ok\", a question) to continue.";

export function buildChannelBlock(channel: ChatChannelContext, guest: boolean): string {
  const name = channel.assistant.name?.trim();
  const role = channel.assistant.role?.trim();
  const who = name ? `${name}${role ? `, ${role}` : ""}` : "the distribute.you Copilot";
  const lines = [
    "\n\n---\n## Channel: WhatsApp (this turn)",
    `You are answering on WhatsApp as ${who}. You are the distribute.you Copilot: same person, same conversation as on the web, same rules, same personality.${name ? ` Here your name is ${name}: say it only when you first greet someone, never as a header.` : ""}`,
    "WhatsApp shows plain text. Write short messages. Use WhatsApp markup only (*bold*, _italic_): no tables, no headings, no markdown links (write the URL itself). Never use the long dash characters.",
    "Clickable choices (present_choices) are shown as a numbered list: the person answers with a number or in words.",
    `Pages you open (open_page) cannot be shown here: when a page helps, give the link ${DASHBOARD_URL}.`,
    `People may send voice notes. ${VOICE_NOTE_PREFIX} followed by words is what they SAID in a voice note, transcribed: treat it as their message and answer it like any written one. ${VOICE_NOTE_UNREADABLE} means a voice note we could not understand: say you could not listen to it and ask them to write it or send it again. Always answer in text: you cannot send voice notes.`,
  ];
  if (channel.assistant.instructions?.trim()) lines.push(`How you speak on this number: ${channel.assistant.instructions.trim()}`);
  // COPILOT-WA-REPEAT-1027 (owner 2026-10-27: « ça fait vraiment répondeur
  // automatique »): the STRATEGY of a conversation, never canned replies.
  lines.push(
    "How a real conversation works here: before you write, read the thread and your own last messages. Answer what they just said, in their register. " +
      "Never send again something you already said: no ask they have not answered yet, no pitch, no figure, no offer line you already wrote. An unanswered ask means they are not ready; asking again is pressure, and repeating yourself is what makes you sound like an auto-responder. " +
      "When someone says not now, they are busy, or they have no questions, one short warm line that still leaves their next step one click away (in new words, never the same ask again). Short and human beats complete. Every message moves them one step from where they stopped (client-comms): never close on \"any question?\" or \"take your time\".",
    "Our earlier messages in this thread (campaign messages included) may carry prices or offer terms that have changed since. Never repeat a price, amount or offer term from the thread: state one only from what your skills or tools say now, and when you have none, say no figure.",
  );
  const knownEmails = (channel.sender.knownEmails ?? []).filter((e) => e.trim());
  if (guest) {
    if (knownEmails.length > 0) {
      lines.push(
        `We already know this person: our own records tie their number to ${knownEmails.join(", ")}. Never ask who they are or for their email. ` +
          "This number is not tied to their distribute.you account yet, so you see no account and can change nothing: never claim to see their brands, campaigns or figures. " +
          PUBLIC_FIRST +
          "When their next step needs their account (their campaigns, their figures, starting or changing something), call start_sign_in with that email yourself (the one they signed up with, when several), tell them a 6-digit code just went there, then call complete_sign_in with it. " +
          SIGN_IN_ANSWERS_AT_ONCE,
      );
    } else {
      lines.push(
        "This WhatsApp number is NOT tied to any distribute.you account yet. You see no account and can change nothing: never claim to see their brands, campaigns or figures. " +
          PUBLIC_FIRST +
          "When THEY want to start, or say they already have an account and their next step needs it, sign them up or in: ask for their email (once), call start_sign_in, ask for the 6-digit code from that email, call complete_sign_in. " +
          SIGN_IN_ANSWERS_AT_ONCE,
      );
    }
  } else {
    lines.push(
      "This WhatsApp number is tied to the distribute.you account you act for: you have exactly this person's access, nothing more. You know who they are: never ask for their email or name. " +
        "If they say it is not their account, or want another one, sign them in with start_sign_in then complete_sign_in.",
    );
    if (channel.afterSignIn) {
      lines.push(
        "They signed in a moment ago, in this same exchange: you now act with their account. Answer now, with that access, what they asked before signing in (the thread and this conversation tell you what). " +
          "Do not greet them again, do not repeat that they are signed in, and never ask them to send anything to continue.",
      );
    }
  }
  lines.push(
    "WhatsApp calls happen on this number too: our team may call the person from it. A call line in the thread is a call (us = we called them, them = they called us). " +
      "When the person mentions a call (they missed it, cannot take calls now), it is about a call from our team, even when the thread shows none: some calls do not reach the thread. Acknowledge it simply (no problem, we can talk here), never say no call was needed or that we did not call.",
  );
  // SOPHIE-INTRODUCES-HERSELF-ON-HER-LINE-1029 (owner 2026-10-29: « ok to have a
  // hello message from the founder, but the Sophie talk must be from her
  // number »): the person wrote to another of the brand's lines; we answer from
  // ours, so they see a NEW number and must learn who writes and why.
  const received = channel.receivedOn;
  const receivedOwner = received?.name?.trim() || null;
  const lineLabel = (account: string): string => {
    if (!received || received.account !== account || !receivedOwner) return account;
    const ownerRole = received.role?.trim();
    return `${receivedOwner}${ownerRole ? ` (${ownerRole})` : ""}'s number ${account}`;
  };
  if (received) {
    const me = name ?? "the assistant";
    const them = receivedOwner ?? "the person who wrote from that number";
    lines.push(
      `The person wrote to ${lineLabel(received.account)}, not to yours: they answered a message sent from that number. You answer from YOUR own number, which is new to them. ` +
        `So on your number you introduce yourself once, before you answer: who you are${receivedOwner ? `, ${receivedOwner}'s assistant` : ""}, following up on the message from ${receivedOwner ?? "that number"} ` +
        `(for example: "Hi, ${me} here${receivedOwner ? `, ${receivedOwner}'s assistant` : ""}, following up on the message from ${receivedOwner ?? "our team"}"). ` +
        "Only once: when a message of yours on your number is already in the thread, you have introduced yourself, just answer. " +
        `Never pretend to be ${them}: you are ${me}. What was said from that number was said by ${them}, not by you.`,
    );
  }
  if (channel.thread.some((m) => m.account)) {
    lines.push(
      'A thread line marked "on <number>" happened on another of our numbers, not yours: "us" there means whoever owns that number wrote it, never you. Lines with no number happened on your number.',
    );
  }
  if (channel.thread.length > 0) {
    // A whole message, never its first lines: a message WE sent (the daily
    // Threads drafts, ~1,700 chars) is what the person asks about next. At 600
    // chars the Copilot saw 1.3 of 5 drafts and went hunting through tools
    // instead of answering (SOPHIE-NO-ANSWER-1028, prod 2026-10-27).
    lines.push(
      "Their latest WhatsApp messages and calls with this number, before this one (oldest first; ours include campaign messages):",
      ...channel.thread.map(
        (m) => `- ${m.at} ${m.direction === "inbound" ? "them" : "us"}${m.account ? ` on ${lineLabel(m.account)}` : ""}${m.kind === "call" ? " [call]" : ""}: ${m.text.replace(/\s+/g, " ").slice(0, THREAD_MESSAGE_MAX_CHARS)}`,
      ),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The /chat stream → one WhatsApp message
// ---------------------------------------------------------------------------

export interface ChannelTurnResult {
  text: string;
  choices: { question?: string; choices: { label: string; description?: string }[] } | null;
  inputLabel: string | null;
  creditsRequired: { message: string; label: string } | null;
  error: string | null;
}

/** Parses the SSE body of POST /chat (`data: {json}` frames, `[DONE]` last). */
export function parseChatStream(body: string): ChannelTurnResult {
  const out: ChannelTurnResult = { text: "", choices: null, inputLabel: null, creditsRequired: null, error: null };
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const line = frame.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type === "token" && typeof ev.content === "string") out.text += ev.content;
    else if (ev.type === "choices" && Array.isArray(ev.choices)) {
      out.choices = {
        ...(typeof ev.question === "string" ? { question: ev.question } : {}),
        choices: (ev.choices as Array<Record<string, unknown>>).map((c) => ({
          label: String(c.label ?? ""),
          ...(typeof c.description === "string" ? { description: c.description } : {}),
        })),
      };
    } else if (ev.type === "input_request" && typeof ev.label === "string") out.inputLabel = ev.label;
    else if (ev.type === "credits_required") {
      out.creditsRequired = { message: String(ev.message ?? ""), label: String(ev.label ?? "Add credits") };
    } else if (ev.type === "error") out.error = typeof ev.message === "string" ? ev.message : "error";
  }
  return out;
}

/** Markdown the web renders → WhatsApp markup; long dashes never leave (client-comms rule). */
export function toWhatsappText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1: $2")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "_$1_")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const CHANNEL_FAILURE_TEXT = "Sorry, something went wrong on my side. Please send your message again in a minute.";

/** No name header (owner 2026-10-18: a bare "Sophie" line read as a robot); the model introduces itself. */
export function renderChannelReply(turn: ChannelTurnResult): string {
  let body = toWhatsappText(turn.text);
  if (turn.choices) {
    const list = turn.choices.choices
      .map((c, i) => `${i + 1}. ${toWhatsappText(c.label)}${c.description ? ` (${toWhatsappText(c.description)})` : ""}`)
      .join("\n");
    body = [body, turn.choices.question ? toWhatsappText(turn.choices.question) : "", list].filter(Boolean).join("\n\n");
  }
  if (turn.inputLabel && !body.includes(turn.inputLabel)) body = [body, toWhatsappText(turn.inputLabel)].filter(Boolean).join("\n\n");
  if (turn.creditsRequired) {
    const credits = `${toWhatsappText(turn.creditsRequired.message)}\n${turn.creditsRequired.label}: ${DASHBOARD_URL}`;
    body = body.includes(turn.creditsRequired.message) ? `${body}\n${turn.creditsRequired.label}: ${DASHBOARD_URL}` : [body, credits].filter(Boolean).join("\n\n");
  }
  if (!body) body = CHANNEL_FAILURE_TEXT;
  return body.slice(0, 4096);
}

// ---------------------------------------------------------------------------
// Dependencies (injected so the flow is testable without the network)
// ---------------------------------------------------------------------------

export interface PhoneAccount {
  orgId: string;
  userId: string;
}

export interface ChannelDeps {
  db: typeof Db;
  /** client-service: the account a WhatsApp number resolves to, null when none. */
  resolvePhone: (phone: string) => Promise<PhoneAccount | null>;
  /** The org's brand ids, so the web Copilot shows this thread on each brand page. */
  listBrandIds: (identity: { orgId: string; userId: string; runId: string }) => Promise<string[]>;
  /** runs-service: a root run for the turn (POST /chat needs an x-run-id). */
  createRootRun: (identity: { orgId: string; userId: string }) => Promise<string>;
  /** POST /chat on this process: status + raw body. */
  runChat: (args: { orgId: string; userId: string; runId: string; sessionId: string; message: string; context: Record<string, unknown> }) => Promise<{ status: number; body: string }>;
  /** crm-service POST /orgs/whatsapp/messages. */
  sendReply: (args: { orgId: string; brandId: string; userId: string; runId: string | null; phone: string; fromAccount: string; text: string; idempotencyKey: string }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Session pick: one thread per person across web and WhatsApp
// ---------------------------------------------------------------------------

export async function pickChannelSession(
  deps: Pick<ChannelDeps, "db" | "listBrandIds">,
  msg: ChannelMessageRequest,
  account: PhoneAccount | null,
  runId: string,
): Promise<{ sessionId: string; orgId: string; userId: string; guest: boolean }> {
  const { db } = deps;
  const phone = msg.sender.phone;
  if (account) {
    const [latest] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.orgId, account.orgId),
          eq(sessions.userId, account.userId),
          eq(sessions.configKey, COPILOT_CONFIG_KEY),
          eq(sessions.guest, false),
        ),
      )
      .orderBy(desc(sessions.updatedAt))
      .limit(1);
    const brandIds = latest?.brandIds && latest.brandIds.length > 0
      ? null
      : await deps.listBrandIds({ orgId: account.orgId, userId: account.userId, runId });
    if (latest) {
      await db
        .update(sessions)
        .set({ channelPhone: phone, ...(brandIds && brandIds.length > 0 ? { brandIds } : {}), updatedAt: new Date() })
        .where(eq(sessions.id, latest.id));
      return { sessionId: latest.id, orgId: account.orgId, userId: account.userId, guest: false };
    }
    const [created] = await db
      .insert(sessions)
      .values({
        orgId: account.orgId,
        userId: account.userId,
        parentRunId: runId,
        configKey: COPILOT_CONFIG_KEY,
        channelPhone: phone,
        guest: false,
        brandIds: brandIds && brandIds.length > 0 ? brandIds : null,
      })
      .returning({ id: sessions.id });
    return { sessionId: created.id, orgId: account.orgId, userId: account.userId, guest: false };
  }

  // Guest: billed to the org whose number they wrote to, under the account's user.
  const [guestSession] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.channelPhone, phone), eq(sessions.guest, true), eq(sessions.configKey, COPILOT_CONFIG_KEY)))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);
  if (guestSession) return { sessionId: guestSession.id, orgId: guestSession.orgId, userId: guestSession.userId!, guest: true };
  const [created] = await db
    .insert(sessions)
    .values({
      orgId: msg.orgId,
      userId: msg.accountUserId,
      parentRunId: runId,
      configKey: COPILOT_CONFIG_KEY,
      channelPhone: phone,
      guest: true,
    })
    .returning({ id: sessions.id });
  return { sessionId: created.id, orgId: msg.orgId, userId: msg.accountUserId, guest: true };
}

// ---------------------------------------------------------------------------
// One inbound message, end to end
// ---------------------------------------------------------------------------

/** The hidden message of the turn that answers right after a sign-in (stored, never shown, never the person's words). */
export const AFTER_SIGN_IN_TRIGGER =
  "(Not the person's words.) They just signed in: answer now, with their account, what they asked before signing in.";

type TurnOutcome = { replyText: string; failure: string | null };

function turnOutcome(status: number, body: string): TurnOutcome {
  if (status === 200) {
    const turn = parseChatStream(body);
    if (turn.error && !turn.text) return { replyText: CHANNEL_FAILURE_TEXT, failure: `chat stream error: ${turn.error}` };
    return { replyText: renderChannelReply(turn), failure: null };
  }
  if (status === 402) {
    // An org opened by the API agent signup is refused with a 402 JSON: still an answer.
    const json = JSON.parse(body || "{}") as Record<string, unknown>;
    return {
      replyText: renderChannelReply(
        { text: "", choices: null, inputLabel: null, error: null, creditsRequired: { message: String(json.message ?? json.error ?? "You're out of credits. Add credits to keep going."), label: "Add credits" } },
      ),
      failure: null,
    };
  }
  return { replyText: CHANNEL_FAILURE_TEXT, failure: `POST /chat ${status}: ${body.slice(0, 500)}` };
}

export async function processChannelMessage(deps: ChannelDeps, rowId: string): Promise<void> {
  const { db } = deps;
  const [row] = await db.select().from(channelInboundMessages).where(eq(channelInboundMessages.id, rowId));
  if (!row || row.status !== "received") return;
  await db.update(channelInboundMessages).set({ status: "processing", updatedAt: new Date() }).where(eq(channelInboundMessages.id, rowId));
  const msg = row.payload as ChannelMessageRequest;
  const phone = msg.sender.phone;
  // The line's owner sends the reply: its org, its user, a run of ITS org.
  const lineOwner = { orgId: msg.orgId, userId: msg.accountUserId };
  let replyText = CHANNEL_FAILURE_TEXT;
  let failure: string | null = null;
  let turnRunId: string | null = null;
  let identity: { orgId: string; userId: string } = lineOwner;
  try {
    // A number the person linked in Integrations is their identity, and a
    // stronger fact than users.phone (which can name an old empty shell).
    const account = msg.sender.linkedBy ?? (await deps.resolvePhone(phone));
    identity = account ?? identity;
    turnRunId = await deps.createRootRun(identity);
    const picked = await pickChannelSession(deps, msg, account, turnRunId);
    identity = { orgId: picked.orgId, userId: picked.userId };
    await db
      .update(channelInboundMessages)
      .set({ orgId: picked.orgId, userId: picked.userId, sessionId: picked.sessionId, updatedAt: new Date() })
      .where(eq(channelInboundMessages.id, rowId));
    const channel: ChatChannelContext = {
      kind: "whatsapp",
      assistant: msg.assistant,
      sender: msg.sender,
      ...(msg.receivedOn ? { receivedOn: msg.receivedOn } : {}),
      thread: msg.thread,
    };
    const { status, body } = await deps.runChat({
      ...identity,
      runId: turnRunId,
      sessionId: picked.sessionId,
      message: msg.text,
      context: { channel },
    });
    ({ replyText, failure } = turnOutcome(status, body));

    // SOPHIE-WA-SIGNED-IN-1029: a guest who signed in during this turn gets the
    // answer to their pending question NOW, with their account, in the same
    // reply. Never "send me ok": the account takes effect in this exchange.
    if (!failure && picked.guest) {
      const [after] = await db
        .select({ orgId: sessions.orgId, userId: sessions.userId, guest: sessions.guest })
        .from(sessions)
        .where(eq(sessions.id, picked.sessionId));
      if (after && !after.guest && after.userId) {
        identity = { orgId: after.orgId, userId: after.userId };
        await db
          .update(channelInboundMessages)
          .set({ orgId: identity.orgId, userId: identity.userId, updatedAt: new Date() })
          .where(eq(channelInboundMessages.id, rowId));
        const signedInText = replyText;
        try {
          const runId = await deps.createRootRun(identity);
          const next = await deps.runChat({
            ...identity,
            runId,
            sessionId: picked.sessionId,
            message: AFTER_SIGN_IN_TRIGGER,
            context: { channel: { ...channel, afterSignIn: true } },
          });
          const outcome = turnOutcome(next.status, next.body);
          if (outcome.failure) failure = `after sign-in: ${outcome.failure}`;
          else replyText = [signedInText, outcome.replyText].filter(Boolean).join("\n\n").slice(0, 4096);
        } catch (err) {
          failure = `after sign-in: ${err instanceof Error ? err.message : String(err)}`;
        }
        // The sign-in itself went through: that reply still leaves.
        if (failure) replyText = signedInText;
      }
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    replyText = CHANNEL_FAILURE_TEXT;
  }
  if (failure) console.error(`[chat-service] whatsapp message "${row.messageId}" from ${phone}: turn failed: ${failure}`);
  let sentAt: Date | null = null;
  try {
    // runs-service refuses a child under another org's run (409 "Parent-child
    // field conflict"): a turn run under the PERSON's account never rides the
    // line owner's send (prod 2026-10-27 / 2026-10-29: every reply to a
    // signed-in person dropped). The send then gets its own run, under the line.
    const sendRunId = turnRunId && identity.orgId === lineOwner.orgId ? turnRunId : await deps.createRootRun(lineOwner);
    await deps.sendReply({
      orgId: msg.orgId,
      brandId: msg.brandId,
      userId: msg.accountUserId,
      runId: sendRunId,
      phone,
      fromAccount: msg.fromAccount,
      text: replyText,
      idempotencyKey: `copilot:${row.messageId}`,
    });
    sentAt = new Date();
  } catch (err) {
    const sendError = err instanceof Error ? err.message : String(err);
    console.error(`[chat-service] whatsapp message "${row.messageId}" from ${phone}: reply not sent: ${sendError}`);
    failure = failure ? `${failure}; send: ${sendError}` : `send: ${sendError}`;
  }
  await db
    .update(channelInboundMessages)
    .set({ status: failure ? "failed" : "answered", replyText, error: failure, sentAt, updatedAt: new Date() })
    .where(eq(channelInboundMessages.id, rowId));
}

/** One turn at a time per number: a second message waits for the first answer. */
const queues = new Map<string, Promise<void>>();

export function enqueueChannelMessage(deps: ChannelDeps, phone: string, rowId: string): Promise<void> {
  const previous = queues.get(phone) ?? Promise.resolve();
  const next = previous
    .then(() => processChannelMessage(deps, rowId))
    .catch((err) => console.error(`[chat-service] whatsapp message row "${rowId}" crashed:`, err))
    .finally(() => {
      if (queues.get(phone) === next) queues.delete(phone);
    });
  queues.set(phone, next);
  return next;
}

/**
 * A deploy recreates the container mid-turn: messages of the last 30 minutes
 * never answered run again (crm's send idempotency key stops a second send if
 * the first one left). Older ones stay failed: an answer an hour late is noise.
 */
export async function recoverChannelMessages(deps: ChannelDeps, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 30 * 60_000);
  const rows = await deps.db
    .update(channelInboundMessages)
    .set({ status: "received", updatedAt: now })
    .where(and(inArray(channelInboundMessages.status, ["received", "processing"]), gt(channelInboundMessages.createdAt, since)))
    .returning({ id: channelInboundMessages.id, phone: channelInboundMessages.senderPhone });
  for (const r of rows) void enqueueChannelMessage(deps, r.phone, r.id);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Delivery series (Monitoring: replies written vs delivered, per UTC day)
// ---------------------------------------------------------------------------

export interface ChannelReplyDay {
  day: string;
  received: number;
  delivered: number;
  notDelivered: number;
}

/**
 * One row per UTC day, oldest first, zeros included, recomputed from the stored
 * rows (SOPHIE-WA-SIGNED-IN-1029: a refused send was silent for two days).
 * delivered = crm-service accepted the reply; notDelivered = the turn ended but
 * nothing left; a message still in flight counts in received only.
 */
export async function channelReplyDays(database: typeof Db, days: number, now = new Date()): Promise<ChannelReplyDay[]> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(today - (days - 1) * 86_400_000);
  const rows = await database
    .select({ createdAt: channelInboundMessages.createdAt, status: channelInboundMessages.status, sentAt: channelInboundMessages.sentAt })
    .from(channelInboundMessages)
    .where(gte(channelInboundMessages.createdAt, from));
  const byDay = new Map<string, ChannelReplyDay>();
  for (let i = 0; i < days; i++) {
    const day = new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    byDay.set(day, { day, received: 0, delivered: 0, notDelivered: 0 });
  }
  for (const r of rows) {
    const bucket = byDay.get(r.createdAt.toISOString().slice(0, 10));
    if (!bucket) continue;
    bucket.received++;
    if (r.sentAt) bucket.delivered++;
    else if (r.status === "answered" || r.status === "failed") bucket.notDelivered++;
  }
  return [...byDay.values()];
}

// ---------------------------------------------------------------------------
// Default (network) dependencies
// ---------------------------------------------------------------------------

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}

export async function resolvePhoneAccount(phone: string, fetchImpl: typeof fetch = fetch): Promise<PhoneAccount | null> {
  const res = await fetchImpl(`${env("CLIENT_SERVICE_URL")}/internal/phone-accounts?phone=${encodeURIComponent(phone)}`, {
    headers: { "x-api-key": env("CLIENT_SERVICE_API_KEY") },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`client-service phone-accounts ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.orgId !== "string" || typeof json.userId !== "string") {
    throw new Error(`client-service phone-accounts answered without orgId/userId: ${JSON.stringify(json)}`);
  }
  return { orgId: json.orgId, userId: json.userId };
}

/** crm-service refused a WhatsApp send: the status and its `code` (e.g. `whatsapp_not_connected`) stay readable. */
export class WhatsappSendError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, body: string) {
    super(`crm-service whatsapp send ${status}: ${body}`);
    this.name = "WhatsappSendError";
    this.status = status;
    let code: string | null = null;
    try {
      const parsed = JSON.parse(body) as { code?: unknown };
      if (typeof parsed.code === "string") code = parsed.code;
    } catch {
      // not JSON: no code to read
    }
    this.code = code;
  }
}

export async function sendWhatsappReply(
  args: Parameters<ChannelDeps["sendReply"]>[0],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": env("CRM_SERVICE_API_KEY"),
    "x-org-id": args.orgId,
    "x-user-id": args.userId,
    "x-brand-id": args.brandId,
  };
  if (args.runId) headers["x-run-id"] = args.runId;
  const res = await fetchImpl(`${env("CRM_SERVICE_URL")}/orgs/whatsapp/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      brandId: args.brandId,
      phone: args.phone,
      fromAccount: args.fromAccount,
      text: args.text,
      idempotencyKey: args.idempotencyKey,
      skipIfReplied: false,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new WhatsappSendError(res.status, await res.text().catch(() => ""));
}

export async function createChannelRootRun(identity: { orgId: string; userId: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org"}/v1/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env("RUNS_SERVICE_API_KEY"),
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
    },
    body: JSON.stringify({ serviceName: "chat-service", taskName: CHANNEL_TASK_NAME, support: COPILOT_SUPPORT }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`runs-service create run ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error("runs-service create run answered without id");
  return json.id;
}

export async function listOrgBrandIds(identity: { orgId: string; userId: string; runId: string }): Promise<string[]> {
  const body = (await listBrands(identity)) as { brands?: Array<{ id?: unknown }> } | Array<{ id?: unknown }>;
  const rows = Array.isArray(body) ? body : body.brands ?? [];
  return rows.map((b) => b.id).filter((id): id is string => typeof id === "string");
}

/** POST /chat on this same process, with the person's identity (the web path, minus the gateway). */
export async function runChatOnSelf(
  port: number,
  args: Parameters<ChannelDeps["runChat"]>[0],
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: string }> {
  const res = await fetchImpl(`http://127.0.0.1:${port}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.CHAT_SERVICE_API_KEY || "chat-service-self",
      "x-org-id": args.orgId,
      "x-user-id": args.userId,
      "x-run-id": args.runId,
    },
    body: JSON.stringify({ configKey: COPILOT_CONFIG_KEY, message: args.message, sessionId: args.sessionId, context: args.context }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  return { status: res.status, body: await res.text() };
}
