import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SOPHIE-WA-ONBOARD-1101 (prod 2026-11-01): a person signed up on WhatsApp,
// gave their website, and was sent to the dashboard because the Copilot had no
// tool to create the brand. The whole "Set up a new account" path is now tools,
// each a gateway call with the person's identity; paying is a link only they pay,
// and the launch stays propose_switch_on → their yes → confirm_switch_on.

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
  return import("../../src/lib/account-setup.js");
}

const params = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const fetchMock = () => fetch as ReturnType<typeof vi.fn>;
const ok = (body: unknown, status = 200) => ({ ok: true, status, text: () => Promise.resolve(JSON.stringify(body)) });
const fail = (status: number, body: string) => ({ ok: false, status, text: () => Promise.resolve(body) });
const calls = () =>
  fetchMock().mock.calls.map(([url, init]) => ({
    url: String(url).replace("https://api.test.local", ""),
    method: (init as RequestInit).method,
    body: (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : null,
    org: ((init as RequestInit).headers as Record<string, string>)["x-org-id"],
  }));

const BRAND = "b-1";
const OFFER = "o-1";

describe("each setup step is the new-account skill's gateway call, with the person's identity", () => {
  it.each([
    ["proposeOffers", { brandId: BRAND, description: "AI cold email" }, "POST", `/v1/brands/${BRAND}/offers/proposals`, { description: "AI cold email" }],
    ["suggestIcp", { brandId: BRAND, offerId: OFFER }, "POST", `/v1/brands/${BRAND}/icp/suggest`, { offerId: OFFER }],
    ["splitAudiences", { brandId: BRAND, targetAudience: "SaaS founders" }, "POST", "/v1/orgs/audiences/split", { brandId: BRAND, targetAudience: "SaaS founders" }],
    [
      "confirmAudiences",
      { brandId: BRAND, offerId: OFFER, targetAudience: "SaaS founders", segments: [{ name: "US", description: "US founders" }] },
      "POST",
      "/v1/orgs/audiences/split/confirm",
      { brandId: BRAND, offerId: OFFER, targetAudience: "SaaS founders", segments: [{ name: "US", description: "US founders" }] },
    ],
    ["previewAudience", { audienceId: "a-1" }, "GET", "/v1/orgs/audiences/a-1/preview", null],
    [
      "previewEmail",
      { brandId: BRAND, offerId: OFFER, audience: "SaaS founders", recipient: { firstName: "Ann", lastName: "L.", title: "CEO", companyName: "Acme" } },
      "POST",
      "/v1/content/preview-email",
      { brandId: BRAND, offerId: OFFER, audience: "SaaS founders", recipient: { firstName: "Ann", lastName: "L.", title: "CEO", companyName: "Acme" } },
    ],
    ["getPrepaidStatus", {}, "GET", "/v1/billing/accounts/prepaid_status", null],
    [
      "buildAudiencePortfolio",
      { brandId: BRAND, offerId: OFFER, targetAudience: "SaaS founders" },
      "POST",
      "/v1/orgs/audiences/portfolio",
      { brandId: BRAND, offerId: OFFER, targetAudience: "SaaS founders" },
    ],
  ])("%s → %s %s", async (fn, args, method, url, body) => {
    fetchMock().mockResolvedValue(ok({ ok: 1 }));
    const mod = (await load()) as unknown as Record<string, (a: unknown, p: unknown) => Promise<unknown>>;
    expect(await mod[fn](args, params)).toEqual({ ok: 1 });
    expect(calls()).toEqual([{ url, method, body, org: "org-1" }]);
  });

  it("confirm_offers saves the offers kept, then readies the preview email for the chosen one", async () => {
    fetchMock()
      .mockResolvedValueOnce(ok({ offers: [{ offerId: OFFER }], chosenOfferId: OFFER }))
      .mockResolvedValueOnce(ok({ status: "preparing" }, 202));
    const { confirmOffers } = await load();
    const r = (await confirmOffers({ brandId: BRAND, offers: [{ name: "Cold email" }] }, params)) as Record<string, unknown>;
    expect(r.chosenOfferId).toBe(OFFER);
    expect(r.previewEmail).toBe("preparing");
    expect(calls().map((c) => `${c.method} ${c.url}`)).toEqual([`POST /v1/brands/${BRAND}/offers/confirm`, "POST /v1/content/preview-email/prepare"]);
    expect(calls()[1].body).toEqual({ brandId: BRAND, offerId: OFFER });
  });

  it("a failed prepare never hides the confirmed offers", async () => {
    fetchMock().mockResolvedValueOnce(ok({ chosenOfferId: OFFER })).mockResolvedValueOnce(fail(502, "down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { confirmOffers } = await load();
    const r = (await confirmOffers({ brandId: BRAND, offers: [{ name: "Cold email" }] }, params)) as Record<string, unknown>;
    expect(r.chosenOfferId).toBe(OFFER);
    expect(String(r.previewEmail)).toMatch(/still works/);
  });

  it("fails loud on a missing id or an owner refusal", async () => {
    const { suggestIcp, proposeOffers } = await load();
    await expect(suggestIcp({ brandId: BRAND }, params)).rejects.toThrow(/offerId is required/);
    fetchMock().mockResolvedValue(fail(409, "SEVERAL_OFFERS"));
    await expect(proposeOffers({ brandId: BRAND, description: "x" }, params)).rejects.toThrow(/409/);
  });
});

describe("the payment link: only the person pays, and never for an account that needs none", () => {
  const amounts = { topupAmountCents: 1000, autoTopupAmountCents: 1500, autoTopupThresholdCents: 500 };

  it("an unpaid account gets the checkout url for the amounts said yes to", async () => {
    fetchMock()
      .mockResolvedValueOnce(ok({ state: "awaiting_payment" }))
      .mockResolvedValueOnce(ok({ url: "https://checkout.stripe.com/c/pay/x" }));
    const { createPrepaidCheckout } = await load();
    expect(await createPrepaidCheckout(amounts, params)).toEqual({ url: "https://checkout.stripe.com/c/pay/x" });
    expect(calls()[1]).toMatchObject({
      method: "POST",
      url: "/v1/billing/accounts/prepaid_checkout",
      body: { topup_amount_cents: 1000, auto_topup_amount_cents: 1500, auto_topup_threshold_cents: 500 },
    });
  });

  it("a new account with no billing account yet (404) gets the url too", async () => {
    fetchMock().mockResolvedValueOnce(fail(404, "no account")).mockResolvedValueOnce(ok({ url: "https://pay" }));
    const { createPrepaidCheckout } = await load();
    expect(await createPrepaidCheckout(amounts, params)).toEqual({ url: "https://pay" });
  });

  it.each(["active", "not_prepaid"])("%s: no checkout is opened (billing would switch a postpaid org to prepaid)", async (state) => {
    fetchMock().mockResolvedValueOnce(ok({ state }));
    const { createPrepaidCheckout } = await load();
    const r = (await createPrepaidCheckout(amounts, params)) as Record<string, unknown>;
    expect(r.url).toBeNull();
    expect(r.state).toBe(state);
    expect(calls()).toHaveLength(1);
  });

  it("refuses amounts under the gateway minimums before any call", async () => {
    const { createPrepaidCheckout } = await load();
    await expect(createPrepaidCheckout({ ...amounts, topupAmountCents: 500 }, params)).rejects.toThrow(/at least 1000/);
    await expect(createPrepaidCheckout({ ...amounts, autoTopupAmountCents: 15.5 }, params)).rejects.toThrow(/whole number/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("the tool says only the person pays, after their yes on the amounts", async () => {
    const { ACCOUNT_SETUP_TOOLS } = await load();
    const d = ACCOUNT_SETUP_TOOLS.create_prepaid_checkout.description!;
    expect(d).toMatch(/^HARD RULE/);
    expect(d).toContain("only they pay it");
    expect(d).toContain("said yes, in this chat, to these exact amounts");
  });
});

describe("who gets the setup tools", () => {
  it("a chat acting for a signed-in person (reads our skills, can propose a launch) gets every setup tool, once", async () => {
    const { withAccountSetup, ACCOUNT_SETUP_TOOL_NAMES } = await load();
    const copilot = ["read_skill", "propose_switch_on", "confirm_switch_on", "list_brands"];
    const tools = withAccountSetup(copilot);
    for (const t of ACCOUNT_SETUP_TOOL_NAMES) expect(tools.filter((x) => x === t)).toHaveLength(1);
    expect(withAccountSetup(tools)).toEqual(tools);
    expect(tools).toContain("create_brand_from_url");
  });

  it("a guest (sign-in tools only) and an editor config get none", async () => {
    const { withAccountSetup } = await load();
    const { SIGN_IN_TOOL_NAMES } = await import("../../src/lib/channel-sign-in.js");
    expect(withAccountSetup([...SIGN_IN_TOOL_NAMES])).toEqual([...SIGN_IN_TOOL_NAMES]);
    expect(withAccountSetup(["list_personas", "create_persona"])).toEqual(["list_personas", "create_persona"]);
  });

  it("a proactive turn keeps none that writes, pays or builds", async () => {
    const { withAccountSetup } = await load();
    const { proactiveToolNames } = await import("../../src/lib/copilot-proactive.js");
    const kept = proactiveToolNames(withAccountSetup(["read_skill", "propose_switch_on"]));
    expect(kept.filter((t) => /^(create_|confirm_|propose_|preview_|build_|split_|suggest_)/.test(t))).toEqual([]);
  });

  it("every setup tool is declared to the model and mapped to its gateway operation", async () => {
    const { ACCOUNT_SETUP_TOOL_NAMES } = await load();
    const { TOOL_REGISTRY } = await import("../../src/lib/anthropic.js");
    const { COPILOT_TOOL_API_OPS } = await import("../../src/lib/skill-api-ops.js");
    for (const t of ACCOUNT_SETUP_TOOL_NAMES) {
      expect(TOOL_REGISTRY[t]?.name).toBe(t);
      expect(COPILOT_TOOL_API_OPS[t]?.length).toBeGreaterThan(0);
    }
  });

  it("the new-account skill walks every step through these tools, each beside its API operation", async () => {
    const { ACCOUNT_SETUP_TOOL_NAMES } = await load();
    const { SEED_SKILLS } = await import("../../src/lib/skill-seed.js");
    const { skillApiGaps } = await import("../../src/lib/skill-api-ops.js");
    const { AVAILABLE_TOOL_NAMES } = await import("../../src/lib/anthropic.js");
    const skill = SEED_SKILLS.find((s) => s.slug === "new-account")!.content;
    for (const t of ACCOUNT_SETUP_TOOL_NAMES) expect(skill).toContain(t);
    expect(skill).toContain("find_sales_funnels");
    expect(skill).toContain("the launch in `campaigns`");
    expect(skillApiGaps(skill, AVAILABLE_TOOL_NAMES)).toEqual({ missing: [], unmapped: [] });
    expect(skill).toContain("never send the person to the dashboard");
  });
});

describe("WhatsApp: the chat is a whole way to set up, never a hand-off to the dashboard", () => {
  it("a signed-in person's channel block says every step is done here and paying/launching wait for their yes", async () => {
    const { buildChannelBlock } = await import("../../src/lib/channel-copilot.js");
    const block = buildChannelBlock(
      { kind: "whatsapp", assistant: { name: "Sophie", role: null, instructions: null }, sender: { phone: "+33600000001" }, thread: [] },
      false,
    );
    expect(block).toContain("never send them to the dashboard for a step your tools can do");
    expect(block).toContain("paying and launching wait for their clear yes");
  });
});

describe("a guest crm knows by an email that is no account's (prod 2026-11-01: a code went unasked to an old school address)", () => {
  const payload = {
    idempotencyKey: "occ-1",
    brandId: "22222222-2222-4222-8222-222222222222",
    medium: "whatsapp" as const,
    recipient: { email: "old@school.edu", phone: "+33600000001", name: "Kevin" },
    assistant: { name: "Sophie", role: "Assistant", instructions: null },
    systemPrompt: "THE GAME",
    message: "THE THREAD",
    responseSchema: { type: "object", properties: { message: { type: "string" } } },
    messageField: "message",
  };
  const frame = (over: Record<string, unknown>) => ({ payload, ownBrand: true, guest: true, phoneBound: true, afterSignIn: false, ...over });

  it("no account has the email: never signs in with it on its own, asks which email their account should use", async () => {
    const { buildLeadTurnBlock } = await import("../../src/lib/lead-turn.js");
    const block = buildLeadTurnBlock(frame({ recipientEmailIsAccount: false }));
    expect(block).not.toContain("We already know this person");
    expect(block).toContain("no distribute.you account uses it");
    expect(block).toContain("ask which email their account should use");
  });

  it("an account has the email: the model signs in with it itself, never asks who they are", async () => {
    const { buildLeadTurnBlock } = await import("../../src/lib/lead-turn.js");
    const block = buildLeadTurnBlock(frame({ recipientEmailIsAccount: true }));
    expect(block).toContain("We already know this person: our own records tie their number to old@school.edu");
    expect(block).not.toContain("no distribute.you account uses it");
  });

  it("emailHasAccount reads client-service users by email", async () => {
    process.env.CLIENT_SERVICE_URL = "https://client.test";
    process.env.CLIENT_SERVICE_API_KEY = "k";
    const { emailHasAccount } = await import("../../src/lib/lead-turn.js");
    const f = vi.fn().mockResolvedValueOnce({ status: 200, ok: true, json: () => Promise.resolve({ users: [] }) })
      .mockResolvedValueOnce({ status: 200, ok: true, json: () => Promise.resolve({ users: [{ id: "u" }] }) });
    expect(await emailHasAccount(" Old@School.edu ", f as unknown as typeof fetch)).toBe(false);
    expect(String(f.mock.calls[0][0])).toBe("https://client.test/internal/users?email=old%40school.edu");
    expect(await emailHasAccount("a@b.co", f as unknown as typeof fetch)).toBe(true);
  });
});
