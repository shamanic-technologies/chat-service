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
    expect(brief).toContain("postpaid: work is billed as it runs, balance $4.89, no card on file");
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
    expect(brief).toContain("postpaid: work is billed as it runs; they owe $0.06 now, charged to their card each time it reaches $50.00 and at month end");
    expect(brief).toContain("$100.00 of credit comes once they have paid $100.00");
  });

  it("says how a prepaid account pays (Martian DBB 2026-11-01)", async () => {
    const brief = await buildSituationBrief(
      reader({ getBillingAccount: async () => ({ payment_mode: "prepaid", balance_cents: "-174.75", usage_cents: "1174.75", has_payment_method: false, has_auto_topup: false }) }),
    );
    expect(brief).toContain("prepaid: work is paid from a balance they add money to, balance -$1.75, used $11.75, no card on file");
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
