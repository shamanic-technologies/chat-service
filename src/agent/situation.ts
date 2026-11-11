// ---------------------------------------------------------------------------
// Sophie's situation brief (SOPHIE-REFONTE-1102 P1, owner 2026-11-02: « a
// situation brief per turn »).
//
// Before each turn, the account is read once with the same gateway reads her
// tools use and handed to her as the turn's context, right after the client
// brief (client-brief.ts: their brands, offers and what they sell, from their
// website). This block says where the account STANDS: the offer's settings,
// campaigns, results, replies waiting, money. She starts every reply knowing
// it; tools are for going deeper, never for discovering the basics (Jcurve
// 2026-11-01: 12 tool calls for one reply).
//
// A read that fails is named in the brief (the turn still runs, she says
// nothing about it): a brief is context, never a gate on answering.
//
// The account is stated AS THE CLIENT'S DASHBOARD SHOWS IT: the same served
// fields and verdicts, in the same words (SOPHIE-BRIEF-EQUALS-DASHBOARD-1103,
// prod 2026-11-03: the dashboard said "Campaigns paused: payment declined" and
// Spent $103; the brief, rebuilt from raw billing fields, said "card on file",
// $178 used and a stopped campaign with no reason, and she told the client
// "nothing is blocking your account"). A dashboard fact missing here is a bug
// of this file, never a rule to add to her prompt.
// ---------------------------------------------------------------------------

export interface SituationReader {
  listBrands(): Promise<unknown>;
  listOffers(brandId: string): Promise<unknown>;
  getOfferSettings(brandId: string, offerId: string): Promise<unknown>;
  listCampaigns(brandId: string): Promise<unknown>;
  getOfferPerformance(brandId: string, offerId: string): Promise<unknown>;
  listRepliesToHandle(brandId: string, offerId: string): Promise<unknown>;
  getBillingAccount(): Promise<unknown>;
  /** billing's payment outlook: whether billing holds the org NOW (the dashboard's payment band). */
  getPaymentOutlook(): Promise<unknown>;
  /**
   * features-service's next steps of one campaign: what waits to go out, when, and (`nextSends.heldBy`)
   * the step of the campaign that cannot run, THE reason nothing goes out. Absent = not read (a replay
   * that recorded no answer for it).
   */
  getCampaignNextSteps?(brandId: string, campaignId: string): Promise<unknown | null>;
}

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const asArr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(asObj) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const dollars = (cents: unknown): string | null => {
  const c = num(cents);
  return c === null ? null : `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
};

async function settle<T>(label: string, read: () => Promise<T>, failed: string[]): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.warn(`[situation] ${label} unreadable: ${err instanceof Error ? err.message : String(err)}`);
    failed.push(label);
    return null;
  }
}

// The dashboard's words for a payment hold (distribute.you `lib/payment-declined.ts`):
// the pill on a campaign stopped over payment, and the band every brand page shows
// while billing holds the org. Kept byte-equal so she says what the client reads.
type HoldKind = "declined" | "no_payment_method";
const HOLD_PILL: Record<HoldKind, string> = {
  declined: "Paused: payment declined",
  no_payment_method: "Paused: no payment method",
};
const HOLD_TITLE: Record<HoldKind, string> = {
  declined: "Campaigns paused: payment declined",
  no_payment_method: "Campaigns paused: no payment method",
};
const HOLD_NOTE: Record<HoldKind, string> = {
  declined: "Your card was declined, so we paused your campaigns. Pay your outstanding balance and add a card that works, then start them again.",
  no_payment_method: "There is no payment method on your account, so we paused your campaigns. Add a card, then start them again.",
};

/** campaign-service's stop reasons (closed vocabulary, `stop-reason.ts`), in the client's words. */
function holdKindOfStop(reason: string | null): HoldKind | null {
  if (reason === "payment_declined") return "declined";
  if (reason === "no_payment_method") return "no_payment_method";
  return null;
}
const STOP_WORDS: Record<string, string> = {
  manual: "stopped by them",
  org_teardown: "stopped: account closing",
  replaced_by_lead_sourcing: "stopped: replaced by their lead sourcing",
};
const RUNNING = new Set(["ongoing", "active", "running"]);

/** "Paused: payment declined" / "stopped by them" / "ongoing": the status as the campaigns table states it. */
function statusWords(c: Obj): string | null {
  const status = str(c.status);
  if (!status || RUNNING.has(status)) return status;
  const reason = str(c.stopReason);
  const hold = holdKindOfStop(reason);
  if (hold) return HOLD_PILL[hold];
  if (reason) return STOP_WORDS[reason] ?? `${status} (${reason})`;
  return status;
}

/** billing's verdict: is the org held over payment NOW, and which way (the dashboard's `billingHoldKind`). */
function billingHoldKind(outlook: Obj): HoldKind | null {
  if (str(outlook.state) !== "charge_blocked") return null;
  return str(outlook.blockedReason) === "no_chargeable_card" ? "no_payment_method" : "declined";
}

const BLOCK_WORDS: Record<string, string> = {
  card_declined: "the bank declined their card",
  card_unusable: "their card cannot be charged",
  retries_exhausted: "every retry on their card was declined",
  no_chargeable_card: "no card can be charged",
  card_country_unsupported: "their card's country is not supported",
};

const dayWords = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).replace(",", "")}, ${d.toISOString().slice(11, 16)} UTC`;
};

/**
 * What their dashboard shows about their account right now, as notices: the
 * payment band at the top of every brand page, the Billing page's notes. Each is
 * the dashboard's own condition over the same served facts, never a guess.
 */
function dashboardNotices(campaigns: Obj[] | null, outlook: Obj | null, billing: Obj | null): string[] {
  const out: string[] = [];
  if (outlook) {
    const hold = billingHoldKind(outlook);
    if (hold) {
      // The band speaks when billing holds the org AND nothing runs AND a campaign stopped over payment.
      const stoppedOverPayment =
        campaigns !== null &&
        !campaigns.some((c) => RUNNING.has(str(c.status) ?? "")) &&
        campaigns.some((c) => holdKindOfStop(str(c.stopReason)) !== null);
      const why = BLOCK_WORDS[str(outlook.blockedReason) ?? ""] ?? "billing cannot charge them";
      const retry = dayWords(str(outlook.nextChargeAttemptAt));
      out.push(
        stoppedOverPayment
          ? `- Banner on every page: "${HOLD_TITLE[hold]}". "${HOLD_NOTE[hold]}" (billing holds the account now: ${why}.)`
          : `- Billing holds the account now (${why}): no campaign can start until it clears. ${HOLD_NOTE[hold].replace(/^.*?so we paused your campaigns\. /, "")}`,
      );
      if (retry) out.push(`- Billing tries their card again ${retry}.`);
    } else if (campaigns?.some((c) => holdKindOfStop(str(c.stopReason)) !== null)) {
      out.push("- A campaign was paused over payment earlier; billing no longer holds the account, so it can be started again.");
    }
  } else out.push("- Whether billing holds the account (the payment band): not known this turn.");
  if (billing) {
    const mode = str(billing.payment_mode);
    if (mode === "postpaid" && billing.has_payment_method === false) out.push('- Billing page: "Add a card so your campaigns can run on credit."');
    if (mode === "prepaid" && billing.has_auto_topup !== true && (num(billing.balance_cents) ?? 1) <= 0) {
      out.push('- Billing page: "Your credit has run out. Add credit to keep your campaigns running."');
    }
  }
  return out;
}

/**
 * One campaign, every money figure labelled with its basis and scope (SOPHIE-TRUTH-1105, prod
 * 2026-11-04 Beyond Logic: "$169.63 of its $200 this month" and "$152.86 since you started" in
 * one answer, since-start smaller than this month, because the brief served "$169.63 spent this
 * month" (billing's count against the cap, before their discount) beside "$152.86 invested since
 * start" (what they pay, after it) with no word saying which was which).
 */
function campaignLine(c: Obj, next: Obj | null = null): string {
  const bits = [
    str(c.name) ? `"${str(c.name)}"` : "a campaign",
    statusWords(c),
    ...(next ? heldBits(next) : []),
    str(c.path) ? `does: ${str(c.path)}` : null,
    str(c.runsWhen) ? `runs: ${str(c.runsWhen)}` : null,
    str(c.budget) ? `budget: ${str(c.budget)}` : null,
    str(c.spent) ? `used against its cap: ${str(c.spent)} (this campaign, its cap period, before their discount)` : null,
    str(c.invested) ? `paid: ${str(c.invested)} (this campaign, since it started, after their discount)` : null,
    str(c.return) ? `return: ${str(c.return)} (this campaign, whole history)` : null,
    ...(next ? queueBits(next) : []),
  ].filter(Boolean);
  return `- ${bits.join("; ")}`;
}

/** "message_written" → "Message written": the Engine named by the outcome it makes. */
const outcomeWords = (o: string): string => {
  const w = o.replace(/[_-]+/g, " ").trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/**
 * What waits to go out on one running campaign, as features-service serves it (NEXT-STEPS-TRUE-REASON-1111,
 * prod 2026-11-11: 123 leads served, no email written because the campaign's « Message written » step could
 * not run without a brief; the brief held only the cap, and she told the client "today's cap is used, the
 * first emails leave tomorrow"). A held step is stated first: it is the served reason, every other one is a guess.
 */
function heldBits(next: Obj): string[] {
  const ns = asObj(next.nextSends);
  const held = asObj(ns.heldBy);
  const out: string[] = [];
  if (str(held.outcome)) {
    const waiting = num(ns.leadsWaitingOnHeldEngine);
    const since = dayWords(str(held.heldSince));
    out.push(
      `HELD: nothing (more) goes out because its "${outcomeWords(String(held.outcome))}" step cannot run (served reason: ${str(held.reason) ?? "not stated"}${since ? `, since ${since}` : ""})${waiting !== null ? `; ${waiting} ${waiting === 1 ? "lead waits" : "leads wait"} at that step with nothing sent yet` : ""}`,
    );
  }
  return out;
}

/** What waits to go out and its earliest send, as served (an unreadable queue is said as unreadable). */
function queueBits(next: Obj): string[] {
  const ns = asObj(next.nextSends);
  const held = asObj(ns.heldBy);
  const out: string[] = [];
  const queued = num(ns.leadsQueued);
  const nextAt = dayWords(str(ns.nextSendAt));
  const when = nextAt ? `, earliest send ${nextAt}` : str(held.outcome) ? ", no send time planned until that step can run" : "";
  if (queued !== null) out.push(`queued to go out: ${queued} ${queued === 1 ? "lead" : "leads"}${when}`);
  else if (str(ns.unavailableReason)) out.push(`queue not readable right now (${str(ns.unavailableReason)}): say you cannot see it, not that nothing is queued`);
  return out;
}

/** Said once under the campaigns when one is held: the strategy, never a reply per reason. */
const HELD_LINE =
  "A campaign marked HELD has a step that cannot run: that is the whole reason nothing (more) goes out on it, served by the system. Say it first in plain words: which step, why (the served reason, said as what it means for them), how many leads wait. Then unblock it with them: ask for what only they know (for a missing campaign brief: who to keep and what the emails should say) and write it from their words. While it is held, its cap use, budget and the clock explain none of the wait and no send time is known: a cap figure or a day said beside the held step reads to them as a second reason, so that answer leaves them out and says the first emails go once the step can run.";

/** How many running campaigns get their next steps read each turn (one features-service read each). */
const NEXT_STEPS_READS = 3;

/** The dashboard's "Spent" tile: billed since they started, net of their discount, served by features-service. */
function spentLine(perf: unknown, offerName: string | null): string | null {
  const spent = asObj(asObj(perf).spent);
  const actual = num(spent.actualSpentCents);
  if (actual === null) return null;
  const total = num(spent.totalSpentCents);
  const scope = offerName ? `every campaign of the offer "${offerName}"` : "every campaign of this offer";
  return `**Spent** (their dashboard's Spent tile: ${scope}, since they started, after their discount): ${dollars(actual)}${total !== null && total > actual ? ` (${dollars(total)} with follow-ups reserved)` : ""}.`;
}

/** Said once under the figures: each money figure has its own basis, so two are never set side by side. */
const MONEY_BASES_LINE =
  "Each money figure above names its scope (one campaign or the whole offer; its cap period or since they started; before or after their discount). Quote one figure with its scope, never two of different scopes as if comparable. Two that cannot both be true on the same scope are a bug for the team, filed silently.";

function performanceLines(perf: unknown): string[] {
  const p = asObj(perf);
  const keys = ["recipientsContacted", "recipientsClicked", "recipientsRepliesPositive", "meetingsBooked", "signups", "purchased", "maturity", "headline"];
  return keys
    .filter((k) => p[k] !== undefined && p[k] !== null)
    .map((k) => `- ${k}: ${typeof p[k] === "object" ? JSON.stringify(p[k]).slice(0, 400) : String(p[k])}`);
}

/**
 * How this account pays, in words (billing-service's model): a reply that
 * guessed it told a postpaid client "nothing is due until a meeting is
 * booked" while they already owed (Jarygo 2026-10-21).
 */
function paymentWords(b: Obj, held: boolean): string | null {
  const mode = str(b.payment_mode);
  if (mode === "postpaid") {
    const owed = num(b.amount_owed_cents);
    const step = dollars(b.credit_line_step_cents);
    // "Balance due" = the dashboard's word and figure (`postpaidOwed`: amount owed, ceiled to the cent).
    const due = owed === null ? null : dollars(Math.max(0, Math.ceil(owed - 1e-9)));
    const when = held ? "" : step ? `, charged to their card each time it reaches ${step} and at month end` : ", charged at month end";
    return `postpaid: work is billed as it runs${due !== null ? `; balance due ${due}${when}` : ""}`;
  }
  if (mode === "prepaid") return `prepaid: work is paid from a balance they add money to${b.has_auto_topup === true ? ", topped up automatically from their card" : ""}`;
  return mode ? `payment: ${mode}` : null;
}

function moneyLine(billing: unknown, held: boolean): string {
  const b = asObj(billing);
  const pending = num(b.free_credit_pending_cents);
  const toPay = num(b.free_credit_remaining_to_pay_cents);
  const postpaid = str(b.payment_mode) === "postpaid";
  const parts = [
    paymentWords(b, held),
    // A postpaid page states the balance due; a prepaid one the balance left.
    !postpaid && dollars(b.balance_cents) ? `balance ${dollars(b.balance_cents)}` : null,
    b.has_payment_method === true ? `card on file${str(b.card_last4) ? ` (ending ${str(b.card_last4)})` : ""}` : b.has_payment_method === false ? "no card on file" : null,
    num(b.free_credit_spendable_cents) ? `free credit left ${dollars(b.free_credit_spendable_cents)}` : null,
    pending && toPay ? `${dollars(pending)} of credit comes once they have paid ${dollars(toPay)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "not read";
}

/** The next steps of the first running campaigns, by campaign id (a failed read is named, never a gate). */
async function readNextSteps(reader: SituationReader, brandId: string, campaigns: Obj[], failed: string[]): Promise<Map<string, Obj>> {
  const read = reader.getCampaignNextSteps?.bind(reader);
  const out = new Map<string, Obj>();
  if (!read) return out;
  const running = campaigns.filter((c) => RUNNING.has(str(c.status) ?? "") && str(c.id)).slice(0, NEXT_STEPS_READS);
  await Promise.all(
    running.map(async (c) => {
      const id = String(c.id);
      const body = await settle(`next steps of "${str(c.name) ?? id}"`, () => read(brandId, id), failed);
      // null = nothing recorded for this campaign (a replay): nothing to add, no failed read.
      if (body !== null && body !== undefined) out.set(id, asObj(body));
    }),
  );
  return out;
}

/** "Today: Sunday 1 November 2026 (UTC)." A reply that guessed the day promised a Sunday send (2026-11-01). */
export function todayLine(now: Date): string {
  return `Today: ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).replace(",", "")} (UTC).`;
}

/**
 * The brief: one block, a few hundred words, read in one pass. `brandId` /
 * `offerId` narrow it to what the person has open; without them, the org's
 * first brand and its first active offer.
 */
export async function buildSituationBrief(
  reader: SituationReader,
  opts: { brandId?: string | null; offerId?: string | null; now?: Date } = {},
): Promise<string> {
  const failed: string[] = [];
  const brands = asArr(asObj(await settle("brands", () => reader.listBrands(), failed)).brands);
  const lines: string[] = [
    "\n\n---\n## Where their account stands (read just now, before this message)",
    todayLine(opts.now ?? new Date()),
  ];
  if (brands.length === 0) {
    lines.push(failed.length ? "The account could not be read this turn: use your tools." : "Nothing set up yet: no brand, no campaign.");
    return lines.join("\n");
  }
  const brand = brands.find((b) => b.id === opts.brandId) ?? brands[0];
  const brandId = String(brand.id);

  const [offersBody, campaignsBody, billing, outlook] = await Promise.all([
    settle("offers", () => reader.listOffers(brandId), failed),
    settle("campaigns", () => reader.listCampaigns(brandId), failed),
    settle("billing", () => reader.getBillingAccount(), failed),
    settle("payment hold", () => reader.getPaymentOutlook(), failed),
  ]);
  const offers = asArr(asObj(offersBody).offers);
  const offer = offers.find((o) => o.offerId === opts.offerId) ?? offers.find((o) => o.status === "active") ?? offers[0];
  const offerId = offer ? String(offer.offerId) : null;

  const [settings, perf, replies] = offerId
    ? await Promise.all([
        settle("offer settings", () => reader.getOfferSettings(brandId, offerId), failed),
        settle("results", () => reader.getOfferPerformance(brandId, offerId), failed),
        settle("replies waiting", () => reader.listRepliesToHandle(brandId, offerId), failed),
      ])
    : [null, null, null];

  const campaigns = asArr(asObj(campaignsBody).campaigns);
  const nextSteps = await readNextSteps(reader, brandId, campaigns, failed);
  const notices = dashboardNotices(campaignsBody === null ? null : campaigns, outlook === null ? null : asObj(outlook), billing === null ? null : asObj(billing));
  lines.push(
    notices.length
      ? "**Their dashboard shows** (say it as it is):"
      : "**Their dashboard shows**: no payment notice; billing does not hold the account.",
    ...notices,
  );

  if (brands.length > 1) lines.push(`For brand "${String(brand.name ?? brandId)}" (the one open, else the first).`);
  if (offer) {
    const s = asObj(settings);
    const worth = num(s.lifetimeRevenueUsd);
    lines.push(
      `**Offer**: "${String(offer.name)}"${offers.length > 1 ? ` (one of ${offers.length}, the one open or the first active)` : ""}${worth !== null ? `; the client says one paying client is worth $${worth} to them (a value they stated, not a client they have)` : ""}${str(s.bookingUrl) ? `; booking link ${str(s.bookingUrl)}` : "; no booking link saved"}.`,
    );
  } else if (offersBody !== null) {
    lines.push("**Offer**: none yet.");
  }

  if (campaignsBody !== null) {
    lines.push(campaigns.length ? `**Campaigns** (${campaigns.length}):` : "**Campaigns**: none yet, so nobody is being reached.");
    lines.push(...campaigns.slice(0, 8).map((c) => campaignLine(c, nextSteps.get(String(c.id)) ?? null)));
    if ([...nextSteps.values()].some((n) => str(asObj(asObj(n.nextSends).heldBy).outcome))) lines.push(HELD_LINE);
  }

  const spent = spentLine(perf, offer ? str(offer.name) : null);
  if (spent) lines.push(spent);
  if (spent || campaigns.some((c) => str(c.spent) || str(c.invested))) lines.push(MONEY_BASES_LINE);
  const perfLines = performanceLines(perf);
  if (perfLines.length) lines.push("**Results so far** (served figures):", ...perfLines);
  const waiting = num(asObj(replies).total) ?? asArr(asObj(replies).leads).length;
  // This list holds every person who replied with interest, answered or not (SOPHIE-TRUTH-1105, prod
  // 2026-11-04: the brief said "nobody has answered yet" and Sophie told a client three times that
  // Edmund Bartlett was unanswered; we had answered him three times). Whether one still waits is
  // that person's own conversation: its latest message.
  if (replies !== null) {
    lines.push(
      `**Replied with interest**: ${waiting > 0 ? `${waiting} ${waiting === 1 ? "person" : "people"}, answered or not (this count does not say whether we answered after their reply: one is waiting on them only when the latest message of their own conversation is theirs)` : "nobody yet"}.`,
    );
  }
  if (billing !== null) lines.push(`**Money**: ${moneyLine(billing, outlook !== null && billingHoldKind(asObj(outlook)) !== null)}.`);
  if (failed.length) lines.push(`(Not read this turn: ${failed.join(", ")}. Use your tools if you need them.)`);
  return lines.join("\n");
}
