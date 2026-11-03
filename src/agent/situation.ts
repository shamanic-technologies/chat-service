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

function campaignLine(c: Obj): string {
  const bits = [
    str(c.name) ? `"${str(c.name)}"` : "a campaign",
    statusWords(c),
    str(c.path) ? `does: ${str(c.path)}` : null,
    str(c.runsWhen) ? `runs: ${str(c.runsWhen)}` : null,
    str(c.budget) ? `budget: ${str(c.budget)}` : null,
    str(c.spent),
    str(c.invested),
    str(c.return) ? `return: ${str(c.return)}` : null,
  ].filter(Boolean);
  return `- ${bits.join("; ")}`;
}

/** The dashboard's "Spent" tile: billed since they started, net of their discount, served by features-service. */
function spentLine(perf: unknown): string | null {
  const spent = asObj(asObj(perf).spent);
  const actual = num(spent.actualSpentCents);
  if (actual === null) return null;
  const total = num(spent.totalSpentCents);
  return `**Spent** (their dashboard's figure, since they started): ${dollars(actual)}${total !== null && total > actual ? ` (${dollars(total)} with follow-ups reserved)` : ""}.`;
}

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
    lines.push(...campaigns.slice(0, 8).map(campaignLine));
  }

  const spent = spentLine(perf);
  if (spent) lines.push(spent);
  const perfLines = performanceLines(perf);
  if (perfLines.length) lines.push("**Results so far** (served figures):", ...perfLines);
  const waiting = num(asObj(replies).total) ?? asArr(asObj(replies).leads).length;
  if (replies !== null) lines.push(`**Waiting on them**: ${waiting > 0 ? `${waiting} interested repl${waiting === 1 ? "y" : "ies"} nobody has answered yet` : "no reply waiting"}.`);
  if (billing !== null) lines.push(`**Money**: ${moneyLine(billing, outlook !== null && billingHoldKind(asObj(outlook)) !== null)}.`);
  if (failed.length) lines.push(`(Not read this turn: ${failed.join(", ")}. Use your tools if you need them.)`);
  return lines.join("\n");
}
