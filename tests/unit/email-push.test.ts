import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// COPILOT-PUSH-EMAIL-1014 (prod 2026-10-14, Definite Jobs): the Copilot filed two
// feature requests for "send our own email as written" while the client's live
// campaign "Dulcet" did exactly that. The push goes through the existing trigger
// route, only after the user's yes (propose in one turn, confirm in a later one).

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
  process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
  process.env.BILLING_SERVICE_URL = "http://billing.test";
  process.env.BILLING_SERVICE_API_KEY = "billing-key";
  process.env.FEATURES_SERVICE_URL = "http://features.test";
  process.env.FEATURES_SERVICE_API_KEY = "features-key";
  process.env.ADMIN_DISTRIBUTE_API_KEY = "admin-key";
  process.env.API_SERVICE_URL = "https://api.test.local";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

const p = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const fetchMock = () => fetch as ReturnType<typeof vi.fn>;
const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
const urls = () => fetchMock().mock.calls.map((c) => String(c[0]));

const DULCET = "start_to_conversation@email-sending+conversation_to_meeting_booked@ai-meeting-booking";
const OTHER = "lead_found_to_conversation@sales-cold-email-outreach";

function account(opts: { dulcetStatus?: string; pipeCost?: number | null } = {}) {
  fetchMock().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("http://campaign.test/sales-funnel-campaigns")) {
      return res(200, {
        salesFunnelCampaigns: [
          { id: "sfc-dulcet", brandId: "b", offerId: "o", salesFunnelId: DULCET, salesFunnelName: "Dulcet", status: opts.dulcetStatus ?? "ongoing" },
          { id: "sfc-bliss", brandId: "b", offerId: "o", salesFunnelId: OTHER, salesFunnelName: "Bliss", status: "ongoing" },
        ],
      });
    }
    if (url.startsWith("http://features.test/internal/catalogue/sales-funnels/")) {
      const id = decodeURIComponent(url.split("/sales-funnels/")[1]);
      if (id === DULCET) {
        const cost = opts.pipeCost ?? null;
        return res(200, {
          id, name: "Dulcet", type: "reactive", line: "Email Sending → AI Meeting Booking",
          trigger: { slug: "email_pushed_via_api", name: "Email Pushed Via API" },
          legs: [{ pipe: { id: "email-sending|start_to_conversation", costUsd: cost, costPer: cost === null ? null : "per email sent", status: cost === null ? "learning" : "estimated" } }],
        });
      }
      return res(200, { id, name: "Bliss", type: "proactive", trigger: null, legs: [] });
    }
    if (url.startsWith("http://billing.test/")) {
      return res(200, { salesFunnelType: "reactive", volumeUnit: "prospects_handled", maxBudget: { amountCents: "500", period: "daily", consumedCents: "0" }, maxVolume: { count: 100, period: "monthly" } });
    }
    if (url === "https://api.test.local/v1/trigger-events" && init?.method === "POST") {
      return res(201, { event: { id: "ev-1", status: "done", outcome: "ran", skipReason: null, ranCampaignIds: ["c-1"] }, replayed: false });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function load() {
  vi.resetModules();
  return import("../../src/lib/copilot-client.js");
}

const ask = { action: "push_email", summary: "Send the test", brandId: "b", offerId: "o", email: "staff@distribute.you", subject: "Hiring in Leeds?", bodyText: "Hi Sam,\nI saw you are hiring..." };

describe("propose_switch_on push_email: a preview, nothing sent", () => {
  it("names the live campaign answering email_pushed_via_api, its caps, the cost and the sender rule", async () => {
    account();
    const { proposeSwitchOn } = await load();
    const r = (await proposeSwitchOn(ask, p)) as any;
    expect(r.status).toBe("awaiting_user_confirmation");
    expect(r.confirmationToken).toBeTruthy();
    expect(r.preview).toMatchObject({ to: "staff@distribute.you", subject: "Hiring in Leeds?", body: "Hi Sam,\nI saw you are hiring..." });
    expect(r.preview.sentBy).toEqual([{ campaignId: "sfc-dulcet", name: "Dulcet", does: "Email Sending → AI Meeting Booking", budget: "Up to $5/day", volume: "Up to 100 prospects handled/month", funded: true }]);
    expect(r.preview.sender).toMatch(/not known before sending/);
    expect(r.preview.costOfOneSend).toMatch(/Not priced yet/);
    expect(urls().some((u) => u.includes("/v1/trigger-events"))).toBe(false);
  });

  it("quotes the catalogue's cost with its unit when it has one", async () => {
    account({ pipeCost: 0.02 });
    const { proposeSwitchOn } = await load();
    const r = (await proposeSwitchOn(ask, p)) as any;
    expect(r.preview.costOfOneSend).toBe("$0.02 per email sent (estimated)");
  });

  it("no running campaign: proposes nothing and points to turning one on, never a feature request", async () => {
    account({ dulcetStatus: "stopped" });
    const { proposeSwitchOn } = await load();
    const r = (await proposeSwitchOn(ask, p)) as any;
    expect(r.status).toBe("no_live_campaign");
    expect(r.confirmationToken).toBeUndefined();
    expect(r.stoppedCampaigns).toEqual([{ id: "sfc-dulcet", name: "Dulcet", salesFunnelId: DULCET }]);
    expect(r.instruction).toMatch(/start_funnel_campaign/);
    expect(r.instruction).toMatch(/Never file a feature request/);
  });

  it.each([
    [{ ...ask, bodyText: undefined }, /needs a body/],
    [{ ...ask, email: "not-an-email" }, /not an email address/],
    [{ ...ask, subject: "" }, /subject is required/],
  ])("refuses a malformed email before any call (%#)", async (args, err) => {
    const { proposeSwitchOn } = await load();
    await expect(proposeSwitchOn(args, p)).rejects.toThrow(err);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe("confirm_switch_on push_email: one push through POST /v1/trigger-events", () => {
  it("pushes the email as written, idempotent on the token, and refuses the token once used", async () => {
    account();
    const { proposeSwitchOn, resolveSwitchOnProposal, executeSwitchOn } = await load();
    const proposal = (await proposeSwitchOn({ ...ask, name: "Sam" }, p)) as any;
    const history = [
      { role: "user", toolCalls: null },
      { role: "assistant", toolCalls: [{ name: "propose_switch_on", args: ask, result: proposal }] },
    ];
    const resolved = resolveSwitchOnProposal(proposal.confirmationToken, history);
    const out = (await executeSwitchOn(resolved, p)) as any;
    const push = fetchMock().mock.calls.find((c) => String(c[0]).endsWith("/v1/trigger-events"))!;
    expect((push[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((push[1] as RequestInit).body as string)).toEqual({
      triggerId: "email_pushed_via_api",
      brandId: "b",
      offerId: "o",
      person: { email: "staff@distribute.you", name: "Sam" },
      item: { subject: "Hiring in Leeds?", bodyText: "Hi Sam,\nI saw you are hiring..." },
      idempotencyKey: `copilot-email-push-${proposal.confirmationToken}`,
    });
    expect((push[1] as RequestInit).headers).toMatchObject({ "x-org-id": "org-1", "x-user-id": "user-1" });
    expect(out).toMatchObject({ pushed: true, action: "push_email", result: { event: { outcome: "ran" } } });

    const used = [...history, { role: "user", toolCalls: null }, { role: "assistant", toolCalls: [{ name: "confirm_switch_on", args: { confirmationToken: proposal.confirmationToken }, result: out }] }];
    expect(() => resolveSwitchOnProposal(proposal.confirmationToken, used)).toThrow(/already used/);
  });

  it("a push refused by the gateway fails loud with its status", async () => {
    fetchMock().mockResolvedValue(res(404, { error: "brand_not_in_org" }));
    const { executeSwitchOn } = await load();
    const proposal = { confirmationToken: "t", action: "push_email", summary: "", status: "awaiting_user_confirmation", instruction: "", target: { brandId: "b", offerId: "o", email: "staff@distribute.you", subject: "s", bodyText: "x" } } as any;
    await expect(executeSwitchOn(proposal, p)).rejects.toThrow(/404/);
  });
});

describe("list_campaigns says what starts each campaign (read it before calling anything missing)", () => {
  it("runsWhen carries the served trigger, or says a proactive campaign runs on its caps", async () => {
    const { triggerWords } = await import("../../src/lib/funnel-campaign-client.js");
    expect(triggerWords("Email Pushed Via API")).toBe("Each time: Email Pushed Via API");
    expect(triggerWords(null)).toMatch(/no trigger/);
  });
});
