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
// ---------------------------------------------------------------------------

export interface SituationReader {
  listBrands(): Promise<unknown>;
  listOffers(brandId: string): Promise<unknown>;
  getOfferSettings(brandId: string, offerId: string): Promise<unknown>;
  listCampaigns(brandId: string): Promise<unknown>;
  getOfferPerformance(brandId: string, offerId: string): Promise<unknown>;
  listRepliesToHandle(brandId: string, offerId: string): Promise<unknown>;
  getBillingAccount(): Promise<unknown>;
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

function campaignLine(c: Obj): string {
  const bits = [
    str(c.name) ? `"${str(c.name)}"` : "a campaign",
    str(c.status),
    str(c.path) ? `does: ${str(c.path)}` : null,
    str(c.runsWhen) ? `runs: ${str(c.runsWhen)}` : null,
    str(c.budget) ? `budget: ${str(c.budget)}` : null,
    str(c.spent),
    str(c.invested),
    str(c.return) ? `return: ${str(c.return)}` : null,
  ].filter(Boolean);
  return `- ${bits.join("; ")}`;
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
function paymentWords(b: Obj): string | null {
  const mode = str(b.payment_mode);
  if (mode === "postpaid") {
    const owed = num(b.amount_owed_cents);
    const step = dollars(b.credit_line_step_cents);
    return `postpaid: work is billed as it runs${owed !== null ? `; they owe ${dollars(owed)} now${step ? `, charged to their card each time it reaches ${step} and at month end` : ", charged at month end"}` : ""}`;
  }
  if (mode === "prepaid") return `prepaid: work is paid from a balance they add money to${b.has_auto_topup === true ? ", topped up automatically from their card" : ""}`;
  return mode ? `payment: ${mode}` : null;
}

function moneyLine(billing: unknown): string {
  const b = asObj(billing);
  const pending = num(b.free_credit_pending_cents);
  const toPay = num(b.free_credit_remaining_to_pay_cents);
  const parts = [
    paymentWords(b),
    dollars(b.balance_cents) ? `balance ${dollars(b.balance_cents)}` : null,
    dollars(b.usage_cents) ? `used ${dollars(b.usage_cents)}` : null,
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

  const [offersBody, campaignsBody, billing] = await Promise.all([
    settle("offers", () => reader.listOffers(brandId), failed),
    settle("campaigns", () => reader.listCampaigns(brandId), failed),
    settle("billing", () => reader.getBillingAccount(), failed),
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

  const campaigns = asArr(asObj(campaignsBody).campaigns);
  if (campaignsBody !== null) {
    lines.push(campaigns.length ? `**Campaigns** (${campaigns.length}):` : "**Campaigns**: none yet, so nobody is being reached.");
    lines.push(...campaigns.slice(0, 8).map(campaignLine));
  }

  const perfLines = performanceLines(perf);
  if (perfLines.length) lines.push("**Results so far** (served figures):", ...perfLines);
  const waiting = num(asObj(replies).total) ?? asArr(asObj(replies).leads).length;
  if (replies !== null) lines.push(`**Waiting on them**: ${waiting > 0 ? `${waiting} interested repl${waiting === 1 ? "y" : "ies"} nobody has answered yet` : "no reply waiting"}.`);
  if (billing !== null) lines.push(`**Money**: ${moneyLine(billing)}.`);
  if (failed.length) lines.push(`(Not read this turn: ${failed.join(", ")}. Use your tools if you need them.)`);
  return lines.join("\n");
}
