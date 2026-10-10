import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
  process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
  process.env.BILLING_SERVICE_URL = "http://billing.test";
  process.env.BILLING_SERVICE_API_KEY = "billing-key";
  process.env.ADMIN_DISTRIBUTE_API_KEY = "admin-key";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

const p = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const FUNNEL = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";
const ENC = "lead_found_to_conversation%40sales-cold-email-outreach%2Bconversation_to_paid_client";
const fetchMock = () => fetch as ReturnType<typeof vi.fn>;
const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
const call = (i: number) => {
  const [url, init] = fetchMock().mock.calls[i] as [string, RequestInit];
  return { url, method: init.method, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : null };
};

async function funnel() {
  vi.resetModules();
  return import("../../src/lib/funnel-campaign-client.js");
}
async function copilot() {
  vi.resetModules();
  return import("../../src/lib/copilot-client.js");
}

describe("funnel campaign tools (campaign-service / billing-service, direct, chat identity)", () => {
  it("list → GET /sales-funnel-campaigns with filters and the chat's identity", async () => {
    fetchMock().mockResolvedValue(res(200, { salesFunnelCampaigns: [] }));
    const { FUNNEL_CAMPAIGN_TOOLS } = await funnel();
    await FUNNEL_CAMPAIGN_TOOLS.list_funnel_campaigns({ brandId: "b", status: "ongoing" }, p);
    expect(call(0)).toMatchObject({ url: "http://campaign.test/sales-funnel-campaigns?brandId=b&status=ongoing", method: "GET" });
    expect(call(0).headers).toMatchObject({ "x-api-key": "campaign-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" });
  });

  it("caps read/write hit billing with the funnel id URL-encoded", async () => {
    fetchMock().mockResolvedValue(res(200, {}));
    const { FUNNEL_CAMPAIGN_TOOLS } = await funnel();
    await FUNNEL_CAMPAIGN_TOOLS.get_funnel_caps({ brandId: "b", offerId: "o", salesFunnelId: FUNNEL }, p);
    expect(call(0).url).toBe(`http://billing.test/v1/brands/b/offers/o/sales-funnels/${ENC}/caps`);
    expect(call(0).headers["x-api-key"]).toBe("billing-key");
    await FUNNEL_CAMPAIGN_TOOLS.set_funnel_caps(
      { brandId: "b", offerId: "o", salesFunnelId: FUNNEL, maxBudget: { amountCents: 5000, period: "weekly" }, maxVolume: { count: 200, period: "monthly" } },
      p,
    );
    expect(call(1)).toMatchObject({ method: "PUT", body: { maxBudget: { amountCents: 5000, period: "weekly" }, maxVolume: { count: 200, period: "monthly" } } });
  });

  it("set_funnel_caps refuses a missing max budget, an unasked volume, a bad period", async () => {
    const { FUNNEL_CAMPAIGN_TOOLS } = await funnel();
    const t = { brandId: "b", offerId: "o", salesFunnelId: FUNNEL };
    await expect(FUNNEL_CAMPAIGN_TOOLS.set_funnel_caps({ ...t, maxBudget: null, maxVolume: null }, p)).rejects.toThrow(/held unfunded/);
    await expect(FUNNEL_CAMPAIGN_TOOLS.set_funnel_caps({ ...t, maxBudget: { amountCents: 100, period: "daily" } }, p)).rejects.toThrow(/maxVolume is required/);
    await expect(FUNNEL_CAMPAIGN_TOOLS.set_funnel_caps({ ...t, maxBudget: { amountCents: 100, period: "yearly" }, maxVolume: null }, p)).rejects.toThrow(/period/);
    expect(fetchMock()).not.toHaveBeenCalled();
    fetchMock().mockResolvedValue(res(200, {}));
    await FUNNEL_CAMPAIGN_TOOLS.set_funnel_caps({ ...t, maxBudget: { amountCents: 100, period: "one_off" }, maxVolume: null }, p);
    expect(call(0).body).toEqual({ maxBudget: { amountCents: 100, period: "one_off" }, maxVolume: null });
  });

  it("create_funnel_campaign is ALWAYS stopped, whatever the model sends", async () => {
    fetchMock().mockResolvedValue(res(201, { created: true, started: false }));
    const { FUNNEL_CAMPAIGN_TOOLS } = await funnel();
    await FUNNEL_CAMPAIGN_TOOLS.create_funnel_campaign({ brandId: "b", offerId: "o", salesFunnelId: FUNNEL, status: "ongoing" }, p);
    expect(call(0)).toMatchObject({ url: "http://campaign.test/sales-funnel-campaigns", method: "POST", body: { brandId: "b", offerId: "o", salesFunnelId: FUNNEL, status: "stopped" } });
  });

  it("stop → PATCH {status: stop}", async () => {
    fetchMock().mockResolvedValue(res(200, {}));
    const { FUNNEL_CAMPAIGN_TOOLS } = await funnel();
    await FUNNEL_CAMPAIGN_TOOLS.stop_funnel_campaign({ salesFunnelCampaignId: "fc-1" }, p);
    expect(call(0)).toMatchObject({ url: "http://campaign.test/sales-funnel-campaigns/fc-1", method: "PATCH", body: { status: "stop" } });
  });

  it("a refusal carries the owner's reason", async () => {
    fetchMock().mockResolvedValue(res(400, { error: "That funnel has a step we cannot run.", reason: "pipe_not_runnable" }));
    const { FUNNEL_CAMPAIGN_TOOLS } = await funnel();
    await expect(FUNNEL_CAMPAIGN_TOOLS.create_funnel_campaign({ brandId: "b", offerId: "o", salesFunnelId: FUNNEL }, p)).rejects.toThrow(/pipe_not_runnable/);
  });
});

describe("start_funnel_campaign goes through the switch-on gate", () => {
  it("propose is refused while the funnel has no max budget, and starts nothing", async () => {
    fetchMock().mockResolvedValue(res(200, { maxBudget: null, maxVolume: null }));
    const { proposeSwitchOn } = await copilot();
    await expect(
      proposeSwitchOn({ action: "start_funnel_campaign", summary: "s", brandId: "b", offerId: "o", salesFunnelId: FUNNEL }, p),
    ).rejects.toThrow(/no max budget/);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(call(0).method).toBe("GET");
  });

  it("propose with a stated max budget records the caps and a token, starts nothing", async () => {
    fetchMock().mockResolvedValue(res(200, { maxBudget: { amountCents: 5000, period: "weekly" }, maxVolume: { count: 100, period: "monthly" } }));
    const { proposeSwitchOn } = await copilot();
    const out = await proposeSwitchOn({ action: "start_funnel_campaign", summary: "Run Zenith", brandId: "b", offerId: "o", salesFunnelId: FUNNEL }, p);
    expect(out.status).toBe("awaiting_user_confirmation");
    expect(out.target).toEqual({ brandId: "b", offerId: "o", salesFunnelId: FUNNEL });
    expect(out.caps).toEqual({ maxBudget: { amountCents: 5000, period: "weekly" }, maxVolume: { count: 100, period: "monthly" } });
    expect(fetchMock().mock.calls.every((c) => (c[1] as RequestInit).method === "GET")).toBe(true);
  });

  it("confirm POSTs status ongoing for the recorded funnel", async () => {
    fetchMock().mockResolvedValue(res(200, { created: false, started: true }));
    const { executeSwitchOn } = await copilot();
    const out = (await executeSwitchOn(
      {
        confirmationToken: "t",
        action: "start_funnel_campaign",
        target: { brandId: "b", offerId: "o", salesFunnelId: FUNNEL },
        summary: "s",
        status: "awaiting_user_confirmation",
        instruction: "",
      },
      p,
    )) as { switchedOn: boolean };
    expect(call(0)).toMatchObject({ url: "http://campaign.test/sales-funnel-campaigns", method: "POST", body: { status: "ongoing", salesFunnelId: FUNNEL } });
    expect(out.switchedOn).toBe(true);
  });
});
