/**
 * What Distry may spend of OUR money on people who are not paying clients
 * (DISTRY-GUEST-CAPS-1119, owner 2026-11-19).
 *
 *  1. An identified PAYING client: no limit. Their own org pays its turns at cost.
 *  2. An unidentified visitor (no account: a website cookie, a WhatsApp number,
 *     an email with no account): $5, the onboarding advance. Measured in DOLLARS
 *     from the runs ledger: what their guest turns cost (each turn's run tree,
 *     under our org) plus what their plan org spent (the signup page's kind of
 *     org opened for their conversation). Never a message count.
 *  3. Every non-client together: their debt to us may not grow by more than $20
 *     in a UTC day versus the day before (SOLO-PLAN-1125, owner 2026-11-25:
 *     « jamais plus que $20 par jour de plus par rapport à la veille »; replaced
 *     the $30/day limit). Non-client = any turn not run under a paying client's
 *     org: guests on every surface, and accounts that never paid. What their
 *     debt grew today = what we spent on them today, measured on the runs
 *     ledger; a repayment that day is not subtracted (a payer leaves the
 *     non-clients), so the guard can only stop earlier, never later.
 *
 *  4. An account on the SOLO-FOUNDER plan (SOLO-PLAN-1125, owner 2026-11-25: « une dette
 *     de crédit qu'on accepte jusqu'à -$2 »): billing-service owns its debt and plan
 *     state and serves the verdict (`/solo-plan/ai-gate`, `may_use_our_keys`); past it
 *     the turn runs no model and the notice links billing's upgrade page. Read first,
 *     paid or not (a paid plan out of credit stops too). An org whose LLM runs on its
 *     own Claude (LOCAL-CLAUDE-1116) spends none of our keys: never stopped by it.
 *
 * "Paying client" is a served billing fact: billing-service says the org paid
 * us money (`cash_paid_cents` > 0: payments net of refunds and lost disputes,
 * off-platform payments included). Our own org's signed-in turns are staff:
 * never capped, never counted.
 *
 * A turn past a limit runs NO model: the person gets the limit notice below.
 * The day's spend is re-measured every minute (`refreshDistrySpendDay`) and
 * stored per UTC day with its threshold; the first time it reaches the
 * threshold the owner is alerted once (Telegram + email + WhatsApp), and the series is
 * served for dashboard v2 Monitoring (`distrySpendDays`).
 */
import { and, count, eq, gte, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { distrySpendDays, distrySpendOrgs, distrySpendTurns } from "../db/schema.js";

/** SOLO-PLAN-1125: the most the non-payers' debt may grow in one UTC day (owner: $20). */
export const DISTRY_NONPAYER_DEBT_GROWTH_USD_DEFAULT = 20;
export const DISTRY_VISITOR_USD_DEFAULT = 5;
export const SIGN_UP_URL = "https://dashboard.distribute.you/sign-up";
export const DASHBOARD_HOME_URL = "https://dashboard.distribute.you";
/** Kevin's pro WhatsApp number (owner 2026-11-19), as a wa.me link. */
export const OUR_WHATSAPP_URL = "https://wa.me/33680478702";

/**
 * The automatic limit notice (no model call). A limit notice, never an answer
 * to their question. One wording per who they are: a visitor with no account
 * signs up; an account that never paid adds credit.
 */
export const DISTRY_LIMIT_NOTICE_GUEST = [
  "Thanks for talking with Distry! You have reached today's free conversation limit.",
  `To keep going, sign up here: ${SIGN_UP_URL}`,
  `Or write to us on WhatsApp: ${OUR_WHATSAPP_URL}`,
].join("\n");
export const DISTRY_LIMIT_NOTICE_ACCOUNT = [
  "Thanks for talking with Distry! You have reached today's free conversation limit.",
  `To keep going, add credit to your account: ${DASHBOARD_HOME_URL}`,
  `Or write to us on WhatsApp: ${OUR_WHATSAPP_URL}`,
].join("\n");
export const DISTRY_LIMIT_SUBJECT = "Today's free conversation limit with Distry";

export function distryLimitNotice(guest: boolean): string {
  return guest ? DISTRY_LIMIT_NOTICE_GUEST : DISTRY_LIMIT_NOTICE_ACCOUNT;
}

/**
 * SOLO-PLAN-1125: the notice for a solo-founder account past its plan's limit (fixed
 * text, no model call), linking billing's upgrade page; never a dashboard link.
 */
export function soloPlanLimitNotice(upgradeUrl: string | null): string {
  return [
    "Distry has used all the AI room on your distribute.you account for now.",
    upgradeUrl
      ? `Keep your campaigns and Distry going by upgrading your plan: ${upgradeUrl}`
      : "Keep your campaigns and Distry going: ask your AI to start your distribute.you plan.",
  ].join("\n");
}

/** billing-service `GET /internal/accounts/by-org/:orgId/solo-plan/ai-gate` (the fields read here). */
export interface SoloAiGate {
  on_solo_plan: boolean;
  may_use_our_keys: boolean;
  refused_reason: string | null;
  debt_cents: string | null;
  debt_limit_cents: number | null;
  upgrade_url: string | null;
}

function usdEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a dollar amount (e.g. 30), got "${raw}"`);
  return n;
}

/** The most all non-clients' debt may grow today, in cents (`DISTRY_NONPAYER_DEBT_GROWTH_USD`, default $20). */
export function nonClientDailyCents(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(usdEnv(env, "DISTRY_NONPAYER_DEBT_GROWTH_USD", DISTRY_NONPAYER_DEBT_GROWTH_USD_DEFAULT) * 100);
}

/** One unidentified visitor's limit, in cents (`DISTRY_VISITOR_USD`, default $5). */
export function visitorCents(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(usdEnv(env, "DISTRY_VISITOR_USD", DISTRY_VISITOR_USD_DEFAULT) * 100);
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type DistrySurface = "web" | "whatsapp" | "email" | "telegram";

/** Who a turn is for, as its door knows it. */
export interface DistryPerson {
  /** Stable per person: `web:<visitorId>`, `phone:<e164>`, `email:<address>`; an account is keyed on its org. */
  key: string;
  surface: DistrySurface;
  /** No account acts in this turn: it runs under OUR org. */
  guest: boolean;
  /** The org the turn runs under (ours for a guest). */
  turnOrgId: string;
  /** A guest's plan org, when one was opened for their conversation. */
  planOrgId: string | null;
}

export interface DistrySpendDeps {
  db: typeof Db;
  /** distribute.you's own org (the Copilot's line). */
  ourOrgId: () => string;
  /** billing-service: has this org paid us money? */
  isPayingOrg: (orgId: string) => Promise<boolean>;
  /** billing-service: the solo-founder plan's verdict for one org (SOLO-PLAN-1125). */
  soloAiGate: (orgId: string) => Promise<SoloAiGate>;
  /** This org's LLM runs on its own Claude (LOCAL-CLAUDE-1116): its turns spend none of our keys. */
  isLocalLlmOrg: (orgId: string) => Promise<boolean>;
  /** runs-service: each run tree's committed cost (gross cents), all runs under one org. */
  runTreeCents: (orgId: string, runIds: string[]) => Promise<number>;
  /** runs-service: an org's whole ledger total (gross cents). */
  orgTotalCents: (orgId: string) => Promise<number>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export type DistryVerdict =
  /** Runs. `tracked` = non-client spend (record the run after). */
  | { run: true; tracked: boolean; person: DistryPerson }
  | { run: false; reason: "person_cap" | "day_cap" | "plan_limit"; notice: string; person: DistryPerson };

/** PURE: the verdict from the measured figures (cents). The day first: it stops everyone. */
export function distryCapVerdict(a: { guest: boolean; daySpend: number; dayCap: number; personSpend: number; personCap: number }): "day_cap" | "person_cap" | null {
  if (a.daySpend >= a.dayCap) return "day_cap";
  if (a.guest && a.personSpend >= a.personCap) return "person_cap";
  return null;
}

/** An account's turns are keyed on its org: one account, one person. */
export function accountKey(orgId: string): string {
  return `org:${orgId}`;
}

/** What one unidentified visitor has cost us so far (cents): their guest turns' run trees + their plan org's ledger total. */
export async function personSpendCents(deps: DistrySpendDeps, person: DistryPerson): Promise<number> {
  const ours = deps.ourOrgId();
  const rows = await deps.db
    .select({ runId: distrySpendTurns.runId })
    .from(distrySpendTurns)
    .where(and(eq(distrySpendTurns.personKey, person.key), eq(distrySpendTurns.orgId, ours), isNotNull(distrySpendTurns.runId)));
  const runIds = [...new Set(rows.map((r) => r.runId!))];
  const [turns, plan] = await Promise.all([
    runIds.length > 0 ? deps.runTreeCents(ours, runIds) : Promise.resolve(0),
    person.planOrgId ? deps.orgTotalCents(person.planOrgId) : Promise.resolve(0),
  ]);
  return turns + plan;
}

/** The day's stored non-client spend (cents), 0 before the first measure of the day. */
export async function storedDaySpendCents(database: typeof Db, day: string): Promise<number> {
  const [row] = await database.select({ spendCents: distrySpendDays.spendCents }).from(distrySpendDays).where(eq(distrySpendDays.day, day));
  return row ? Number(row.spendCents) : 0;
}

/**
 * Before a turn's model call: may it run? A paying client and our own staff
 * always run, untracked. A non-client runs while the day (and, for a guest,
 * their own $5) is under its limit; a refusal is stored with its reason. A
 * ledger or billing read that fails THROWS: the door fails the turn loudly,
 * never answers on an unmeasured spend.
 */
export async function distryGate(deps: DistrySpendDeps, input: DistryPerson): Promise<DistryVerdict> {
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const ours = deps.ourOrgId();
  let person: DistryPerson = input;
  if (!input.guest) {
    if (input.turnOrgId === ours) return { run: true, tracked: false, person };
    const solo = await deps.soloAiGate(input.turnOrgId);
    if (solo.on_solo_plan && !solo.may_use_our_keys && !(await deps.isLocalLlmOrg(input.turnOrgId))) {
      const key = accountKey(input.turnOrgId);
      await deps.db.insert(distrySpendTurns).values({ day: utcDay(now), personKey: key, surface: input.surface, orgId: input.turnOrgId, runId: null, verdict: "plan_limit" });
      console.warn(
        `[chat-service] Distry: org ${input.turnOrgId} is past its solo-plan limit (${solo.refused_reason ?? "no reason"}, debt ${solo.debt_cents ?? "?"} of ${solo.debt_limit_cents ?? "?"} cents) on ${input.surface}: limit notice, no model call`,
      );
      return { run: false, reason: "plan_limit", notice: soloPlanLimitNotice(solo.upgrade_url), person: { ...input, key } };
    }
    if (await deps.isPayingOrg(input.turnOrgId)) return { run: true, tracked: false, person };
    person = { ...input, key: accountKey(input.turnOrgId), planOrgId: null };
  }
  const day = utcDay(now);
  const daySpend = await storedDaySpendCents(deps.db, day);
  const personSpend = person.guest && daySpend < nonClientDailyCents(env) ? await personSpendCents(deps, person) : 0;
  const reason = distryCapVerdict({ guest: person.guest, daySpend, dayCap: nonClientDailyCents(env), personSpend, personCap: visitorCents(env) });
  if (reason) {
    await deps.db.insert(distrySpendTurns).values({ day, personKey: person.key, surface: person.surface, orgId: person.turnOrgId, runId: null, verdict: reason });
    console.warn(
      `[chat-service] Distry ${reason === "day_cap" ? `day limit reached (${(daySpend / 100).toFixed(2)} of ${(nonClientDailyCents(env) / 100).toFixed(2)} USD)` : `visitor limit reached (${(personSpend / 100).toFixed(2)} USD)`} for ${person.key} on ${person.surface}: limit notice, no model call`,
    );
    return { run: false, reason, notice: distryLimitNotice(person.guest), person };
  }
  // The org whose spend is non-client spend: snapshot its ledger total at first sight today.
  const ownOrg = person.guest ? person.planOrgId : person.turnOrgId;
  if (ownOrg) await snapshotOrg(deps, day, ownOrg, person.guest ? "plan" : "account");
  return { run: true, tracked: true, person };
}

/**
 * An org's ledger total at first sight today. A plan org never seen on any day
 * starts at 0 (it was opened for this conversation, its whole spend is ours to
 * count); any other org starts at its total now (what it spent before is not
 * today's).
 */
async function snapshotOrg(deps: DistrySpendDeps, day: string, orgId: string, kind: "plan" | "account"): Promise<void> {
  const [seenToday] = await deps.db.select({ orgId: distrySpendOrgs.orgId }).from(distrySpendOrgs).where(and(eq(distrySpendOrgs.day, day), eq(distrySpendOrgs.orgId, orgId)));
  if (seenToday) return;
  const [seenBefore] = await deps.db.select({ orgId: distrySpendOrgs.orgId }).from(distrySpendOrgs).where(eq(distrySpendOrgs.orgId, orgId)).limit(1);
  const start = kind === "plan" && !seenBefore ? 0 : await deps.orgTotalCents(orgId);
  await deps.db.insert(distrySpendOrgs).values({ day, orgId, kind, startCents: String(start) }).onConflictDoNothing();
}

/**
 * After a non-client turn ran: its run joins the person's spend, and a plan
 * org opened during the turn is counted from 0. Never throws: the turn already
 * answered; a lost record is logged loud (the next turn re-reads the ledger).
 */
export async function recordDistryTurn(deps: DistrySpendDeps, verdict: DistryVerdict, runId: string, planOrgIdAfter: string | null): Promise<void> {
  if (!verdict.run || !verdict.tracked) return;
  const now = deps.now?.() ?? new Date();
  const day = utcDay(now);
  const { person } = verdict;
  try {
    await deps.db.insert(distrySpendTurns).values({ day, personKey: person.key, surface: person.surface, orgId: person.turnOrgId, runId, verdict: "ran" });
    if (person.guest && planOrgIdAfter) await snapshotOrg(deps, day, planOrgIdAfter, "plan");
  } catch (err) {
    console.error(`[chat-service] Distry spend: the turn of ${person.key} (run ${runId}) could not be recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** What a door holds: the gate before a turn, the record after it. */
export interface DistryGate {
  gate: (person: DistryPerson) => Promise<DistryVerdict>;
  record: (verdict: DistryVerdict, runId: string, planOrgIdAfter: string | null) => Promise<void>;
}

export function distryGateOver(deps: DistrySpendDeps): DistryGate {
  return {
    gate: (person) => distryGate(deps, person),
    record: (verdict, runId, planOrgIdAfter) => recordDistryTurn(deps, verdict, runId, planOrgIdAfter),
  };
}

// ---------------------------------------------------------------------------
// The day: measured every minute, stored, alerted once
// ---------------------------------------------------------------------------

/** PURE: what the series and the alert say about one day. */
export interface DistrySpendDay {
  day: string;
  /** Non-client spend measured on the runs ledger, USD (guest turns + plan orgs + accounts that never paid). */
  nonClientSpendUsd: number;
  /** The day's limit in force, USD. */
  thresholdUsd: number;
  /** Distinct visitors stopped at their own limit that day. */
  visitorsCut: number;
  /** Messages answered by the limit notice because the day's limit was reached. */
  turnsRefusedByDayCap: number;
  /** The owner was alerted that day (the spend reached the limit). */
  alertFired: boolean;
  alertFiredAt: string | null;
  /** When the spend was last measured; null = never measured that day. */
  measuredAt: string | null;
}

/** The day's non-client spend now (cents), from the ledger. */
export async function measureDaySpendCents(deps: DistrySpendDeps, day: string): Promise<number> {
  const ours = deps.ourOrgId();
  const turns = await deps.db
    .select({ runId: distrySpendTurns.runId })
    .from(distrySpendTurns)
    .where(and(eq(distrySpendTurns.day, day), eq(distrySpendTurns.orgId, ours), isNotNull(distrySpendTurns.runId)));
  const runIds = [...new Set(turns.map((t) => t.runId!))];
  let total = 0;
  for (let i = 0; i < runIds.length; i += 500) total += await deps.runTreeCents(ours, runIds.slice(i, i + 500));
  const orgs = await deps.db.select().from(distrySpendOrgs).where(eq(distrySpendOrgs.day, day));
  for (const o of orgs) {
    const delta = (await deps.orgTotalCents(o.orgId)) - Number(o.startCents);
    if (delta > 0) total += delta;
  }
  return total;
}

export interface DistryAlertDeps {
  sendTelegram: (html: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** The owner's WhatsApp (owner 2026-11-25: on top of Telegram + email); throws unless sent. */
  sendWhatsapp: (text: string, day: string) => Promise<void>;
  /** The staff email (transactional-email-service platform staff alert); one id per day, a repeat never mails twice. */
  sendEmail: (alert: DistryAlertFacts) => Promise<void>;
}

export interface DistryAlertFacts {
  day: string;
  spentUsd: string;
  limitUsd: string;
  visitorsCut: string;
  turnsRefused: string;
}

/** The Telegram text of the day's alert (HTML). */
export function distryAlertTelegram(f: DistryAlertFacts): string {
  return [
    `🚨 <b>Non-payers' debt grew $${f.spentUsd} today, the most allowed is $${f.limitUsd} a day</b>`,
    `What we spent on people who never paid today (${f.day} UTC): <b>$${f.spentUsd}</b> of $${f.limitUsd}.`,
    "Every non-payer now gets the limit notice instead of an answer, until midnight UTC. Paying clients are not affected.",
    `Visitors stopped at their own limit today: ${f.visitorsCut}. Messages refused by the day limit so far: ${f.turnsRefused}.`,
    "Raise it with DISTRY_NONPAYER_DEBT_GROWTH_USD in env/chat-service.env on the box.",
  ].join("\n");
}

/** The WhatsApp text of the same alert (plain text). */
export function distryAlertWhatsapp(f: DistryAlertFacts): string {
  return [
    `Distry alert: non-payers' debt grew $${f.spentUsd} today (${f.day} UTC), the most allowed is $${f.limitUsd} a day.`,
    "Every non-payer gets the limit notice instead of an answer until midnight UTC. Paying clients are not affected.",
    `Visitors stopped at their own limit: ${f.visitorsCut}. Messages refused so far: ${f.turnsRefused}.`,
  ].join("\n");
}

async function dayCounts(database: typeof Db, day: string): Promise<{ visitorsCut: number; turnsRefused: number }> {
  const [cut] = await database
    .select({ n: sql<number>`count(distinct ${distrySpendTurns.personKey})::int` })
    .from(distrySpendTurns)
    .where(and(eq(distrySpendTurns.day, day), eq(distrySpendTurns.verdict, "person_cap")));
  const [refused] = await database
    .select({ n: count() })
    .from(distrySpendTurns)
    .where(and(eq(distrySpendTurns.day, day), eq(distrySpendTurns.verdict, "day_cap")));
  return { visitorsCut: Number(cut?.n ?? 0), turnsRefused: Number(refused?.n ?? 0) };
}

/**
 * One measure of today: stores the spend and the limit; the FIRST time the
 * spend reaches the limit it claims the day's alert (one row update, so two
 * processes never both send) and sends it. A channel that failed is retried on
 * the next measure until it delivers; a delivered channel never sends again.
 */
export async function refreshDistrySpendDay(deps: DistrySpendDeps & DistryAlertDeps): Promise<{ day: string; spendCents: number; thresholdCents: number; alerted: string[] }> {
  const now = deps.now?.() ?? new Date();
  const day = utcDay(now);
  const thresholdCents = nonClientDailyCents(deps.env ?? process.env);
  const spendCents = await measureDaySpendCents(deps, day);
  await deps.db
    .insert(distrySpendDays)
    .values({ day, spendCents: String(spendCents), thresholdCents: String(thresholdCents), refreshedAt: now })
    .onConflictDoUpdate({ target: distrySpendDays.day, set: { spendCents: String(spendCents), thresholdCents: String(thresholdCents), refreshedAt: now } });
  const alerted: string[] = [];
  if (spendCents < thresholdCents) return { day, spendCents, thresholdCents, alerted };
  await deps.db.update(distrySpendDays).set({ alertFiredAt: now }).where(and(eq(distrySpendDays.day, day), isNull(distrySpendDays.alertFiredAt)));
  const [row] = await deps.db.select().from(distrySpendDays).where(eq(distrySpendDays.day, day));
  if (!row || (row.alertTelegramAt && row.alertEmailAt && row.alertWhatsappAt)) return { day, spendCents, thresholdCents, alerted };
  const counts = await dayCounts(deps.db, day);
  const facts: DistryAlertFacts = {
    day,
    spentUsd: (spendCents / 100).toFixed(2),
    limitUsd: (thresholdCents / 100).toFixed(2),
    visitorsCut: String(counts.visitorsCut),
    turnsRefused: String(counts.turnsRefused),
  };
  const errors: string[] = [];
  if (!row.alertTelegramAt) {
    // Claim first: a second process reading the same row sends nothing.
    const claimed = await deps.db
      .update(distrySpendDays)
      .set({ alertTelegramAt: now })
      .where(and(eq(distrySpendDays.day, day), isNull(distrySpendDays.alertTelegramAt)))
      .returning({ day: distrySpendDays.day });
    if (claimed.length > 0) {
      const sent = await deps.sendTelegram(distryAlertTelegram(facts));
      if (sent.ok) alerted.push("telegram");
      else {
        await deps.db.update(distrySpendDays).set({ alertTelegramAt: null }).where(eq(distrySpendDays.day, day));
        errors.push(`telegram: ${sent.error}`);
      }
    }
  }
  if (!row.alertWhatsappAt) {
    // Claim first, like Telegram: a second process never sends it twice.
    const claimed = await deps.db
      .update(distrySpendDays)
      .set({ alertWhatsappAt: now })
      .where(and(eq(distrySpendDays.day, day), isNull(distrySpendDays.alertWhatsappAt)))
      .returning({ day: distrySpendDays.day });
    if (claimed.length > 0) {
      try {
        await deps.sendWhatsapp(distryAlertWhatsapp(facts), day);
        alerted.push("whatsapp");
      } catch (err) {
        await deps.db.update(distrySpendDays).set({ alertWhatsappAt: null }).where(eq(distrySpendDays.day, day));
        errors.push(`whatsapp: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (!row.alertEmailAt) {
    try {
      // transactional-email delivers one event id once, ever: a retry after a delivery answers duplicate.
      await deps.sendEmail(facts);
      await deps.db.update(distrySpendDays).set({ alertEmailAt: now }).where(eq(distrySpendDays.day, day));
      alerted.push("email");
    } catch (err) {
      errors.push(`email: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await deps.db.update(distrySpendDays).set({ alertError: errors.length > 0 ? errors.join(" | ").slice(0, 2000) : null }).where(eq(distrySpendDays.day, day));
  if (errors.length > 0) console.error(`[chat-service] Distry day-limit alert for ${day} not fully delivered (retried next minute): ${errors.join(" | ")}`);
  if (alerted.length > 0) console.warn(`[chat-service] Distry day limit reached on ${day} ($${facts.spentUsd} of $${facts.limitUsd}): owner alerted on ${alerted.join(", ")}`);
  return { day, spendCents, thresholdCents, alerted };
}

/** The daily series for dashboard v2 Monitoring: one row per UTC day, oldest first, zeros included. */
export async function distrySpendDaysSeries(database: typeof Db, days: number, now = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<DistrySpendDay[]> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = utcDay(new Date(today - (days - 1) * 86_400_000));
  const to = utcDay(now);
  const stored = await database.select().from(distrySpendDays).where(and(gte(distrySpendDays.day, from), lte(distrySpendDays.day, to)));
  const refusals = await database
    .select({ day: distrySpendTurns.day, verdict: distrySpendTurns.verdict, personKey: distrySpendTurns.personKey })
    .from(distrySpendTurns)
    .where(and(gte(distrySpendTurns.day, from), lte(distrySpendTurns.day, to), ne(distrySpendTurns.verdict, "ran")));
  const byDay = new Map(stored.map((r) => [r.day, r]));
  const out: DistrySpendDay[] = [];
  for (let i = 0; i < days; i++) {
    const day = utcDay(new Date(today - (days - 1 - i) * 86_400_000));
    const row = byDay.get(day);
    const mine = refusals.filter((r) => r.day === day);
    out.push({
      day,
      nonClientSpendUsd: row ? Math.round(Number(row.spendCents)) / 100 : 0,
      thresholdUsd: (row ? Number(row.thresholdCents) : nonClientDailyCents(env)) / 100,
      visitorsCut: new Set(mine.filter((r) => r.verdict === "person_cap").map((r) => r.personKey)).size,
      turnsRefusedByDayCap: mine.filter((r) => r.verdict === "day_cap").length,
      alertFired: Boolean(row?.alertFiredAt),
      alertFiredAt: row?.alertFiredAt ? row.alertFiredAt.toISOString() : null,
      measuredAt: row ? row.refreshedAt.toISOString() : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Default (network) dependencies
// ---------------------------------------------------------------------------

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}

function cents(v: unknown, what: string): number {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`runs-service answered no number for ${what}: ${JSON.stringify(v)}`);
  return n;
}

/** runs-service POST /v1/runs/costs/batch: each root's whole tree, committed cost (gross, cents). */
export async function runTreeCentsFromLedger(orgId: string, runIds: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(`${process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org"}/v1/runs/costs/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env("RUNS_SERVICE_API_KEY"), "x-org-id": orgId },
    body: JSON.stringify({ runIds }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`runs-service costs batch ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { costs?: Array<{ totalCostInUsdCents?: unknown }> };
  if (!Array.isArray(json.costs)) throw new Error(`runs-service costs batch answered no costs: ${text.slice(0, 300)}`);
  return json.costs.reduce((sum, c) => sum + cents(c.totalCostInUsdCents, "a run tree's cost"), 0);
}

/** runs-service GET /internal/org-actual-total: an org's whole committed total (gross, cents). */
export async function orgTotalCentsFromLedger(orgId: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(`${process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org"}/internal/org-actual-total?org_id=${encodeURIComponent(orgId)}`, {
    headers: { "x-api-key": env("RUNS_SERVICE_API_KEY") },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`runs-service org-actual-total ${res.status}: ${text.slice(0, 300)}`);
  return cents((JSON.parse(text) as { total_expected_cents?: unknown }).total_expected_cents, `org ${orgId}'s total`);
}

const PAYING_TTL_MS = 5 * 60_000;
const payingCache = new Map<string, { paying: boolean; at: number }>();

/** billing-service GET /internal/accounts/by-org/:orgId/cash: the org paid us money (net of refunds). A yes is kept; a no is re-asked every 5 minutes (they may pay). */
export async function isPayingOrgFromBilling(orgId: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
  const hit = payingCache.get(orgId);
  if (hit && (hit.paying || now - hit.at < PAYING_TTL_MS)) return hit.paying;
  const res = await fetchImpl(`${process.env.BILLING_SERVICE_URL || "https://billing.mcpfactory.org"}/internal/accounts/by-org/${encodeURIComponent(orgId)}/cash`, {
    headers: { "x-api-key": env("BILLING_SERVICE_API_KEY") },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`billing-service cash ${res.status}: ${text.slice(0, 300)}`);
  const paid = (JSON.parse(text) as { cash_paid_cents?: unknown }).cash_paid_cents;
  const paying = cents(paid, `org ${orgId}'s cash paid`) > 0;
  payingCache.set(orgId, { paying, at: now });
  return paying;
}

/** billing-service GET /internal/accounts/by-org/:orgId/solo-plan/ai-gate: the plan's verdict for one turn (not cached: it moves with each spend). */
export async function soloAiGateFromBilling(orgId: string, fetchImpl: typeof fetch = fetch): Promise<SoloAiGate> {
  const res = await fetchImpl(`${process.env.BILLING_SERVICE_URL || "https://billing.mcpfactory.org"}/internal/accounts/by-org/${encodeURIComponent(orgId)}/solo-plan/ai-gate`, {
    headers: { "x-api-key": env("BILLING_SERVICE_API_KEY") },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`billing-service solo-plan ai-gate ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as Partial<SoloAiGate>;
  if (typeof json.on_solo_plan !== "boolean" || typeof json.may_use_our_keys !== "boolean") {
    throw new Error(`billing-service solo-plan ai-gate answered no verdict: ${text.slice(0, 300)}`);
  }
  return {
    on_solo_plan: json.on_solo_plan,
    may_use_our_keys: json.may_use_our_keys,
    refused_reason: typeof json.refused_reason === "string" ? json.refused_reason : null,
    debt_cents: typeof json.debt_cents === "string" ? json.debt_cents : null,
    debt_limit_cents: typeof json.debt_limit_cents === "number" ? json.debt_limit_cents : null,
    upgrade_url: typeof json.upgrade_url === "string" ? json.upgrade_url : null,
  };
}

/** Test hook. */
export function clearPayingCache(): void {
  payingCache.clear();
}

export const DISTRY_ALERT_EVENT = "distry_nonclient_day_budget_reached";

/** transactional-email-service POST /platform-staff-alert (v0.25.38): staff list only, one event id per UTC day, a repeat never mails twice. */
export async function sendDistryAlertEmail(f: DistryAlertFacts, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${env("TRANSACTIONAL_EMAIL_SERVICE_URL")}/platform-staff-alert`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env("TRANSACTIONAL_EMAIL_SERVICE_API_KEY") },
    body: JSON.stringify({
      eventType: DISTRY_ALERT_EVENT,
      eventId: `distry-nonclient-day:${f.day}`,
      metadata: {
        day: f.day,
        spentUsd: f.spentUsd,
        budgetUsd: f.limitUsd,
        visitorsCapped: f.visitorsCut,
        messagesRefused: f.turnsRefused,
        budgetEnvVar: "DISTRY_NONPAYER_DEBT_GROWTH_USD",
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`transactional-email platform-staff-alert ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
}
