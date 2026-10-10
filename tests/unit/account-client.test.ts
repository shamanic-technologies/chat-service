import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.ADMIN_DISTRIBUTE_API_KEY = "test-api-svc-key";
  process.env.API_SERVICE_URL = "https://api.test.local";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function loadModule() {
  vi.resetModules();
  return import("../../src/lib/account-client.js");
}

const params = { orgId: "org-1", userId: "user-1", runId: "run-1" };

function okJson(body: unknown) {
  return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) };
}

function calledUrl(): string {
  return (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
}

describe("account-client — read-only, the dashboard's own queries", () => {
  it("list_offers reads the brand's offers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ offers: [] }));
    const { listOffers } = await loadModule();
    expect(await listOffers("b-1", params)).toEqual({ offers: [] });
    expect(calledUrl()).toBe("https://api.test.local/v1/brands/b-1/offers");
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" }),
      }),
    );
  });

  it("get_billing_account and get_org_usage read the org-level money", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ balance_cents: "1200" }));
    const { getBillingAccount, getOrgUsage } = await loadModule();
    await getBillingAccount(params);
    await getOrgUsage(params);
    const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(urls).toEqual(["https://api.test.local/v1/billing/accounts", "https://api.test.local/v1/features/orgs/usage"]);
  });

  it("get_spend_by_campaign asks runs-service per campaign since UTC midnight of the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T15:30:00Z"));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ groups: [] }));
    const { getSpendByCampaign } = await loadModule();
    await getSpendByCampaign({ brandId: "b-1", window: "last_7_days" }, params);
    expect(calledUrl()).toBe(
      "https://api.test.local/v1/runs/stats/costs?brandId=b-1&groupBy=campaignId&startedAfter=2026-10-03T00%3A00%3A00.000Z",
    );
  });

  it("get_offer_performance reads the offer revenue at net pricing, window optional", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ spend: 1 }));
    const { getOfferPerformance } = await loadModule();
    await getOfferPerformance({ brandId: "b-1", offerId: "o-1" }, params);
    await getOfferPerformance({ brandId: "b-1", offerId: "o-1", windowDays: 7 }, params);
    const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      "https://api.test.local/v1/offers/o-1/revenue?brandId=b-1&pricing=net",
      "https://api.test.local/v1/offers/o-1/revenue?brandId=b-1&pricing=net&windowDays=7",
    ]);
  });

  it("list_replies_to_handle reads the dashboard's 'needs your call' set", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ leads: [], total: 3 }));
    const { listRepliesToHandle } = await loadModule();
    expect(await listRepliesToHandle({ brandId: "b-1", offerId: "o-1" }, params)).toEqual({ leads: [], total: 3 });
    expect(calledUrl()).toBe(
      "https://api.test.local/v1/leads?brandId=b-1&offerId=o-1&view=basic&bucket=positive_reply&standing=sales_interest&sort=activity&limit=5",
    );
  });

  it("list_recent_runs reads the brand's run ledger, newest first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T15:30:00Z"));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson({ runs: [] }));
    const { listRecentRuns } = await loadModule();
    await listRecentRuns({ brandId: "b-1", window: "today", limit: 10 }, params);
    expect(calledUrl()).toBe(
      "https://api.test.local/v1/runs?brandId=b-1&limit=10&startedAfter=2026-10-09T00%3A00%3A00.000Z",
    );
  });

  it("fails loud on an upstream error, with the status and body", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("forbidden") });
    const { getBillingAccount } = await loadModule();
    await expect(getBillingAccount(params)).rejects.toThrow(/get_billing_account failed \(403\): forbidden/);
  });

  it("refuses a missing id, a bad window or an out-of-range limit before any call", async () => {
    const m = await loadModule();
    expect(() => m.listOffers("", params)).toThrow(/brandId is required/);
    expect(() => m.getSpendByCampaign({ brandId: "b", window: "forever" }, params)).toThrow(/unknown window/);
    expect(() => m.listRepliesToHandle({ brandId: "b", offerId: "o", limit: 500 }, params)).toThrow(/limit/);
    expect(() => m.getOfferPerformance({ brandId: "b", offerId: "o", windowDays: 0 }, params)).toThrow(/windowDays/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("get_offer_performance stays small (owner rule: no tool result above ~2k tokens)", () => {
  it("keeps the summary fields, drops the per-company list and day series, never opens", async () => {
    const { compactOfferPerformance, OFFER_PERFORMANCE_FIELDS } = await import("../../src/lib/account-client.js");
    const big = {
      offerId: "o", brandId: "b", costBasis: "charged", headline: { spentUsd: 71.2 }, costEconomics: { a: 1 },
      recipientsContacted: { count: 204 }, recipientsOpened: { count: 99 }, recipientsClicked: { count: 3 }, recipientsRepliesPositive: { count: 0 },
      meetingsBooked: { count: 0 }, purchased: { count: 0 }, signups: { count: 0 }, formSubmissions: { count: 0 }, outcomes: { x: 1 }, maturity: { m: 1 },
      organizations: Array.from({ length: 198 }, (_, i) => ({ id: i, name: "x".repeat(400) })),
      timeSeries: Array.from({ length: 181 }, (_, i) => ({ day: i, v: 1 })),
    };
    const out = compactOfferPerformance(big) as Record<string, unknown>;
    for (const k of OFFER_PERFORMANCE_FIELDS) expect(out).toHaveProperty(k);
    expect(out).not.toHaveProperty("organizations");
    expect(out).not.toHaveProperty("timeSeries");
    expect(out).not.toHaveProperty("recipientsOpened");
    expect(JSON.stringify(out).length).toBeLessThan(8000);
  });
});
