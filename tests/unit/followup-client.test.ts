import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelFollowup,
  createFollowup,
  fireFollowup,
  FOLLOWUP_FUNNEL_ID,
  githubIssueArg,
  ISSUE_FOLLOWUP_FUNNEL_ID,
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
  CRM_SERVICE_URL: "http://crm",
  CRM_SERVICE_API_KEY: "rk",
  API_SERVICE_URL: "http://gateway",
  ADMIN_DISTRIBUTE_API_KEY: "ak",
};

const OFFERS = {
  offers: [
    { offerId: "archived-offer", status: "archived" },
    { offerId: "live-offer", status: "active" },
    { offerId: "newer-live-offer", status: "active" },
  ],
};
const NOBODY = { status: 404, body: { type: "not_found", reason: "person_not_found", error: "no person holds email:marie@example.com" } };

/** The create path's reads, answered by default: nobody in crm, a live offer, billing funds the cap. */
function createRoutes(over: (c: Call) => { status: number; body: unknown } | undefined = () => undefined) {
  return (c: Call) => {
    const o = over(c);
    if (o) return o;
    if (c.url.startsWith("http://crm/orgs/people/timeline")) return NOBODY;
    if (c.url === "http://gateway/v1/brands/our-brand/offers") return { status: 200, body: OFFERS };
    if (c.method === "POST" && c.url === "http://campaign/sales-funnel-campaigns") return { status: 201, body: { salesFunnelCampaign: marieRow, filing: [{ outcome: "filed" }] } };
    if (c.method === "PUT") return { status: 200, body: { funded: true, fundedBy: "max_volume" } };
    return { status: 200, body: {} };
  };
}

const marieRow = {
  id: "fu-1",
  status: "ongoing",
  instruction: "Tell Marie her cost per meeting is $37.",
  salesFunnelId: FOLLOWUP_FUNNEL_ID,
  offerId: "live-offer",
  people: [{ email: "marie@example.com", leadId: "lead-marie" }],
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeDeps(routes: (c: Call) => { status: number; body: unknown }, judge: FollowupDeps["judge"] = async () => {
  throw new Error("judge must not be called");
}) {
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
    judge,
  };
  return { deps, calls };
}

const listing = (rows: unknown[]) => ({ status: 200, body: { salesFunnelCampaigns: rows } });

describe("Copilot follow-ups", () => {
  beforeEach(() => Object.assign(process.env, ENV));
  afterEach(() => {
    for (const k of Object.keys(ENV)) delete process.env[k];
  });

  it("create: reads the thread, picks the brand's LIVE offer, stopped campaign naming the chat user, funded volume-1 cap, then activate", async () => {
    const { deps, calls } = fakeDeps(createRoutes());
    const out = await createFollowup({ instruction: "Tell Marie her cost per meeting is $37." }, { userId: "marie-user" }, deps);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET http://crm/orgs/people/timeline?brandId=our-brand&personKey=${encodeURIComponent("email:marie@example.com")}`,
      "GET http://gateway/v1/brands/our-brand/offers",
      "POST http://campaign/sales-funnel-campaigns",
      `PUT http://billing/internal/brands/our-brand/offers/live-offer/sales-funnels/${encodeURIComponent(FOLLOWUP_FUNNEL_ID)}/campaigns/fu-1/caps`,
      "PATCH http://campaign/sales-funnel-campaigns/fu-1",
    ]);
    expect(calls[1].headers["x-api-key"]).toBe("ak");
    expect(calls[2].headers["x-org-id"]).toBe("our-org");
    expect(calls[2].headers["x-run-id"]).toBe("platform-run-1");
    expect(calls[2].body).toMatchObject({ status: "stopped", people: [{ email: "marie@example.com" }], brandId: "our-brand", offerId: "live-offer" });
    expect(calls[3].body).toEqual({ maxBudget: null, maxVolume: { count: 1, period: "one_off" } });
    expect(calls[4].body).toEqual({ status: "activate" });
    expect(out).toMatchObject({ created: true, followUpId: "fu-1", to: "marie@example.com", sendsAtMost: 1 });
  });

  it("create: never lands on an archived offer, and fails loud when the brand has no live offer", async () => {
    const { deps, calls } = fakeDeps(
      createRoutes((c) => (c.url.startsWith("http://gateway") ? { status: 200, body: { offers: [{ offerId: "archived-offer", status: "archived" }] } } : undefined)),
    );
    await expect(createFollowup({ instruction: "x" }, { userId: "u" }, deps)).rejects.toThrow("no live offer");
    expect(calls.some((c) => c.url.includes("archived-offer"))).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("create: billing not funding the cap leaves it stopped and fails loud", async () => {
    const { deps, calls } = fakeDeps(createRoutes((c) => (c.method === "PUT" ? { status: 200, body: { funded: false, fundedBy: null } } : undefined)));
    await expect(createFollowup({ instruction: "x" }, { userId: "u" }, deps)).rejects.toThrow("billing does not fund");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("create: a message we already sent that says it means nothing is created (Jev judges our outbound emails only)", async () => {
    const timeline = {
      status: 200,
      body: {
        sources: [{ source: "gmail", status: "ok" }],
        items: [
          { at: "2026-10-14T13:20:00Z", channel: "chat", kind: "message", direction: "outbound", subject: null, text: "I'll email you." },
          { at: "2026-10-14T13:59:15Z", channel: "email", kind: "message", direction: "outbound", subject: "Re: Enquiry", text: "Good news: test sending is live." },
          { at: "2026-10-14T14:00:00Z", channel: "web", kind: "event", direction: null, subject: null, text: "/" },
        ],
      },
    };
    let judged: unknown;
    const { deps, calls } = fakeDeps(
      createRoutes((c) => (c.url.startsWith("http://crm") ? timeline : undefined)),
      async (state) => {
        judged = state;
        return { alreadyKept: { type: "noul", noul: 0.93 } };
      },
    );
    const out = await createFollowup({ instruction: "Tell them one-off test sending is live." }, { userId: "u" }, deps);
    expect(out).toMatchObject({ created: false, reason: "already_told", lastMessageSubject: "Re: Enquiry" });
    expect((judged as { messagesWeAlreadySentThem: unknown[] }).messagesWeAlreadySentThem).toEqual([
      { at: "2026-10-14T13:59:15Z", channel: "email", subject: "Re: Enquiry", text: "Good news: test sending is live." },
    ]);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("create: Jev saying our messages do not say it goes on to create", async () => {
    const timeline = { status: 200, body: { sources: [], items: [{ at: "t", channel: "email", kind: "message", direction: "outbound", subject: "Hi", text: "Welcome." }] } };
    const { deps } = fakeDeps(createRoutes((c) => (c.url.startsWith("http://crm") ? timeline : undefined)), async () => ({ alreadyKept: { type: "noul", noul: 0.1 } }));
    expect(await createFollowup({ instruction: "x" }, { userId: "u" }, deps)).toMatchObject({ created: true });
  });

  it("create: an unreadable message source or crm error fails loud, nothing created", async () => {
    const broken = { status: 200, body: { sources: [{ source: "gmail", status: "error", error: "token expired" }], items: [] } };
    const a = fakeDeps(createRoutes((c) => (c.url.startsWith("http://crm") ? broken : undefined)));
    await expect(createFollowup({ instruction: "x" }, { userId: "u" }, a.deps)).rejects.toThrow("gmail: token expired");
    expect(a.calls.some((c) => c.method === "POST")).toBe(false);

    const b = fakeDeps(createRoutes((c) => (c.url.startsWith("http://crm") ? { status: 502, body: { error: "down" } } : undefined)));
    await expect(createFollowup({ instruction: "x" }, { userId: "u" }, b.deps)).rejects.toThrow("502");
    expect(b.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("create: a person the brand cannot file is never started", async () => {
    const { deps, calls } = fakeDeps(
      createRoutes((c) => (c.method === "POST" ? { status: 201, body: { salesFunnelCampaign: marieRow, filing: [{ outcome: "person_not_known" }] } } : undefined)),
    );
    await expect(createFollowup({ instruction: "x" }, { userId: "u" }, deps)).rejects.toThrow("person_not_known");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("create: refuses an empty instruction before any call", async () => {
    const { deps, calls } = fakeDeps(() => ({ status: 200, body: {} }));
    await expect(createFollowup({ instruction: " " }, { userId: "u" }, deps)).rejects.toThrow("instruction is required");
    expect(calls).toHaveLength(0);
  });

  it("list: only this user's open follow-ups, by their email", async () => {
    const { deps, calls } = fakeDeps((c) => (c.url.startsWith("http://crm") ? NOBODY : listing([marieRow])));
    const out = await listFollowups({}, { userId: "u" }, deps);
    expect(out.lastEmailsWeSentThem).toEqual([]);
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

  // The two prod answers of 2026-11-01 (CHAT-TRUTH-1101), trimmed to the served fields.
  const RAN_NO_DELIVERY = { event: { id: "eda9cb51", status: "done", outcome: "ran", skipReason: null, delivery: null, ranCampaignIds: ["3b19055d"] }, replayed: false };
  const SKIPPED = { event: { id: "51f1e9a2", status: "done", outcome: "skipped", skipReason: "cohort_run_in_flight", delivery: null, ranCampaignIds: [] }, replayed: false };

  it("fire reports follow_up_due for the person's lead on our brand", async () => {
    const { deps, calls } = fakeDeps((c) => (c.method === "GET" ? listing([marieRow]) : { status: 200, body: RAN_NO_DELIVERY }));
    await fireFollowup({ followUpId: "fu-1" }, { userId: "u" }, deps);
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "http://campaign/internal/trigger-events",
      body: { triggerId: "follow_up_due", brandId: "our-brand", offerId: "live-offer", leadId: "lead-marie" },
    });
  });

  it("fire: outcome ran with no delivery is on its way, never sent (prod 12:54)", async () => {
    const { deps } = fakeDeps((c) => (c.method === "GET" ? listing([marieRow]) : { status: 200, body: RAN_NO_DELIVERY }));
    const out = await fireFollowup({ followUpId: "fu-1" }, { userId: "u" }, deps);
    expect(out).toMatchObject({ followUpId: "fu-1", eventId: "eda9cb51", messageState: "on_its_way", sent: false });
    expect(out.meaning).toContain("never say it was sent");
    // The raw event (whose `outcome: "ran"` read as sent) never reaches the model.
    expect(JSON.stringify(out)).not.toContain('"outcome"');
  });

  it("fire: a skipped fire is not sent, with campaign-service's reason (prod 12:42)", async () => {
    const { deps } = fakeDeps((c) => (c.method === "GET" ? listing([marieRow]) : { status: 200, body: SKIPPED }));
    const out = await fireFollowup({ followUpId: "fu-1" }, { userId: "u" }, deps);
    expect(out).toMatchObject({ messageState: "not_sent", sent: false, why: "cohort_run_in_flight" });
  });

  it("fire: an answer without an event fails loud", async () => {
    const { deps } = fakeDeps((c) => (c.method === "GET" ? listing([marieRow]) : { status: 200, body: { replayed: false } }));
    await expect(fireFollowup({ followUpId: "fu-1" }, { userId: "u" }, deps)).rejects.toThrow("without an event");
  });

  it("list: shows the last emails that actually left for this person, newest first", async () => {
    const timeline = {
      status: 200,
      body: {
        sources: [{ source: "gmail", status: "ok" }],
        items: [
          { at: "2026-11-01T12:10:00Z", channel: "email", kind: "message", direction: "outbound", subject: "Welcome", text: "Hi" },
          { at: "2026-11-01T12:20:00Z", channel: "email", kind: "message", direction: "inbound", subject: "Re: Welcome", text: "?" },
          { at: "2026-11-01T12:30:00Z", channel: "whatsapp", kind: "message", direction: "outbound", subject: null, text: "Hey" },
        ],
      },
    };
    const { deps } = fakeDeps((c) => (c.url.startsWith("http://crm") ? timeline : listing([marieRow])));
    const out = await listFollowups({}, { userId: "u" }, deps);
    expect(out.lastEmailsWeSentThem).toEqual([{ at: "2026-11-01T12:10:00Z", subject: "Welcome" }]);
  });

  it("list: an unreadable mailbox is said, never read as no email", async () => {
    const broken = { status: 200, body: { sources: [{ source: "gmail", status: "error", error: "token expired" }], items: [] } };
    const { deps } = fakeDeps((c) => (c.url.startsWith("http://crm") ? broken : listing([marieRow])));
    const out = await listFollowups({}, { userId: "u" }, deps);
    expect(out.lastEmailsWeSentThem).toMatchObject({ unreadable: expect.stringContaining("gmail: token expired") });
  });

  it("fire_followup and list_followups tell the agent what counts as sent", () => {
    expect(TOOL_REGISTRY.fire_followup.description).toContain("messageState");
    expect(TOOL_REGISTRY.list_followups.description).toContain("lastEmailsWeSentThem");
  });

  // WF-SILENT-FOLLOWUP-1101 (prod 2026-11-01, Martian DBB, a paying client): the follow-up pipe (Signup -> Paid
  // client) claimed nobody, nothing was sent. The tool says who it writes to, so a client is answered in the chat.
  it("create_followup tells the agent its pipe does not write to a paying client", () => {
    const d = TOOL_REGISTRY.create_followup.description ?? "";
    expect(d).toContain("does not write to someone who already pays us");
    expect(d).toContain("answer here in the conversation");
  });

  it("fails loud when the follow-up scope is not configured", async () => {
    delete process.env.COPILOT_FOLLOWUP_BRAND_ID;
    const { deps } = fakeDeps(() => ({ status: 200, body: {} }));
    await expect(listFollowups({}, { userId: "u" }, deps)).rejects.toThrow("COPILOT_FOLLOWUP_BRAND_ID");
  });

  it("create_followup tells the agent the writer reads the user's own and public figures at send time", () => {
    const d = TOOL_REGISTRY.create_followup.description ?? "";
    expect(d).toContain("this user's own account figures");
    expect(d).toContain("never another customer's");
    expect(d).toContain("already_told");
  });

  it("create with waitForIssue: waits on that issue on the GitHub-issue funnel, capped, activated, never fired by hand", async () => {
    const { deps, calls } = fakeDeps(
      createRoutes((c) => (c.method === "POST" ? { status: 201, body: { salesFunnelCampaign: { ...marieRow, id: "fu-2" }, filing: [{ outcome: "filed" }] } } : undefined)),
    );
    const out = await createFollowup(
      { instruction: "Give her the exact cost per meeting.", waitForIssue: "https://github.com/shamanic-technologies/features-service/issues/1600" },
      { userId: "u" },
      deps,
    );
    expect(calls[2].body).toMatchObject({
      salesFunnelId: ISSUE_FOLLOWUP_FUNNEL_ID,
      githubIssue: { repo: "shamanic-technologies/features-service", number: 1600 },
    });
    expect(calls[3].url).toContain(`/offers/live-offer/sales-funnels/${encodeURIComponent(ISSUE_FOLLOWUP_FUNNEL_ID)}/campaigns/fu-2/caps`);
    expect(out.firesWhen).toContain("by itself");

    const waiting = { ...marieRow, githubIssue: { repo: "shamanic-technologies/features-service", number: 1600 }, githubIssueCheck: { state: "open" } };
    const f = fakeDeps(() => listing([waiting]));
    await expect(fireFollowup({ followUpId: "fu-1" }, { userId: "u" }, f.deps)).rejects.toThrow("fires by itself");
    const l = fakeDeps(() => listing([waiting]));
    expect((await listFollowups({}, { userId: "u" }, l.deps)).followUps[0]).toMatchObject({ issueState: "open" });
  });

  it("waitForIssue accepts only an issue URL of our own repos", () => {
    expect(githubIssueArg(undefined)).toBeNull();
    expect(() => githubIssueArg("https://github.com/someone-else/repo/issues/3")).toThrow("waitForIssue");
    expect(() => githubIssueArg("#1600")).toThrow("waitForIssue");
  });

  it("every follow-up tool is registered for allowedTools", () => {
    for (const t of ["create_followup", "update_followup", "cancel_followup", "list_followups", "fire_followup"]) {
      expect(TOOL_REGISTRY[t]?.name).toBe(t);
    }
  });
});
