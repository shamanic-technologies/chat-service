import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PLAN_ORG_PREFIX,
  PLAN_PRINCIPAL,
  PlanRefusal,
  brandIdOf,
  domainClaim,
  openUnclaimedOrg,
  planCallRefusal,
  planGuard,
  runGuestPlanCall,
  seedTrialCredit,
  websiteDomain,
  type GuestPlanDeps,
  type PlanOrg,
} from "../../src/lib/guest-plan.js";
import { PLAN_BEFORE_ACCOUNT, identityLines } from "../../src/lib/channel-copilot.js";
import type { ApiCallParams } from "../../src/lib/api-client.js";

// DISTRY-ONE-AI-1118 increment B (owner plan 2026-11-19): a guest who gives their website gets their
// plan built on the SAME unclaimed org the signup page opens, before any account; the server refuses
// anything outside the signup page's allowlist.

const BRAND = "b0000000-0000-4000-8000-000000000001";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  process.env.CLIENT_SERVICE_URL = "https://client.test.local";
  process.env.CLIENT_SERVICE_API_KEY = "ck";
  process.env.BILLING_SERVICE_URL = "https://billing.test.local";
  process.env.BILLING_SERVICE_API_KEY = "bk";
  process.env.BRAND_SERVICE_URL = "https://brand.test.local";
  process.env.BRAND_SERVICE_API_KEY = "rk";
});

describe("the plan's org may make only the signup page's calls (planCallRefusal)", () => {
  it.each([
    ["POST", "/v1/brands", { url: "https://acme.com" }],
    ["GET", `/v1/brands/${BRAND}/offers`, undefined],
    ["POST", `/v1/brands/${BRAND}/offers/proposals`, { description: "x" }],
    ["POST", `/v1/brands/${BRAND}/offers/confirm`, { offers: [] }],
    ["POST", `/v1/brands/${BRAND}/icp/suggest`, { offerId: "o" }],
    ["POST", "/v1/orgs/audiences/split", { brandId: BRAND, targetAudience: "x" }],
    ["POST", "/v1/orgs/audiences/split/confirm", { brandId: BRAND }],
    ["POST", "/v1/orgs/audiences/split/estimate", { brandId: BRAND }],
    ["GET", "/v1/orgs/audiences/a1/preview", undefined],
    ["GET", "/v1/orgs/audiences/a1/preview/companies?page=1", undefined],
    ["POST", "/v1/content/preview-email", { brandId: BRAND, offerId: "o" }],
    ["GET", `/v1/offers/o1/sales-funnels?brandId=${BRAND}`, undefined],
  ])("allows %s %s", (method, path, body) => {
    expect(planCallRefusal(method, path, body, BRAND)).toBeNull();
  });

  it.each([
    ["POST", "/v1/billing/accounts/prepaid_checkout"],
    ["GET", "/v1/billing/accounts/prepaid_status"],
    ["POST", "/v1/orgs/audiences/portfolio"],
    ["POST", "/v1/sales-funnel-campaigns"],
    ["GET", "/v1/campaigns"],
    ["GET", "/v1/brands"],
    ["POST", "/v1/staff-requests"],
    ["DELETE", `/v1/brands/${BRAND}`],
    ["GET", "/v1/brands/../billing"],
  ])("refuses %s %s: it needs their account", (method, path) => {
    expect(planCallRefusal(method, path, {}, BRAND)).toBe("needs_account");
  });

  it("binds every brand-scoped call to the plan's one brand, in the path, the query and the body", () => {
    expect(planCallRefusal("GET", "/v1/brands/other/offers", undefined, BRAND)).toBe("other_brand");
    expect(planCallRefusal("GET", "/v1/offers/o1/sales-funnels?brandId=other", undefined, BRAND)).toBe("other_brand");
    expect(planCallRefusal("POST", "/v1/content/preview-email", { brandId: "other" }, BRAND)).toBe("other_brand");
    expect(planCallRefusal("POST", "/v1/brands/extract-fields", { brandIds: [BRAND, "other"] }, BRAND)).toBe("other_brand");
    // No brand yet: nothing brand-scoped runs.
    expect(planCallRefusal("GET", `/v1/brands/${BRAND}/offers`, undefined, null)).toBe("other_brand");
  });

  it("the guard throws a refusal the model can say, before the call leaves", () => {
    expect(() => planGuard(BRAND)("POST", "/v1/billing/accounts/prepaid_checkout", {})).toThrow(PlanRefusal);
    try {
      planGuard(BRAND)("POST", "/v1/billing/accounts/prepaid_checkout", {});
    } catch (err) {
      expect((err as PlanRefusal).toResult()).toMatchObject({ ok: false, refused: true, reason: "needs_account" });
      expect((err as PlanRefusal).message).toContain("start_sign_in");
    }
    expect(() => planGuard(BRAND)("POST", "/v1/brands", { url: "acme.com" })).not.toThrow();
  });
});

describe("websiteDomain", () => {
  it("reads the domain the way a person types it", () => {
    expect(websiteDomain("https://www.Acme.com/pricing")).toBe("acme.com");
    expect(websiteDomain("dutrou.com")).toBe("dutrou.com");
    expect(websiteDomain("not a site")).toBeNull();
    expect(websiteDomain("ftp://acme.com")).toBeNull();
    expect(websiteDomain(undefined)).toBeNull();
  });
});

describe("opening the unclaimed org: the signup page's own producer routes", () => {
  it("client-service resolve with anonymous: true, the throwaway id, the signup page's principal and the acquisition", async () => {
    const fetchImpl = vi.fn(async () => json(200, { orgId: "org-1", userId: "user-1", orgCreated: true, userCreated: false }));
    const r = await openUnclaimedOrg("anon_x", { channel: "website_chat" }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ orgId: "org-1", userId: "user-1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://client.test.local/internal/resolve");
    expect(JSON.parse(String(init.body))).toEqual({ externalOrgId: "anon_x", externalUserId: PLAN_PRINCIPAL, anonymous: true, acquisition: { channel: "website_chat" } });
    expect(PLAN_PRINCIPAL).toBe("system-anonymous-onboarding");
  });

  it("billing trial-seed, failing loud", async () => {
    const ok = vi.fn(async () => json(200, {}));
    await seedTrialCredit("org-1", { fetchImpl: ok as unknown as typeof fetch });
    expect((ok.mock.calls[0] as unknown as [string])[0]).toBe("https://billing.test.local/internal/accounts/by-org/org-1/trial-seed");
    const ko = vi.fn(async () => json(500, { error: "x" }));
    await expect(seedTrialCredit("org-1", { fetchImpl: ko as unknown as typeof fetch })).rejects.toThrow(/trial-seed 500/);
  });

  it("brand-service domain claim: an unreadable answer is 'unknown', never 'unclaimed'", async () => {
    const f = (r: Response | Error) => ({ fetchImpl: vi.fn(async () => { if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await domainClaim("acme.com", f(json(200, { claimed: true })))).toBe("claimed");
    expect(await domainClaim("acme.com", f(json(200, { claimed: false })))).toBe("unclaimed");
    expect(await domainClaim("acme.com", f(json(500, {})))).toBe("unknown");
    expect(await domainClaim("acme.com", f(json(200, { claimed: "no" })))).toBe("unknown");
    expect(await domainClaim("acme.com", f(new Error("down")))).toBe("unknown");
    err.mockRestore();
  });
});

function planDeps(over: Partial<GuestPlanDeps> & { stored?: PlanOrg | null; claim?: "claimed" | "unclaimed" | "unknown"; answer?: unknown } = {}) {
  let stored: PlanOrg | null = over.stored ?? null;
  const calls: ApiCallParams[] = [];
  const deps: GuestPlanDeps = {
    readPlan: async () => stored,
    savePlan: vi.fn(async (p: PlanOrg) => {
      stored = p;
    }),
    domainClaim: vi.fn(async () => over.claim ?? "unclaimed"),
    openOrg: vi.fn(async () => ({ orgId: "plan-org", userId: "plan-user" })),
    seedTrial: vi.fn(async () => {}),
    runFor: vi.fn(async () => "plan-run"),
    call: vi.fn(async (p: ApiCallParams) => {
      calls.push(p);
      return over.answer ?? { ok: true, status: 200, data: { brandId: BRAND, domain: "acme.com", name: "Acme", created: true } };
    }),
    ...over,
  };
  return { deps, calls, stored: () => stored };
}

describe("a guest's plan call (runGuestPlanCall)", () => {
  it("their website opens ONE unclaimed org for the conversation, seeded, and the brand is made AS that org", async () => {
    const t = planDeps();
    const r = await runGuestPlanCall({ method: "POST", path: "/v1/brands", body: { url: "https://www.acme.com" } }, t.deps);
    expect(brandIdOf(r)).toBe(BRAND);
    expect(t.deps.domainClaim).toHaveBeenCalledWith("acme.com");
    const ext = (t.deps.openOrg as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(ext.startsWith(PLAN_ORG_PREFIX)).toBe(true);
    expect(ext.slice(PLAN_ORG_PREFIX.length)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(t.deps.seedTrial).toHaveBeenCalledWith("plan-org");
    expect(t.calls[0]).toMatchObject({ orgId: "plan-org", userId: "plan-user", runId: "plan-run" });
    expect(typeof t.calls[0].guard).toBe("function");
    expect(t.stored()).toEqual({ orgId: "plan-org", userId: "plan-user", externalOrgId: ext, brandId: BRAND, domain: "acme.com" });
  });

  it("reuses the conversation's org on a later turn: nothing opened twice", async () => {
    const t = planDeps({ stored: { orgId: "plan-org", userId: "plan-user", externalOrgId: "anon_1", brandId: BRAND, domain: "acme.com" } });
    await runGuestPlanCall({ method: "POST", path: `/v1/brands/${BRAND}/icp/suggest`, body: { offerId: "o" } }, t.deps);
    await runGuestPlanCall({ method: "POST", path: "/v1/brands", body: { url: "acme.com" } }, t.deps);
    expect(t.deps.openOrg).not.toHaveBeenCalled();
    expect(t.deps.seedTrial).not.toHaveBeenCalled();
    expect(t.calls.map((c) => c.orgId)).toEqual(["plan-org", "plan-org"]);
    expect(t.calls[0].trackingHeaders).toEqual({ "x-brand-id": BRAND });
  });

  it("a website someone already set up is refused like the signup page: nothing opened, sign-in offered", async () => {
    const t = planDeps({ claim: "claimed" });
    const r = await runGuestPlanCall({ method: "POST", path: "/v1/brands", body: { url: "acme.com" } }, t.deps);
    expect(r).toMatchObject({ ok: false, refused: true, reason: "website_has_account" });
    expect((r as { message: string }).message).toContain("start_sign_in");
    expect(t.deps.openOrg).not.toHaveBeenCalled();
    expect(t.deps.call).not.toHaveBeenCalled();
  });

  it("a claim we could not check is refused too (never spend on a domain that may be a customer's)", async () => {
    const t = planDeps({ claim: "unknown" });
    expect(await runGuestPlanCall({ method: "POST", path: "/v1/brands", body: { url: "acme.com" } }, t.deps)).toMatchObject({ refused: true, reason: "could_not_check" });
    expect(t.deps.openOrg).not.toHaveBeenCalled();
  });

  it("a second website waits for the account", async () => {
    const t = planDeps({ stored: { orgId: "plan-org", userId: "plan-user", externalOrgId: "anon_1", brandId: BRAND, domain: "acme.com" } });
    expect(await runGuestPlanCall({ method: "POST", path: "/v1/brands", body: { url: "other.io" } }, t.deps)).toMatchObject({ refused: true, reason: "one_website" });
    expect(t.deps.call).not.toHaveBeenCalled();
  });

  it("before their website, nothing runs, and the brand needs a website", async () => {
    const t = planDeps();
    expect(await runGuestPlanCall({ method: "GET", path: "/v1/campaigns", body: undefined }, t.deps)).toMatchObject({ refused: true, reason: "plan_not_open" });
    expect(await runGuestPlanCall({ method: "POST", path: "/v1/brands", body: { name: "Acme" } }, t.deps)).toMatchObject({ refused: true, reason: "website_needed" });
    expect(t.deps.call).not.toHaveBeenCalled();
  });

  it("a refusal of the server's guard reaches the model as a result (paying waits for the account)", async () => {
    const t = planDeps({
      stored: { orgId: "plan-org", userId: "plan-user", externalOrgId: "anon_1", brandId: BRAND, domain: "acme.com" },
      call: async (p) => {
        p.guard!("POST", "/v1/billing/accounts/prepaid_checkout", { topup_amount_cents: 1000 });
        return { ok: true };
      },
    });
    expect(await runGuestPlanCall({ method: "POST", path: "/v1/billing/accounts/prepaid_checkout", body: {} }, t.deps)).toMatchObject({ refused: true, reason: "needs_account" });
  });

  it("an opening that fails (no advance landed) fails the call: never a plan on an org that cannot spend", async () => {
    const t = planDeps({ seedTrial: async () => { throw new Error("trial-seed 500"); } });
    await expect(runGuestPlanCall({ method: "POST", path: "/v1/brands", body: { url: "acme.com" } }, t.deps)).rejects.toThrow(/trial-seed/);
    expect(t.stored()).toBeNull();
    expect(t.deps.call).not.toHaveBeenCalled();
  });
});

describe("the guest's lines state the plan before the account (one builder, every channel)", () => {
  it("a guest that can sign in reads the plan strategy; one that cannot does not", () => {
    const can = identityLines({ guest: true, place: "This conversation", numberKnown: false, canSignIn: true }).join("\n");
    const cannot = identityLines({ guest: true, place: "This conversation", numberKnown: false, canSignIn: false }).join("\n");
    expect(can).toContain(PLAN_BEFORE_ACCOUNT);
    expect(cannot).not.toContain(PLAN_BEFORE_ACCOUNT);
    const known = identityLines({ guest: true, place: "This WhatsApp number", numberKnown: true, canSignIn: true, knownEmails: ["a@b.io"] }).join("\n");
    expect(known).toContain(PLAN_BEFORE_ACCOUNT);
  });

  it("states the strategy, never a canned reply", () => {
    expect(PLAN_BEFORE_ACCOUNT).toContain("new-account skill's steps 1 to 5");
    expect(PLAN_BEFORE_ACCOUNT).not.toMatch(/Say "|reply with/i);
  });
});
