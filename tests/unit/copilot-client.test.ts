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
    ["listSalesPaths", "/v1/offers/o-1/sales-paths?brandId=b-1"],
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
    const { getOfferSourcing } = await load();
    await expect(getOfferSourcing({ brandId: "b-1", offerId: "o-1" }, params)).rejects.toThrow(/404/);
  });
});

describe("switch-on gate: propose in one turn, confirm in a later one", () => {
  it("per-step starts are retired: only start_funnel_campaign is proposed (owner 2026-10-10)", async () => {
    const { proposeSwitchOn, SWITCH_ON_ACTIONS } = await load();
    expect(SWITCH_ON_ACTIONS).toEqual(["start_funnel_campaign"]);
    for (const action of ["start_campaign", "activate_campaign"]) {
      await expect(proposeSwitchOn({ action, summary: "s", brandId: "b", offerId: "o", legKey: "l", featureSlug: "f", dailyBudgetCents: 2000, campaignId: "c" }, params)).rejects.toThrow(/action must be one of/);
    }
    expect(fetchMock()).not.toHaveBeenCalled();
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

  it("a per-step start recorded before its retirement is refused at confirm, nothing called", async () => {
    const { executeSwitchOn } = await load();
    const base = { confirmationToken: "t", summary: "", status: "awaiting_user_confirmation" as const, instruction: "" };
    for (const action of ["start_campaign", "activate_campaign"]) {
      const old = { ...base, action, target: { campaignId: "c-1" } } as unknown as Parameters<typeof executeSwitchOn>[0];
      await expect(executeSwitchOn(old, params)).rejects.toThrow(/retired/);
    }
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("refuses a retired action recorded before its retirement, and calls nothing (2026-10-10)", async () => {
    const { executeSwitchOn, proposeSwitchOn } = await load();
    const base = { confirmationToken: "t", summary: "", status: "awaiting_user_confirmation" as const, instruction: "" };
    const retired = { ...base, action: "switch_on_reactive_legs", target: { brandId: "b", offerId: "o" } } as unknown as Parameters<typeof executeSwitchOn>[0];
    await expect(executeSwitchOn(retired, params)).rejects.toThrow(/retired/);
    await expect(proposeSwitchOn({ action: "switch_on_reactive_legs", summary: "s", brandId: "b", offerId: "o" }, params)).rejects.toThrow(/action must be one of/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});
