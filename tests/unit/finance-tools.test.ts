import { describe, it, expect } from "vitest";
import { readCompanyFinancials, type FeaturesFetch } from "../../src/agent/finance-tools.js";

const row = (orgId: string, name: string, revenue: number, cost: number) => ({
  orgId, orgName: name, customerStatus: "current", agency: false,
  revenueUsd: { net: revenue, beforeDiscount: revenue }, costUsd: { total: cost, vendorOnChargedSpend: cost, vendorOnRefundedSpend: 0, cardFees: 0, vendorCostUnknownOnUsd: 0 },
  marginUsd: { net: revenue - cost, beforeDiscount: revenue - cost }, marginPct: { net: revenue > 0 ? (revenue - cost) / revenue : null, beforeDiscount: null },
  marginUnavailableReason: null, cashPaidUsd: revenue, creditGivenUsd: 0, balanceUsd: 0, cardFeesOtherCurrencies: [],
});
const served = { since: "inception", basis: "net first", totals: { clients: 3, revenueUsd: { net: 150, beforeDiscount: 160 }, marginUsd: { net: 40, beforeDiscount: 50 } }, clients: [row("a", "Acme", 100, 50), row("b", "Beta", 0, 30), row("c", "Cy", 50, 0)] };
const fetchServed: FeaturesFetch = async (path) => {
  expect(path).toBe("/internal/stats/client-financials");
  return new Response(JSON.stringify(served));
};

describe("read_company_financials serves features-service's figures, never computes them (DISTRY-PRINCIPAL-1119)", () => {
  it("totals cover every client; rows come sorted by revenue, with the basis", async () => {
    const out = await readCompanyFinancials({}, fetchServed);
    expect(out.totals).toEqual(served.totals);
    expect(out).toMatchObject({ since: "inception", basis: "net first", clientsInTotals: 3 });
    expect((out.clients as Array<{ client: string }>).map((c) => c.client)).toEqual(["Acme", "Cy", "Beta"]);
  });

  it("sorted by margin, a client with no revenue shows its cost and a negative margin first", async () => {
    const out = await readCompanyFinancials({ sortBy: "margin", limit: 1 }, fetchServed);
    expect(out.clients).toEqual([expect.objectContaining({ client: "Beta", marginUsd: { net: -30, beforeDiscount: -30 }, costUsd: expect.objectContaining({ total: 30 }) })]);
    expect(out.clientsShown).toBe(1);
  });

  it("one client by its org id", async () => {
    expect(await readCompanyFinancials({ orgId: "c" }, fetchServed)).toMatchObject({ client: { client: "Cy" } });
  });

  it("fails loud when features-service does not answer the figures", async () => {
    await expect(readCompanyFinancials({}, async () => new Response("x", { status: 502 }))).rejects.toThrow(/502/);
    await expect(readCompanyFinancials({}, async () => new Response("{}"))).rejects.toThrow(/no clients or totals/);
  });
});
