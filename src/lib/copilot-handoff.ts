/**
 * After the web signup, Distry takes the founder over on the channel they pick
 * (DISTRY-CHANNEL-HANDOFF-1125, owner 2026-11-25: the user dashboard is killed;
 * « il faut absolument que le user fasse une action sur un des canaux pour
 * activer ses campagnes (après paiement pour ne pas brusquer la conversion) »).
 *
 * `POST /orgs/copilot/handoff` (the signed-in founder, through the gateway) does
 * two things, each optional, both idempotent per (org, user):
 *
 *  1. `campaignId`: the ONE campaign they built and paid for on the signup page,
 *     created stopped (campaign-service CAMPAIGN-HELD-1125: `status: "stopped"`
 *     at create, nothing runs). The signup page IS their yes to start it; the
 *     owner wants it started on their first message to Distry. So the campaign
 *     is recorded here as WAITING for them, and every Distry turn of that person
 *     (web, WhatsApp, email reply, Telegram: one rule, never a per-channel branch)
 *     reads it as one turn-context part ("waiting-campaign"). The model starts it
 *     with its usual run_operation (PATCH activate); that one request runs without
 *     a second yes because the person already gave it on the signup page, and the
 *     row is marked started so it never starts twice.
 *  2. `sayHelloOn`: Distry writes FIRST, within seconds:
 *     - `whatsapp`: a proactive Copilot turn (copilot-proactive.ts, kind `hello`,
 *       read tools only) sent from the Copilot's own line to the number the person
 *       holds (client-service: their channel number, else the one they typed at
 *       signup). Their answer reaches crm, then the Lead event campaign of our
 *       brand, then a lead turn AS them (lead-turn.ts): the same Distry.
 *     - `email`: their choice IS an act of theirs, so it goes through the ONE
 *       reactive path for our leads: crm-service's "continue by email" hand-off
 *       (the same one a website visitor uses, DISTRY-WEB-CHAT-EMAIL-1117) files
 *       their Copilot conversation + that act on their thread and reports ONE Lead
 *       event; our Lead event campaign's writer (the same Distry, AS their account)
 *       writes them by email, and their reply is the next Lead event, answered in
 *       that thread. Never the follow-up pipe: it does not write to a paying client.
 *     No new send path, no staff email, no hand step.
 */
import { and, desc, eq } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { copilotHandoffs, copilotProactiveTurns, sessions } from "../db/schema.js";
import { COPILOT_CONFIG_KEY } from "./copilot-unibox.js";
import type { ProactiveRecipient } from "./copilot-proactive.js";
import type { WebHandOverBody } from "./web-visitor.js";

export type HelloChannel = "whatsapp" | "email";

export interface HelloRecord {
  at: string;
  status: "sent" | "on_its_way" | "processing" | "failed";
  /** The proactive turn (WhatsApp) or the follow-up campaign (email) that carries it. */
  ref: string | null;
  error: string | null;
}

export type HandoffRow = typeof copilotHandoffs.$inferSelect;

/** One handoff per person: created on first call, the campaign set when one is given (never cleared). */
export async function upsertHandoff(db: typeof Db, args: { orgId: string; userId: string; campaignId: string | null }): Promise<HandoffRow> {
  const [row] = await db
    .insert(copilotHandoffs)
    .values({ orgId: args.orgId, userId: args.userId, campaignId: args.campaignId })
    .onConflictDoNothing({ target: [copilotHandoffs.orgId, copilotHandoffs.userId] })
    .returning();
  if (row) return row;
  const [existing] = await db.select().from(copilotHandoffs).where(and(eq(copilotHandoffs.orgId, args.orgId), eq(copilotHandoffs.userId, args.userId)));
  if (!existing) throw new Error("[handoff] row vanished after insert conflict");
  // A newer signup campaign replaces the recorded one: the latest the person built waits for them.
  if (args.campaignId && existing.campaignId !== args.campaignId) {
    const [updated] = await db
      .update(copilotHandoffs)
      .set({ campaignId: args.campaignId, campaignStartedAt: null, campaignStartedVia: null, updatedAt: new Date() })
      .where(eq(copilotHandoffs.id, existing.id))
      .returning();
    return updated!;
  }
  return existing;
}


export async function readHandoff(db: typeof Db, orgId: string, userId: string): Promise<HandoffRow | null> {
  const [row] = await db.select().from(copilotHandoffs).where(and(eq(copilotHandoffs.orgId, orgId), eq(copilotHandoffs.userId, userId)));
  return row ?? null;
}

/** The campaign waiting for this person's first message, or null. */
export async function waitingCampaignId(db: typeof Db, orgId: string, userId: string): Promise<string | null> {
  const row = await readHandoff(db, orgId, userId);
  return row?.campaignId && !row.campaignStartedAt ? row.campaignId : null;
}

/** Once: the first start wins, a second one changes nothing. */
export async function markCampaignStarted(db: typeof Db, args: { orgId: string; userId: string; campaignId: string; via: string }): Promise<void> {
  const row = await readHandoff(db, args.orgId, args.userId);
  if (!row || row.campaignId !== args.campaignId || row.campaignStartedAt) return;
  await db
    .update(copilotHandoffs)
    .set({ campaignStartedAt: new Date(), campaignStartedVia: args.via, updatedAt: new Date() })
    .where(eq(copilotHandoffs.id, row.id));
}

/** Whether a run_operation request is exactly the start of the waiting campaign (the one request the signup's yes covers). */
export function startsWaitingCampaign(req: { method: string; path: string; body: unknown } | null, campaignId: string | null): boolean {
  if (!req || !campaignId) return false;
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  return (
    req.method.toUpperCase() === "PATCH" &&
    req.path.split("?")[0] === `/v1/sales-funnel-campaigns/${campaignId}` &&
    body.status === "activate" &&
    Object.keys(body).length === 1
  );
}

/** How the handoff answers the dashboard (and GET). */
export function handoffBody(row: HandoffRow) {
  return {
    campaignId: row.campaignId,
    campaignWaiting: Boolean(row.campaignId && !row.campaignStartedAt),
    campaignStartedAt: row.campaignStartedAt ? row.campaignStartedAt.toISOString() : null,
    campaignStartedVia: row.campaignStartedVia,
    hellos: (row.hellos ?? {}) as Partial<Record<HelloChannel, HelloRecord>>,
  };
}

// ---------------------------------------------------------------------------
// Hello
// ---------------------------------------------------------------------------

/** The person's own number: their verified channel number, else the one they typed at signup. */
export function personPhone(user: { phone?: string | null; onboardingPhone?: string | null } | null): string | null {
  const p = user?.phone?.trim() || user?.onboardingPhone?.trim() || "";
  return p ? p : null;
}

/** The act the email hand-off files on their thread (their click, said as what it is: never words they did not write). */
export function emailHelloAct(campaignWaiting: boolean): string {
  return campaignWaiting
    ? "[On the distribute.you signup page, after paying for my campaign, I chose: continue with Distry by email. My campaign waits for my first reply to start.]"
    : "[On the distribute.you signup page, I chose: continue with Distry by email.]";
}

export interface HelloDeps {
  db: typeof Db;
  /** client-service internal read of one user: email + numbers. */
  fetchUser: (userId: string) => Promise<{ email: string | null; phone: string | null; onboardingPhone: string | null } | null>;
  /** runs-service: a Copilot support run under the person's org. */
  createSupportRun: (identity: { orgId: string; userId: string }) => Promise<string>;
  /** Runs the proactive turn in the background (copilot-proactive.ts processProactiveTurn). */
  startProactiveTurn: (rowId: string, recipient: ProactiveRecipient) => void;
  /** web-visitor.ts conversationForHandOver: their Copilot conversation so far, as the hand-off carries it. */
  conversation: (sessionId: string) => Promise<WebHandOverBody["messages"]>;
  /** crm-service POST /internal/copilot/web-conversations (web-visitor.ts handOverByEmailToCrm). */
  handOverByEmail: (body: WebHandOverBody) => Promise<{ status: string }>;
}

async function personSession(db: typeof Db, orgId: string, userId: string): Promise<string> {
  const [own] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.orgId, orgId), eq(sessions.userId, userId), eq(sessions.configKey, COPILOT_CONFIG_KEY), eq(sessions.guest, false), eq(sessions.leadThread, false)))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);
  if (own) return own.id;
  const [created] = await db.insert(sessions).values({ orgId, userId, configKey: COPILOT_CONFIG_KEY }).returning({ id: sessions.id });
  return created!.id;
}

export class NoPhoneError extends Error {}

async function saveHello(db: typeof Db, rowId: string, channel: HelloChannel, rec: HelloRecord): Promise<HandoffRow> {
  const [current] = await db.select().from(copilotHandoffs).where(eq(copilotHandoffs.id, rowId));
  const hellos = { ...((current?.hellos ?? {}) as Record<string, HelloRecord>), [channel]: rec };
  const [row] = await db.update(copilotHandoffs).set({ hellos, updatedAt: new Date() }).where(eq(copilotHandoffs.id, rowId)).returning();
  return row!;
}

/**
 * Distry says hello on one channel, once per (person, channel): a hello already
 * sent or on its way answers the stored record; a failed one is tried again.
 */
export async function sayHello(deps: HelloDeps, row: HandoffRow, channel: HelloChannel): Promise<HandoffRow> {
  const prior = ((row.hellos ?? {}) as Partial<Record<HelloChannel, HelloRecord>>)[channel];
  if (prior && prior.status !== "failed") return row;
  const campaignWaiting = Boolean(row.campaignId && !row.campaignStartedAt);
  const now = new Date().toISOString();

  const user = await deps.fetchUser(row.userId);
  if (channel === "email") {
    try {
      if (!user?.email) throw new Error("This account holds no email address.");
      const sessionId = await personSession(deps.db, row.orgId, row.userId);
      const phone = personPhone(user);
      const out = await deps.handOverByEmail({
        conversationId: `signup-handoff:${row.id}`,
        visitorId: `signup:${row.userId}`,
        email: user.email,
        ...(phone ? { phone } : {}),
        messages: [...(await deps.conversation(sessionId)), { messageId: `signup-handoff:${row.id}:email`, role: "user", text: emailHelloAct(campaignWaiting), at: now }],
      });
      const status: HelloRecord["status"] = out.status === "failed" ? "failed" : out.status === "reported" ? "sent" : "on_its_way";
      return saveHello(deps.db, row.id, "email", { at: now, status, ref: null, error: status === "failed" ? "crm-service could not report the Lead event" : null });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await saveHello(deps.db, row.id, "email", { at: now, status: "failed", ref: null, error });
      throw err;
    }
  }

  const phone = personPhone(user);
  if (!phone) {
    await saveHello(deps.db, row.id, "whatsapp", { at: now, status: "failed", ref: null, error: "no_phone" });
    throw new NoPhoneError("This account holds no phone number: neither a linked WhatsApp number nor one typed at signup.");
  }
  const sessionId = await personSession(deps.db, row.orgId, row.userId);
  const parentRunId = await deps.createSupportRun({ orgId: row.orgId, userId: row.userId });
  const [turn] = await deps.db
    .insert(copilotProactiveTurns)
    .values({
      idempotencyKey: `hello:whatsapp:${row.id}:${now}`,
      kind: "hello",
      orgId: row.orgId,
      brandId: null,
      recipientUserId: row.userId,
      sessionId,
      delivery: "whatsapp",
      status: "processing",
      parentRunId,
      payload: { kind: "hello", channel: "whatsapp", campaignWaiting },
    })
    .returning({ id: copilotProactiveTurns.id });
  const saved = await saveHello(deps.db, row.id, "whatsapp", { at: now, status: "processing", ref: turn!.id, error: null });
  deps.startProactiveTurn(turn!.id, { userId: row.userId, sessionId, whatsapp: { phone } });
  return saved;
}

/** A WhatsApp hello's record follows its proactive turn (delivered / failed), read at GET time. */
export async function refreshWhatsappHello(db: typeof Db, row: HandoffRow): Promise<HandoffRow> {
  const rec = ((row.hellos ?? {}) as Partial<Record<HelloChannel, HelloRecord>>).whatsapp;
  if (!rec || rec.status !== "processing" || !rec.ref) return row;
  const [turn] = await db.select({ status: copilotProactiveTurns.status, error: copilotProactiveTurns.error }).from(copilotProactiveTurns).where(eq(copilotProactiveTurns.id, rec.ref));
  if (!turn || turn.status === "processing") return row;
  return saveHello(db, row.id, "whatsapp", { ...rec, status: turn.status === "delivered" ? "sent" : "failed", error: turn.status === "delivered" ? null : turn.error ?? turn.status });
}

/** client-service internal read of one user (USER-PHONE-READ-1125 serves its numbers beside the email). */
export async function fetchHandoffUser(
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ email: string | null; phone: string | null; onboardingPhone: string | null } | null> {
  const url = process.env.CLIENT_SERVICE_URL;
  const key = process.env.CLIENT_SERVICE_API_KEY;
  if (!url || !key) throw new Error("CLIENT_SERVICE_URL / CLIENT_SERVICE_API_KEY not configured");
  const res = await fetchImpl(`${url}/internal/users/${encodeURIComponent(userId)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`client-service ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { user?: { email?: string | null; phone?: string | null; onboardingPhone?: string | null } };
  const u = body.user;
  return u ? { email: u.email ?? null, phone: u.phone ?? null, onboardingPhone: u.onboardingPhone ?? null } : null;
}
