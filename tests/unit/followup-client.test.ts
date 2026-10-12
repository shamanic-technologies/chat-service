import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelFollowup,
  createFollowup,
  fireFollowup,
  FOLLOWUP_FUNNEL_ID,
  listFollowups,
  updateFollowup,
  type FollowupDeps,
} from "../../src/lib/followup-client.js";
import { TOOL_REGISTRY } from "../../src/lib/anthropic.js";

const ENV = {
  CAMPAIGN_SERVICE_URL: "http://campaign",
  CAMPAIGN_SERVICE_API_KEY: "ck",
  BILLING_SERVICE_URL: "http://billing",
  BILLING_SERVICE_API_KEY: "bk",
  COPILOT_FOLLOWUP_ORG_ID: "our-org",
  COPILOT_FOLLOWUP_USER_ID: "staff-user",
  COPILOT_FOLLOWUP_BRAND_ID: "our-brand",
  COPILOT_FOLLOWUP_OFFER_ID: "our-offer",
};

const marieRow = {
  id: "fu-1",
  status: "ongoing",
  instruction: "Tell Marie her cost per meeting is $37.",
  salesFunnelId: FOLLOWUP_FUNNEL_ID,
  people: [{ email: "marie@example.com", leadId: "lead-marie" }],
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeDeps(routes: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const c: Call = {
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = routes(c);
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  const deps: FollowupDeps = {
    fetchEmail: async () => "Marie@Example.com",
    newRunId: async () => "platform-run-1",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
  return { deps, calls };
}

const listing = (rows: unknown[]) => ({ status: 200, body: { salesFunnelCampaigns: rows } });

describe("Copilot follow-ups", () => {
  beforeEach(() => Object.assign(process.env, ENV));
  afterEach(() => {
    for (const k of Object.keys(ENV)) delete process.env[k];
  });

  it("create: stopped campaign on OUR org naming the chat user, then a volume-1 one_off cap, then activate", async () => {
    const { deps, calls } = fakeDeps((c) => {
      if (c.method === "POST") return { status: 201, body: { salesFunnelCampaign: marieRow, filing: [{ outcome: "filed" }] } };
      return { status: 200, body: {} };
    });
    const out = await createFollowup({ instruction: "Tell Marie her cost per meeting is $37." }, { userId: "marie-user" }, deps);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST http://campaign/sales-funnel-campaigns",
      `PUT http://billing/internal/brands/our-brand/offers/our-offer/sales-funnels/${encodeURIComponent(FOLLOWUP_FUNNEL_ID)}/campaigns/fu-1/caps`,
      "PATCH http://campaign/sales-funnel-campaigns/fu-1",
    ]);
    expect(calls[0].headers["x-org-id"]).toBe("our-org");
    expect(calls[0].headers["x-run-id"]).toBe("platform-run-1");
    expect(calls[0].body).toMatchObject({ status: "stopped", people: [{ email: "marie@example.com" }], brandId: "our-brand" });
    expect(calls[1].body).toEqual({ maxBudget: null, maxVolume: { count: 1, period: "one_off" } });
    expect(calls[2].body).toEqual({ status: "activate" });
    expect(out).toMatchObject({ followUpId: "fu-1", to: "marie@example.com", sendsAtMost: 1 });
  });

  it("create: a person the brand cannot file is never started", async () => {
    const { deps, calls } = fakeDeps(() => ({ status: 201, body: { salesFunnelCampaign: marieRow, filing: [{ outcome: "person_not_known" }] } }));
    await expect(createFollowup({ instruction: "x" }, { userId: "u" }, deps)).rejects.toThrow("person_not_known");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("create: refuses an empty instruction before any call", async () => {
    const { deps, calls } = fakeDeps(() => ({ status: 200, body: {} }));
    await expect(createFollowup({ instruction: " " }, { userId: "u" }, deps)).rejects.toThrow("instruction is required");
    expect(calls).toHaveLength(0);
  });

  it("list: only this user's open follow-ups, by their email", async () => {
    const { deps, calls } = fakeDeps(() => listing([marieRow]));
    const out = await listFollowups({}, { userId: "u" }, deps);
    expect(calls[0].url).toBe("http://campaign/sales-funnel-campaigns?personEmail=marie%40example.com&status=ongoing");
    expect(out.followUps).toEqual([{ followUpId: "fu-1", status: "ongoing", instruction: marieRow.instruction, salesFunnelId: FOLLOWUP_FUNNEL_ID }]);
  });

  it("update / cancel / fire refuse an id that is not this user's", async () => {
    for (const fn of [updateFollowup, cancelFollowup, fireFollowup]) {
      const { deps, calls } = fakeDeps(() => listing([marieRow]));
      await expect(fn({ followUpId: "someone-else", instruction: "x" }, { userId: "u" }, deps)).rejects.toThrow("no follow-up");
      expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    }
  });

  it("update rewords, cancel stops", async () => {
    const a = fakeDeps((c) => (c.method === "GET" ? listing([marieRow]) : { status: 200, body: {} }));
    await updateFollowup({ followUpId: "fu-1", instruction: "New words." }, { userId: "u" }, a.deps);
    expect(a.calls[1]).toMatchObject({ method: "PATCH", body: { instruction: "New words." } });

    const b = fakeDeps((c) => (c.method === "GET" ? listing([marieRow]) : { status: 200, body: {} }));
    await cancelFollowup({ followUpId: "fu-1" }, { userId: "u" }, b.deps);
    expect(b.calls[1]).toMatchObject({ method: "PATCH", body: { status: "stop" } });
  });

  it("fire reports follow_up_due for the person's lead on our brand", async () => {
    const { deps, calls } = fakeDeps((c) => (c.method === "GET" ? listing([marieRow]) : { status: 200, body: { outcome: "ran" } }));
    const out = await fireFollowup({ followUpId: "fu-1" }, { userId: "u" }, deps);
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "http://campaign/internal/trigger-events",
      body: { triggerId: "follow_up_due", brandId: "our-brand", offerId: "our-offer", leadId: "lead-marie" },
    });
    expect(out.event).toEqual({ outcome: "ran" });
  });

  it("fails loud when the follow-up scope is not configured", async () => {
    delete process.env.COPILOT_FOLLOWUP_OFFER_ID;
    const { deps } = fakeDeps(() => ({ status: 200, body: {} }));
    await expect(listFollowups({}, { userId: "u" }, deps)).rejects.toThrow("COPILOT_FOLLOWUP_OFFER_ID");
  });

  it("create_followup tells the agent the writer reads the user's own and public figures at send time", () => {
    const d = TOOL_REGISTRY.create_followup.description ?? "";
    expect(d).toContain("this user's own account figures");
    expect(d).toContain("never another customer's");
  });

  it("every follow-up tool is registered for allowedTools", () => {
    for (const t of ["create_followup", "update_followup", "cancel_followup", "list_followups", "fire_followup"]) {
      expect(TOOL_REGISTRY[t]?.name).toBe(t);
    }
  });
});
