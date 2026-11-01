/**
 * ONE AI CONVERSES (ONE-AI-CONVERSES-1029). Owner Kevin, 2026-10-29: « ON VEUT
 * UNE IA QUI CONVERSE AVEC LES LEADS ET LES CLIENTS AU BON MOMENT ET DE LA BONNE
 * FAÇON AVEC INTELLIGENCE COMME DES GENS PROFESSIONNELS AU SERVICE DE NOS CLIENTS
 * ET DU BUSINESS », « BIEN SÛR S'IL RÉPOND IL DOIT AVOIR ACCÈS AUX INFOS SOIT EN
 * CONTEXTE SOIT EN MODE AGENTIC TOOL ».
 *
 * Every message a person writes to us is a Lead event; the Lead event
 * campaign's workflow decides and sends. Its WRITER is this: the Copilot itself
 * (same config, prompt, skills, model, tools as the web and WhatsApp), handed
 * the writer's prompt (the game) and message (thread, who they are, our facts)
 * as CONTEXT, answering in the writer's own schema through `answer_person`.
 *
 *  - The person's account: when the writing brand is the Copilot's own
 *    (distribute.you, `COPILOT_FOLLOWUP_BRAND_ID`) and their WhatsApp number or
 *    email resolves to an account, the turn runs AS them, in their Copilot
 *    session (the thread the web shows), with their tools. A person we host no
 *    account for is a guest: on our brand with a number, the email-code sign-in
 *    (then a second turn answers with the account, `afterSignIn`).
 *    Another brand's lead: no account of ours is theirs to read, no sign-in.
 *  - Billing: a turn in the caller's org is a child of the caller's run (its
 *    outcome's spend). A turn in the person's own org cannot be (runs-service
 *    refuses a child under another org's run): its own run, Copilot support,
 *    exactly like the WhatsApp Copilot.
 *  - One answer per occurrence: `copilot_lead_turns` on (org, idempotencyKey).
 *
 * chat-service sends nothing here: the workflow's channel plan sends.
 */
import { and, desc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { db as Db } from "../db/index.js";
import { copilotLeadTurns, sessions } from "../db/schema.js";
import type { LeadTurnRequest } from "../schemas.js";
import { buildChannelBlock, type PhoneAccount } from "./channel-copilot.js";
import { COPILOT_CONFIG_KEY } from "./copilot-unibox.js";

export const LEAD_ANSWER_TOOL_NAME = "answer_person";
export const LEAD_TURN_TASK_NAME = "copilot-lead-turn";

/** The hidden message of a lead turn: never the person's words (their words are in the writer's message). */
export const LEAD_TURN_TRIGGER =
  "(Not the person's words.) A Lead event about this person: decide and answer through answer_person.";

/** The brand the Copilot speaks for (distribute.you). Unset = no brand is ours: every lead turn reads no account. */
export function copilotOwnBrandId(): string | null {
  return process.env.COPILOT_FOLLOWUP_BRAND_ID || null;
}

/**
 * The tool a lead turn ends on: its input IS the writer's answer schema. The
 * description says what it is for; the writer's game says how to decide.
 */
export function buildLeadAnswerTool(responseSchema: Record<string, unknown>, messageField: string): Anthropic.Tool {
  return {
    name: LEAD_ANSWER_TOOL_NAME,
    description:
      "Your decision for this Lead event, in the shape the campaign needs. Call it ONCE, last: it ends your turn and nothing you write outside it reaches anyone. " +
      `\`${messageField}\` is the exact text the person receives now (leave it empty when you write nothing now); the other fields are your decision as the context below asks.`,
    input_schema: responseSchema as Anthropic.Tool["input_schema"],
  };
}

/** The tools a lead turn may use: never a client-UI tool (no screen to show cards on), always the answer. */
export function leadTurnToolNames(sessionToolNames: readonly string[], clientUiToolNames: ReadonlySet<string>): string[] {
  return [...sessionToolNames.filter((t) => !clientUiToolNames.has(t)), LEAD_ANSWER_TOOL_NAME];
}

export interface LeadTurnFrame {
  payload: LeadTurnRequest;
  /** The writing brand is the Copilot's own (distribute.you). */
  ownBrand: boolean;
  /** No account of ours acts in this turn. */
  guest: boolean;
  /** The session is tied to the person's WhatsApp number (sign-in possible). */
  phoneBound: boolean;
  afterSignIn: boolean;
  /**
   * The recipient's email (crm's record) is the email of a distribute.you
   * account. Only then is it a sign-in email the model may use by itself; an
   * email crm merely knows would sign a stranger UP on an address they never
   * gave us (prod 2026-11-01: a code went unasked to an old school address).
   */
  recipientEmailIsAccount?: boolean;
}

/** The system-prompt block of a lead turn: who you write to and for, how you answer, then the writer's context. */
export function buildLeadTurnBlock(frame: LeadTurnFrame): string {
  const { payload, ownBrand, guest, phoneBound } = frame;
  const assistant = payload.assistant ?? { name: null, role: null, instructions: null };
  const parts: string[] = [];
  if (ownBrand && payload.medium === "whatsapp" && payload.recipient.phone && phoneBound) {
    parts.push(
      buildChannelBlock(
        {
          kind: "whatsapp",
          assistant,
          sender: {
            phone: payload.recipient.phone,
            name: payload.recipient.name ?? null,
            ...(payload.recipient.email && (!guest || frame.recipientEmailIsAccount) ? { knownEmails: [payload.recipient.email] } : {}),
          },
          thread: [],
          ...(frame.afterSignIn ? { afterSignIn: true as const } : {}),
        },
        guest,
      ),
    );
  }
  const who = assistant.name?.trim() ? `${assistant.name.trim()}${assistant.role?.trim() ? `, ${assistant.role.trim()}` : ""}` : null;
  const lines = [
    "\n\n---\n## This turn: a Lead event (you decide, then answer through answer_person)",
    "Something just happened with this person: what the campaign knows is below (their thread on every channel, who they are to us, our facts, and how to decide). " +
      "You are the same assistant as always: decide like a professional serving the business whether to write to them now, later or not at all, and what to say. " +
      "Read what you need with your tools when it can change your decision or your message; never ask them something their account or the thread already answers.",
    `Nothing you write as chat text reaches anyone: you end this turn by calling ${LEAD_ANSWER_TOOL_NAME} ONCE, with the text they receive in \`${payload.messageField}\` (empty when you write nothing now).`,
    payload.medium === "whatsapp"
      ? "That text goes out on WhatsApp: plain text, short, WhatsApp markup only (*bold*, _italic_), URLs written out, never the long dash characters."
      : `That text goes out as an email reply in their thread, in the format \`${payload.messageField}\` and the campaign's instructions ask for (HTML when the field is HTML): short paragraphs, never the long dash characters.`,
  ];
  if (!ownBrand) {
    lines.push(
      `Here you write for the brand the context below names${who ? `, as ${who}` : ""}, not as distribute.you: never speak of distribute.you, its account or its offer to this person.`,
    );
  } else if (who && !(payload.medium === "whatsapp" && phoneBound)) {
    lines.push(`Here you are ${who}.`);
  }
  if (assistant.instructions?.trim() && !(ownBrand && payload.medium === "whatsapp" && phoneBound)) {
    lines.push(`How you speak here: ${assistant.instructions.trim()}`);
  }
  if (ownBrand && guest && phoneBound && payload.recipient.email && !frame.recipientEmailIsAccount) {
    lines.push(
      `Our records hold an email for them (${payload.recipient.email}), but no distribute.you account uses it: it may be old or not the one they want. Never start a sign-in with it on your own; when they want to start, ask which email their account should use.`,
    );
  }
  if (ownBrand && guest && !phoneBound) {
    lines.push("We host no account for this person that you can read: you see no account and can change nothing; never claim to see their brands, campaigns or figures.");
  }
  if (frame.afterSignIn) {
    lines.push(
      "They signed in a moment ago, in this same exchange, and nothing you wrote before reached them: write the WHOLE message now, with their account's access: say in a few words that they are in, then answer what they asked.",
    );
  }
  lines.push("### How the campaign asks you to decide", payload.systemPrompt.trim(), "### What the campaign knows", payload.message.trim());
  parts.push(lines.join("\n"));
  return parts.join("");
}

// ---------------------------------------------------------------------------
// The answer, read back from the /chat stream
// ---------------------------------------------------------------------------

export interface LeadTurnStream {
  answer: Record<string, unknown> | null;
  model: string | null;
  error: string | null;
  creditsRequired: boolean;
}

/** Reads the `lead_answer` event (and an error / out-of-credits) from the SSE body of POST /chat. */
export function parseLeadTurnStream(body: string): LeadTurnStream {
  const out: LeadTurnStream = { answer: null, model: null, error: null, creditsRequired: false };
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
    if (ev.type === "lead_answer" && ev.answer && typeof ev.answer === "object") {
      out.answer = ev.answer as Record<string, unknown>;
      if (typeof ev.model === "string") out.model = ev.model;
    } else if (ev.type === "credits_required") out.creditsRequired = true;
    else if (ev.type === "error") out.error = typeof ev.message === "string" ? ev.message : "error";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependencies (injected so the flow is testable without the network)
// ---------------------------------------------------------------------------

export interface LeadTurnDeps {
  db: typeof Db;
  /** client-service: the account a WhatsApp number resolves to, null when none. */
  resolvePhone: (phone: string) => Promise<PhoneAccount | null>;
  /** client-service: the account an email resolves to, null when none. */
  resolveEmail: (email: string) => Promise<PhoneAccount | null>;
  listBrandIds: (identity: { orgId: string; userId: string; runId: string }) => Promise<string[]>;
  /** runs-service: a root run under the person's own org (Copilot support). */
  createRootRun: (identity: { orgId: string; userId: string }) => Promise<string>;
  /** POST /chat on this process. */
  runChat: (args: {
    orgId: string;
    userId: string;
    runId: string;
    sessionId: string;
    leadTurnId: string;
    trackingHeaders: Record<string, string>;
  }) => Promise<{ status: number; body: string }>;
}

export interface Caller {
  orgId: string;
  userId: string;
  runId: string;
  trackingHeaders: Record<string, string>;
}

/** The account this person IS for the writing brand: only ours can be read, and the WhatsApp number wins over an email. */
export async function resolveLeadAccount(deps: Pick<LeadTurnDeps, "resolvePhone" | "resolveEmail">, payload: LeadTurnRequest, ownBrand: boolean): Promise<PhoneAccount | null> {
  if (!ownBrand) return null;
  if (payload.recipient.phone) {
    const byPhone = await deps.resolvePhone(payload.recipient.phone);
    if (byPhone) return byPhone;
  }
  if (payload.recipient.email) return deps.resolveEmail(payload.recipient.email);
  return null;
}

/**
 * The session the turn writes in. An account: that user's latest Copilot
 * session (web + WhatsApp share it), tied to their number when we have it. A
 * guest on our brand with a number: their WhatsApp guest session. Anything
 * else: a fresh session under the caller (the writer's message carries the
 * whole thread; a number is never bound there, so no sign-in leaks across brands).
 */
export async function pickLeadSession(
  deps: Pick<LeadTurnDeps, "db" | "listBrandIds">,
  args: { payload: LeadTurnRequest; ownBrand: boolean; account: PhoneAccount | null; caller: Caller; runId: string },
): Promise<{ sessionId: string; orgId: string; userId: string; guest: boolean; phoneBound: boolean }> {
  const { db } = deps;
  const { payload, ownBrand, account, caller } = args;
  const phone = ownBrand ? payload.recipient.phone ?? null : null;
  if (account) {
    const [latest] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.orgId, account.orgId), eq(sessions.userId, account.userId), eq(sessions.configKey, COPILOT_CONFIG_KEY), eq(sessions.guest, false)))
      .orderBy(desc(sessions.updatedAt))
      .limit(1);
    const brandIds = latest?.brandIds && latest.brandIds.length > 0 ? null : await deps.listBrandIds({ ...account, runId: args.runId });
    if (latest) {
      await db
        .update(sessions)
        .set({ ...(phone ? { channelPhone: phone } : {}), ...(brandIds && brandIds.length > 0 ? { brandIds } : {}), updatedAt: new Date() })
        .where(eq(sessions.id, latest.id));
      return { sessionId: latest.id, ...account, guest: false, phoneBound: Boolean(phone ?? latest.channelPhone) };
    }
    const [created] = await db
      .insert(sessions)
      .values({ orgId: account.orgId, userId: account.userId, parentRunId: args.runId, configKey: COPILOT_CONFIG_KEY, channelPhone: phone, guest: false, brandIds: brandIds && brandIds.length > 0 ? brandIds : null })
      .returning({ id: sessions.id });
    return { sessionId: created.id, ...account, guest: false, phoneBound: Boolean(phone) };
  }
  if (phone) {
    const [guestSession] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.channelPhone, phone), eq(sessions.guest, true), eq(sessions.configKey, COPILOT_CONFIG_KEY)))
      .orderBy(desc(sessions.updatedAt))
      .limit(1);
    if (guestSession) return { sessionId: guestSession.id, orgId: guestSession.orgId, userId: guestSession.userId!, guest: true, phoneBound: true };
  }
  const [created] = await db
    .insert(sessions)
    .values({ orgId: caller.orgId, userId: caller.userId, parentRunId: caller.runId, configKey: COPILOT_CONFIG_KEY, channelPhone: phone, guest: true, brandIds: [payload.brandId] })
    .returning({ id: sessions.id });
  return { sessionId: created.id, orgId: caller.orgId, userId: caller.userId, guest: true, phoneBound: Boolean(phone) };
}

export interface LeadTurnOutcome {
  status: number;
  body: Record<string, unknown>;
}

function turnFailure(status: number, stream: LeadTurnStream, raw: string): string | null {
  if (status !== 200) return `POST /chat ${status}: ${raw.slice(0, 500)}`;
  if (stream.answer) return null;
  if (stream.creditsRequired) return "out_of_credits";
  return stream.error ? `chat stream error: ${stream.error}` : `the turn ended without ${LEAD_ANSWER_TOOL_NAME}`;
}

/** Runs one lead turn end to end on a stored `processing` row; returns the HTTP answer for the caller. */
export async function processLeadTurn(deps: LeadTurnDeps, rowId: string, caller: Caller): Promise<LeadTurnOutcome> {
  const { db } = deps;
  const [row] = await db.select().from(copilotLeadTurns).where(eq(copilotLeadTurns.id, rowId));
  if (!row) throw new Error(`lead turn ${rowId} vanished`);
  const payload = row.payload as LeadTurnRequest;
  const ownBrand = copilotOwnBrandId() === payload.brandId;
  const fail = async (status: number, error: string): Promise<LeadTurnOutcome> => {
    await db.update(copilotLeadTurns).set({ status: "failed", error, updatedAt: new Date() }).where(eq(copilotLeadTurns.id, rowId));
    console.error(`[chat-service] lead turn "${row.idempotencyKey}" org="${row.orgId}" failed: ${error}`);
    return { status, body: error === "out_of_credits" ? { error: "out_of_credits", detail: "The org that runs this turn has no credit left." } : { error } };
  };
  try {
    const account = await resolveLeadAccount(deps, payload, ownBrand);
    // In the caller's org the turn is the caller's work (child of its run); in
    // the person's own org it cannot be: its own run, Copilot support.
    const inCallerOrg = (id: { orgId: string }) => id.orgId === caller.orgId;
    const runFor = async (id: { orgId: string; userId: string }) => (inCallerOrg(id) ? caller.runId : deps.createRootRun(id));
    const firstRunId = await runFor(account ?? caller);
    const picked = await pickLeadSession(deps, { payload, ownBrand, account, caller, runId: firstRunId });
    const turnRunId = picked.orgId === (account ?? caller).orgId ? firstRunId : await runFor(picked);
    await db
      .update(copilotLeadTurns)
      .set({ sessionId: picked.sessionId, accountOrgId: picked.guest ? null : picked.orgId, accountUserId: picked.guest ? null : picked.userId, updatedAt: new Date() })
      .where(eq(copilotLeadTurns.id, rowId));
    const run = (identity: { orgId: string; userId: string }, runId: string) =>
      deps.runChat({ ...identity, runId, sessionId: picked.sessionId, leadTurnId: rowId, trackingHeaders: inCallerOrg(identity) ? caller.trackingHeaders : {} });

    const first = await run(picked, turnRunId);
    const firstStream = parseLeadTurnStream(first.body);
    const firstFailure = turnFailure(first.status, firstStream, first.body);
    if (firstFailure) return fail(firstFailure === "out_of_credits" || first.status === 402 ? 402 : 502, firstFailure);
    let answer = firstStream.answer!;
    let model = firstStream.model;
    let signedIn = false;

    // A guest who signed in during the turn: the account answers in the SAME
    // exchange (a second turn, as them); the first answer never leaves.
    if (picked.guest) {
      const [after] = await db.select({ orgId: sessions.orgId, userId: sessions.userId, guest: sessions.guest }).from(sessions).where(eq(sessions.id, picked.sessionId));
      // complete_sign_in re-keys the session to the account (guest off, its org and user).
      if (after && !after.guest && after.userId && (after.userId !== picked.userId || after.orgId !== picked.orgId)) {
        signedIn = true;
        const identity = { orgId: after.orgId, userId: after.userId };
        await db.update(copilotLeadTurns).set({ signedIn: true, accountOrgId: identity.orgId, accountUserId: identity.userId, updatedAt: new Date() }).where(eq(copilotLeadTurns.id, rowId));
        const second = await run(identity, await runFor(identity));
        const secondStream = parseLeadTurnStream(second.body);
        const secondFailure = turnFailure(second.status, secondStream, second.body);
        if (secondFailure) return fail(second.status === 402 ? 402 : 502, `after sign-in: ${secondFailure}`);
        answer = secondStream.answer!;
        model = secondStream.model ?? model;
      }
    }

    await db
      .update(copilotLeadTurns)
      .set({ status: "answered", answer, model, signedIn, updatedAt: new Date() })
      .where(eq(copilotLeadTurns.id, rowId));
    const [done] = await db.select().from(copilotLeadTurns).where(eq(copilotLeadTurns.id, rowId));
    return { status: 200, body: leadTurnBody(done!, false) };
  } catch (err) {
    return fail(502, err instanceof Error ? err.message : String(err));
  }
}

/** The caller's answer: `/complete`'s shape (`json`, `content`, `model`) plus where the turn ran. */
export function leadTurnBody(row: typeof copilotLeadTurns.$inferSelect, duplicate: boolean) {
  const json = (row.answer ?? {}) as Record<string, unknown>;
  return {
    json,
    content: JSON.stringify(json),
    model: row.model,
    sessionId: row.sessionId,
    account: row.accountOrgId && row.accountUserId ? { orgId: row.accountOrgId, userId: row.accountUserId } : null,
    signedIn: row.signedIn,
    duplicate,
  };
}

// ---------------------------------------------------------------------------
// Default (network) dependencies
// ---------------------------------------------------------------------------

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}

async function clientServiceGet(path: string, fetchImpl: typeof fetch): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetchImpl(`${env("CLIENT_SERVICE_URL")}${path}`, {
    headers: { "x-api-key": env("CLIENT_SERVICE_API_KEY") },
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== 404 && !res.ok) throw new Error(`client-service GET ${path.split("?")[0]} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return { status: res.status, json };
}

/** Whether any distribute.you user has this email (client-service), whatever its organizations. */
export async function emailHasAccount(email: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const { json } = await clientServiceGet(`/internal/users?email=${encodeURIComponent(email.trim().toLowerCase())}`, fetchImpl);
  return Array.isArray(json.users) && json.users.length > 0;
}

/**
 * The account an email is, for a turn that acts as the person: the user with
 * that email, in the org of their latest Copilot conversation, else their only
 * organization. Several organizations and no conversation = no pick (never a
 * silent choice among accounts): the turn reads no account.
 */
export async function resolveEmailAccount(
  database: typeof Db,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PhoneAccount | null> {
  const { json } = await clientServiceGet(`/internal/users?email=${encodeURIComponent(email.trim().toLowerCase())}`, fetchImpl);
  const userIds = (Array.isArray(json.users) ? json.users : [])
    .map((u) => (u as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
  for (const userId of userIds) {
    const [latest] = await database
      .select({ orgId: sessions.orgId })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.configKey, COPILOT_CONFIG_KEY), eq(sessions.guest, false)))
      .orderBy(desc(sessions.updatedAt))
      .limit(1);
    if (latest) return { orgId: latest.orgId, userId };
  }
  for (const userId of userIds) {
    const { status, json: orgs } = await clientServiceGet(`/internal/users/${encodeURIComponent(userId)}/orgs`, fetchImpl);
    if (status === 404) continue;
    const list = (Array.isArray(orgs.organizations) ? orgs.organizations : [])
      .map((o) => (o as { orgId?: unknown }).orgId)
      .filter((id): id is string => typeof id === "string");
    if (list.length === 1) return { orgId: list[0], userId };
    if (list.length > 1) console.warn(`[chat-service] lead turn: ${email} is in ${list.length} organizations and has no Copilot conversation: no account read`);
  }
  return null;
}
