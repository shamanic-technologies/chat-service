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

describe("list_campaigns: a small page, compact rows (owner rule: no result above ~2k tokens)", () => {
  const fullRow = (i: number) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6",
    createdByUserId: "cfe148ed-e3d8-40a2-8920-f8c040a81934",
    parentRunId: "a62f01be-6e29-4548-bcee-7f0b98b2b8c0",
    name: "Zenith 50600967 - sales-cold-email-outreach - f4d73dab-1f9d-49b2-b16e-63ecde76a5eb - lead_found_to_conversation - 832126f3-f3f1-4601",
    workflowSlug: "sales-cold-email-outreach-azha",
    brandIds: ["f4d73dab-1f9d-49b2-b16e-63ecde76a5eb"],
    brandId: "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb",
    featureSlug: "sales-cold-email-outreach",
    featureInputs: { long: "x".repeat(5000) },
    offerId: "832126f3-f3f1-4601-885d-bc8e101e5680",
    legKey: "lead_found_to_conversation",
    salesFunnelId: "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client",
    salesFunnelCampaignId: "50600967-975e-46f2-9fbd-e91c2a0067d2",
    status: "ongoing",
    stopReason: null,
    createdAt: "2026-10-10T10:47:27.584Z",
  });

  it("calls campaign-service with filters and a limit, and cuts each row", async () => {
    fetchMock().mockResolvedValue(res(200, { campaigns: [fullRow(1)], hasMore: true }));
    const { FUNNEL_CAMPAIGN_TOOLS } = await funnel();
    const out = (await FUNNEL_CAMPAIGN_TOOLS.list_campaigns({ brandId: "b", status: "ongoing" }, p)) as {
      campaigns: Record<string, unknown>[];
      hasMore: boolean;
      note?: string;
    };
    expect(call(0).url).toBe("http://campaign.test/campaigns?brandId=b&status=ongoing&limit=10");
    expect(Object.keys(out.campaigns[0]).sort()).toEqual(
      ["createdAt", "featureSlug", "id", "legKey", "name", "offerId", "salesFunnelCampaignId", "status", "stopReason"].sort(),
    );
    expect(out.hasMore).toBe(true);
    expect(out.note).toMatch(/Narrow/);
  });

  it("a full page of the largest real rows stays under ~2k tokens", async () => {
    fetchMock().mockResolvedValue(res(200, { campaigns: Array.from({ length: 15 }, (_, i) => fullRow(i)), hasMore: true }));
    const { FUNNEL_CAMPAIGN_TOOLS } = await funnel();
    const out = await FUNNEL_CAMPAIGN_TOOLS.list_campaigns({ brandId: "b", limit: 15 }, p);
    expect(JSON.stringify(out).length).toBeLessThan(8000);
  });

  it("refuses a status the column does not store and a page over 15, before any call", async () => {
    const { FUNNEL_CAMPAIGN_TOOLS } = await funnel();
    await expect(FUNNEL_CAMPAIGN_TOOLS.list_campaigns({ status: "active" }, p)).rejects.toThrow(/ongoing, stopped/);
    await expect(FUNNEL_CAMPAIGN_TOOLS.list_campaigns({ limit: 50 }, p)).rejects.toThrow(/1 to 15/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});
