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
});

async function load() {
  vi.resetModules();
  return import("../../src/lib/copilot-client.js");
}

const params = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const fetchMock = () => fetch as ReturnType<typeof vi.fn>;
const ok = (body: unknown) => ({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
const call = (i: number) => ({
  url: fetchMock().mock.calls[i][0] as string,
  method: (fetchMock().mock.calls[i][1] as RequestInit).method,
  body: JSON.parse(((fetchMock().mock.calls[i][1] as RequestInit).body as string) ?? "null"),
});

describe("copilot entity reads hit the owner routes", () => {
  it.each([
    ["getOfferChannels", "/v1/brands/b-1/offers/o-1/channels"],
    ["getOfferLegs", "/v1/brands/b-1/offers/o-1/sales-path"],
    ["listSalesPaths", "/v1/offers/o-1/sales-paths?brandId=b-1"],
    ["getSelectedSalesPaths", "/v1/brands/b-1/offers/o-1/selected-sales-paths"],
    ["getTriggerEvents", "/v1/offers/o-1/trigger-events/summary?brandId=b-1"],
    ["getOfferSourcing", "/v1/offers/o-1/sourcing?brandId=b-1"],
    ["getCampaignBudgets", "/v1/brands/b-1/offers/o-1/campaign-budgets"],
  ])("%s → GET %s", async (fn, path) => {
    fetchMock().mockResolvedValue(ok({ ok: 1 }));
    const mod = (await load()) as unknown as Record<string, (a: unknown, p: unknown) => Promise<unknown>>;
    expect(await mod[fn]({ brandId: "b-1", offerId: "o-1" }, params)).toEqual({ ok: 1 });
    expect(call(0)).toEqual({ url: `https://api.test.local${path}`, method: "GET", body: null });
  });

  it("list_connected_accounts keeps one failing provider visible without hiding the others", async () => {
    fetchMock().mockImplementation(async (url: string) =>
      url.includes("/stripe/") ? { ok: false, status: 502, text: () => Promise.resolve("down") } : ok({ items: [] }),
    );
    const { listConnectedAccounts } = await load();
    const r = (await listConnectedAccounts({}, params)) as Record<string, unknown>;
    expect(r.google_mailboxes).toEqual({ items: [] });
    expect(String((r.stripe as { error: string }).error)).toMatch(/502/);
  });

  it("fails loud on an owner error", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve("no offer") });
    const { getOfferChannels } = await load();
    await expect(getOfferChannels({ brandId: "b-1", offerId: "o-1" }, params)).rejects.toThrow(/404/);
  });
});

describe("switch-on gate: propose in one turn, confirm in a later one", () => {
  it("start_campaign needs a budget cap, sets it, and starts nothing", async () => {
    fetchMock().mockResolvedValue(ok({ saved: true }));
    const { proposeSwitchOn } = await load();
    await expect(
      proposeSwitchOn({ action: "start_campaign", summary: "s", brandId: "b", offerId: "o", legKey: "l", featureSlug: "f" }, params),
    ).rejects.toThrow(/budget cap is mandatory/);
    expect(fetchMock()).not.toHaveBeenCalled();

    const p = await proposeSwitchOn(
      { action: "start_campaign", summary: "Start", brandId: "b", offerId: "o", legKey: "l", featureSlug: "f", dailyBudgetCents: 2000 },
      params,
    );
    expect(p.status).toBe("awaiting_user_confirmation");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(call(0)).toEqual({
      url: "https://api.test.local/v1/brands/b/campaign-budget",
      method: "PUT",
      body: { offerId: "o", legKey: "l", featureSlug: "f", dailyBudgetCents: 2000 },
    });
  });

  it("refuses a token absent from the prior history (e.g. proposed this turn)", async () => {
    const { resolveSwitchOnProposal } = await load();
    expect(() => resolveSwitchOnProposal("tok", [])).toThrow(/Unknown confirmation token/);
  });

  it("accepts a token proposed in an earlier turn, refuses it once used", async () => {
    const { resolveSwitchOnProposal } = await load();
    const proposal = {
      confirmationToken: "tok",
      action: "activate_campaign",
      target: { campaignId: "c-1" },
      summary: "s",
      status: "awaiting_user_confirmation",
      instruction: "",
    };
    const history = [
      { role: "user", toolCalls: null },
      { role: "assistant", toolCalls: [{ name: "propose_switch_on", args: {}, result: proposal }] },
    ];
    expect(resolveSwitchOnProposal("tok", history).target).toEqual({ campaignId: "c-1" });

    const used = [
      ...history,
      { role: "user", toolCalls: null },
      { role: "assistant", toolCalls: [{ name: "confirm_switch_on", args: { confirmationToken: "tok" }, result: { switchedOn: true } }] },
    ];
    expect(() => resolveSwitchOnProposal("tok", used)).toThrow(/already used/);
  });

  it("executes each action through its owner route", async () => {
    fetchMock().mockResolvedValue(ok({ campaign: { id: "c" } }));
    const { executeSwitchOn } = await load();
    const base = { confirmationToken: "t", summary: "", status: "awaiting_user_confirmation" as const, instruction: "" };
    await executeSwitchOn({ ...base, action: "start_campaign", target: { brandId: "b", offerId: "o", legKey: "l", featureSlug: "f", dailyBudgetCents: 1 } }, params);
    await executeSwitchOn({ ...base, action: "activate_campaign", target: { campaignId: "c-1" } }, params);
    await executeSwitchOn({ ...base, action: "switch_on_reactive_legs", target: { brandId: "b", offerId: "o" } }, params);
    expect(call(0)).toEqual({
      url: "https://api.test.local/v1/campaigns/start-funded-pair",
      method: "POST",
      body: { brandId: "b", offerId: "o", legKey: "l", featureSlug: "f" },
    });
    expect(call(1)).toEqual({ url: "https://api.test.local/v1/campaigns/c-1", method: "PATCH", body: { status: "activate" } });
    expect(call(2)).toEqual({ url: "https://api.test.local/v1/offers/o/reactive-defaults", method: "POST", body: { brandId: "b" } });
  });
});
