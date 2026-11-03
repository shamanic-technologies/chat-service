import { describe, expect, it, vi } from "vitest";
import { buildSituationBrief, type SituationReader } from "../../src/agent/situation.js";
import { SOPHIE_CONFIG_KEY, SOPHIE_MODEL, SOPHIE_SYSTEM_PROMPT, SOPHIE_TOOLS } from "../../src/agent/sophie.js";
import { SOPHIE_CONFIG, isSelfSeededConfigKey, seedSophieConfig } from "../../src/lib/seed-platform-configs.js";

function reader(over: Partial<SituationReader> = {}): SituationReader {
  return {
    listBrands: async () => ({ brands: [{ id: "b1", name: "Kestrel", domain: "kestrel.example", brandUrl: "https://kestrel.example" }] }),
    listOffers: async () => ({ offers: [{ offerId: "o1", name: "Default Offer", status: "active", description: null }] }),
    getOfferSettings: async () => ({ lifetimeRevenueUsd: 4000, bookingUrl: null }),
    listCampaigns: async () => ({ campaigns: [] }),
    getOfferPerformance: async () => ({ recipientsContacted: 0 }),
    listRepliesToHandle: async () => ({ total: 0, leads: [] }),
    getBillingAccount: async () => ({ payment_mode: "postpaid", balance_cents: "489", has_payment_method: false }),
    getPaymentOutlook: async () => ({ state: "no_autopay", blockedReason: null, paymentMode: "postpaid" }),
    ...over,
  };
}

describe("buildSituationBrief", () => {
  it("says a stated client value is a value, not a client they have (Jcurve 2026-11-01)", async () => {
    const brief = await buildSituationBrief(reader());
    expect(brief).toContain("one paying client is worth $4000 to them (a value they stated, not a client they have)");
  });

  it("says no campaign means nobody is reached, and gives money in dollars", async () => {
    const brief = await buildSituationBrief(reader());
    expect(brief).toContain("**Campaigns**: none yet, so nobody is being reached.");
    expect(brief).toContain("postpaid: work is billed as it runs, no card on file");
  });

  it("states today's date so a reply never guesses the day (Sunday send 2026-11-01)", async () => {
    const brief = await buildSituationBrief(reader(), { now: new Date("2026-11-01T12:00:00Z") });
    expect(brief).toContain("Today: Sunday 1 November 2026 (UTC).");
  });

  it("says how a postpaid account pays: what it owes and when the card is charged (Jarygo 2026-10-21)", async () => {
    const brief = await buildSituationBrief(
      reader({
        getBillingAccount: async () => ({
          payment_mode: "postpaid", balance_cents: "-6.44", usage_cents: "6.44", amount_owed_cents: "6.44",
          credit_line_step_cents: 5000, has_payment_method: true, card_last4: "2096",
          free_credit_pending_cents: "10000", free_credit_remaining_to_pay_cents: "10000",
        }),
      }),
    );
    expect(brief).toContain("postpaid: work is billed as it runs; balance due $0.07, charged to their card each time it reaches $50.00 and at month end");
    expect(brief).toContain("$100.00 of credit comes once they have paid $100.00");
  });

  it("says how a prepaid account pays (Martian DBB 2026-11-01)", async () => {
    const brief = await buildSituationBrief(
      reader({ getBillingAccount: async () => ({ payment_mode: "prepaid", balance_cents: "-174.75", usage_cents: "1174.75", has_payment_method: false, has_auto_topup: false }) }),
    );
    expect(brief).toContain("prepaid: work is paid from a balance they add money to, balance -$1.75, no card on file");
    expect(brief).toContain('Billing page: "Your credit has run out. Add credit to keep your campaigns running."');
  });

  it("names a read that failed instead of reporting it as empty", async () => {
    const brief = await buildSituationBrief(reader({ listOffers: async () => { throw new Error("502"); } }));
    expect(brief).not.toContain("**Offer**: none yet.");
    expect(brief).toContain("(Not read this turn: offers.");
  });

  it("an account with nothing set up says so", async () => {
    const brief = await buildSituationBrief(reader({ listBrands: async () => ({ brands: [] }) }));
    expect(brief).toContain("Nothing set up yet: no brand, no campaign.");
  });

  it("leaves what the business sells to the client brief (no second read of the website)", async () => {
    const brief = await buildSituationBrief(reader());
    expect(brief).toContain("## Where their account stands");
    expect(brief).not.toMatch(/website|What they sell/);
  });

  it("narrows to the brand and offer the person has open", async () => {
    const brief = await buildSituationBrief(
      reader({
        listBrands: async () => ({ brands: [{ id: "b1", name: "One" }, { id: "b2", name: "Two" }] }),
        listOffers: async () => ({ offers: [{ offerId: "o1", name: "First", status: "active" }, { offerId: "o2", name: "Second", status: "active" }] }),
      }),
      { brandId: "b2", offerId: "o2" },
    );
    expect(brief).toContain('For brand "Two"');
    expect(brief).toContain('**Offer**: "Second"');
  });
});

describe("the brief states the account as the dashboard shows it (SOPHIE-BRIEF-EQUALS-DASHBOARD-1103)", () => {
  // Prod 2026-11-03 15:57 UTC, postpaid org: 4 declined charges, campaigns stopped by the payment hold,
  // dashboard "Campaigns paused: payment declined" and Spent $103 (net). Sophie said "nothing is blocking your account".
  const held = reader({
    listCampaigns: async () => ({ campaigns: [{ name: "Cold outreach", status: "stopped", stopReason: "payment_declined", invested: "$103.12 invested since start" }] }),
    getOfferPerformance: async () => ({ recipientsContacted: 828, spent: { actualSpentCents: 10312, totalSpentCents: 11020 } }),
    getBillingAccount: async () => ({
      payment_mode: "postpaid", balance_cents: "-13824.63", usage_cents: "17837.63", amount_owed_cents: "5867.53",
      credit_line_step_cents: 5000, has_payment_method: true,
    }),
    getPaymentOutlook: async () => ({ state: "charge_blocked", blockedReason: "card_declined", nextChargeAttemptAt: "2026-11-04T15:27:00.786Z" }),
  });

  it("carries the payment band in the dashboard's words, and billing's next try", async () => {
    const brief = await buildSituationBrief(held);
    expect(brief).toContain('Banner on every page: "Campaigns paused: payment declined". "Your card was declined, so we paused your campaigns.');
    expect(brief).toContain("billing holds the account now: the bank declined their card");
    expect(brief).toContain("Billing tries their card again Wednesday 4 November, 15:27 UTC.");
  });

  it("names a stopped campaign's reason as the campaigns table does", async () => {
    const brief = await buildSituationBrief(held);
    expect(brief).toContain('- "Cold outreach"; Paused: payment declined');
  });

  it("states the dashboard's Spent (net), never the gross usage, and no automatic charge while held", async () => {
    const brief = await buildSituationBrief(held);
    expect(brief).toContain("**Spent** (their dashboard's figure, since they started): $103.12 ($110.20 with follow-ups reserved).");
    expect(brief).not.toContain("178.38");
    expect(brief).toContain("balance due $58.68");
    expect(brief).not.toContain("at month end");
  });

  it("a hold with nothing stopped over payment still says no campaign can start", async () => {
    const brief = await buildSituationBrief(
      reader({
        listCampaigns: async () => ({ campaigns: [{ name: "A", status: "stopped", stopReason: "manual" }] }),
        getPaymentOutlook: async () => ({ state: "charge_blocked", blockedReason: "no_chargeable_card" }),
      }),
    );
    expect(brief).not.toContain("Banner on every page");
    expect(brief).toContain("Billing holds the account now (no card can be charged): no campaign can start until it clears. Add a card, then start them again.");
    expect(brief).toContain('- "A"; stopped by them');
  });

  it("an old payment stop with no hold now says it can be started again", async () => {
    const brief = await buildSituationBrief(
      reader({ listCampaigns: async () => ({ campaigns: [{ name: "A", status: "stopped", stopReason: "no_payment_method" }] }) }),
    );
    expect(brief).toContain("billing no longer holds the account, so it can be started again");
    expect(brief).toContain('Billing page: "Add a card so your campaigns can run on credit."');
  });

  it("says when billing's verdict could not be read, never that nothing blocks them", async () => {
    const brief = await buildSituationBrief(reader({ getPaymentOutlook: async () => { throw new Error("502"); } }));
    expect(brief).toContain("- Whether billing holds the account (the payment band): not known this turn.");
    expect(brief).not.toContain("billing does not hold the account");
    expect(brief).toContain("(Not read this turn: payment hold.");
  });
});

describe("Sophie's definition is chat-service's", () => {
  it("the copilot config is seeded from code", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    await seedSophieConfig({ insert: vi.fn().mockReturnValue({ values }) } as never);
    expect(values.mock.calls[0][0]).toMatchObject({ key: SOPHIE_CONFIG_KEY, systemPrompt: SOPHIE_SYSTEM_PROMPT, supportKind: "copilot" });
    const seeded = SOPHIE_CONFIG;
    expect(seeded.systemPrompt).toBe(SOPHIE_SYSTEM_PROMPT);
    expect(seeded.allowedTools).toEqual(SOPHIE_TOOLS);
    expect(`${seeded.provider}/${seeded.model}`).toBe(`${SOPHIE_MODEL.provider}/${SOPHIE_MODEL.model}`);
    expect(isSelfSeededConfigKey(SOPHIE_CONFIG_KEY)).toBe(true);
  });

  it("the role states the strategy and carries no list of prohibitions", () => {
    expect(SOPHIE_SYSTEM_PROMPT).toContain("Revenue made easy.");
    expect(SOPHIE_SYSTEM_PROMPT).not.toMatch(/\bNever\b|## Never/);
  });
});
