import { describe, it, expect, vi, beforeEach } from "vitest";
import { COMPLETE_SIGN_IN_TOOL, START_SIGN_IN_TOOL, completeSignIn, parseTypedPhone, startSignIn } from "../../src/lib/channel-sign-in.js";

beforeEach(() => {
  process.env.CLIENT_SERVICE_URL = "https://client.test.local";
  process.env.CLIENT_SERVICE_API_KEY = "k";
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("startSignIn", () => {
  it("sends the code to the email with the session's number", async () => {
    const fetchImpl = vi.fn(async () => json(200, { expiresAt: "2026-10-18T10:15:00Z" }));
    const r = await startSignIn(" Kevin@Distribute.you ", "+33680478702", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, codeSentTo: "kevin@distribute.you" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://client.test.local/internal/agent-signups/start");
    expect(JSON.parse(String(init.body))).toEqual({ email: "kevin@distribute.you", phone: "+33680478702" });
  });

  it("a bad email reaches the model as data", async () => {
    const fetchImpl = vi.fn(async () => json(400, { error: "invalid_request", message: "email: bad" }));
    expect(await startSignIn("x", "+33680478702", { fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ ok: false, error: "invalid_request" });
  });
});

describe("completeSignIn", () => {
  it("proves the email and ties the WhatsApp number in the same call", async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { orgId: "o", userId: "u", email: "kevin@distribute.you", created: false, whatsappPhone: "+33680478702", whatsappPhoneMovedFromUserId: null }),
    );
    const r = await completeSignIn("kevin@distribute.you", "123 456", "+33680478702", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, account: { orgId: "o", userId: "u", email: "kevin@distribute.you", created: false } });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ email: "kevin@distribute.you", code: "123456", whatsappPhone: "+33680478702" });
  });

  it("a completion that did not bind the number fails loud", async () => {
    const fetchImpl = vi.fn(async () => json(200, { orgId: "o", userId: "u", email: "e", created: true }));
    await expect(completeSignIn("e@x.io", "123456", "+33680478702", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/binding the number/);
  });

  it("a wrong code is an answer the person can act on", async () => {
    const fetchImpl = vi.fn(async () => json(400, { error: "code_invalid", message: "Wrong code.", attemptsLeft: 3 }));
    expect(await completeSignIn("e@x.io", "000000", "+33680478702", { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      ok: false,
      error: "code_invalid",
      message: "Wrong code.",
      attemptsLeft: 3,
    });
  });

  it("a client-service outage throws", async () => {
    const fetchImpl = vi.fn(async () => json(502, { error: "identity_provider_failed" }));
    await expect(completeSignIn("e@x.io", "123456", "+33680478702", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/502/);
  });
});

// DISTRY-ONE-AI-1118 (owner 2026-11-18: « on peut onboarder des gens depuis le widget sans qu'ils aient
// besoin d'aller sur la page signup »): the same sign-in on every channel; only the phone differs.
describe("sign-in is one path on every channel; the channel changes the phone only (DISTRY-ONE-AI-1118)", () => {
  it("the tools read the same wherever the conversation is: nothing says it works on WhatsApp only", () => {
    for (const tool of [START_SIGN_IN_TOOL, COMPLETE_SIGN_IN_TOOL]) {
      expect(tool.description).not.toMatch(/talking to on WhatsApp|WhatsApp number is tied/);
    }
    expect(START_SIGN_IN_TOOL.description).toContain("right here in this conversation");
    expect(START_SIGN_IN_TOOL.description).toContain("when this conversation is on WhatsApp the number is already known");
    expect(COMPLETE_SIGN_IN_TOOL.description).toContain("this conversation is tied to that account");
    expect(Object.keys((START_SIGN_IN_TOOL.input_schema as { properties: object }).properties)).toEqual(["email", "phone"]);
    expect((START_SIGN_IN_TOOL.input_schema as { required: string[] }).required).toEqual(["email"]);
  });

  it("a number the person types is read in international form, or refused in words the model can act on", () => {
    expect(parseTypedPhone("+33 6 12 34 56 78")).toEqual({ ok: true, phone: "+33612345678" });
    expect(parseTypedPhone("0033 (6) 12-34-56-78")).toEqual({ ok: true, phone: "+33612345678" });
    expect(parseTypedPhone("06 12 34 56 78")).toMatchObject({ ok: false, refused: { ok: false, error: "unreadable_number" } });
    expect(parseTypedPhone(undefined)).toMatchObject({ ok: false, refused: { ok: false, error: "phone_needed" } });
  });

  it("on our website the number was typed, verified by nothing: the completion sends NO whatsappPhone, so no number changes hands", async () => {
    const fetchImpl = vi.fn(async () => json(200, { orgId: "o", userId: "u", email: "ann@acme.io", created: true }));
    const r = await completeSignIn("Ann@Acme.io", "123456", null, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, account: { orgId: "o", userId: "u", email: "ann@acme.io", created: true } });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ email: "ann@acme.io", code: "123456" });
  });
});

// DISTRY-ONE-AI-1118 B (owner plan 2026-11-19): a guest's plan was built on an unclaimed org; the
// email proof hands THAT org over (client-service claimOrgId + claimOrgExternalId), never an
// agent_api org of their own.
describe("completeSignIn with the plan's org", () => {
  const claim = { orgId: "11111111-1111-4111-8111-111111111111", externalOrgId: "anon_22222222-2222-4222-8222-222222222222" };
  const deps = (fetchImpl: unknown) => ({ fetchImpl: fetchImpl as typeof fetch });

  it("sends both ids with the proof and returns the claimed org", async () => {
    const fetchImpl = vi.fn(async () => json(200, { orgId: claim.orgId, userId: "u", email: "ann@acme.io", created: true, claimedOrgId: claim.orgId, orgClaim: "claimed", billingSettled: true }));
    const r = await completeSignIn("ann@acme.io", "123456", null, deps(fetchImpl), claim);
    expect(r).toEqual({ ok: true, account: { orgId: claim.orgId, userId: "u", email: "ann@acme.io", created: true } });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ email: "ann@acme.io", code: "123456", claimOrgId: claim.orgId, claimOrgExternalId: claim.externalOrgId });
  });

  it("redeems the same proof again while billing has not settled the handover, then goes on (the org is theirs)", async () => {
    const answers = [false, false, false].map((settled) => json(200, { orgId: claim.orgId, userId: "u", email: "e", created: false, orgClaim: "already_claimed", billingSettled: settled }));
    const fetchImpl = vi.fn(async () => answers.shift()!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await completeSignIn("e@x.io", "123456", null, deps(fetchImpl), claim);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ ok: true, account: { orgId: claim.orgId } });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stops redeeming once billing settled", async () => {
    const answers = [false, true].map((settled) => json(200, { orgId: claim.orgId, userId: "u", email: "e", created: true, orgClaim: "claimed", billingSettled: settled }));
    const fetchImpl = vi.fn(async () => answers.shift()!);
    await completeSignIn("e@x.io", "123456", null, deps(fetchImpl), claim);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("relays the handover's refusals (403 / 409) as results the person hears, never a fresh org", async () => {
    for (const [status, error] of [[403, "org_external_id_mismatch"], [409, "org_already_claimed"], [409, "org_slug_taken"], [404, "org_not_found"]] as const) {
      const fetchImpl = vi.fn(async () => json(status, { error, message: `refused: ${error}` }));
      expect(await completeSignIn("e@x.io", "123456", null, deps(fetchImpl), claim)).toEqual({ ok: false, error, message: `refused: ${error}` });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses an answer naming another org than the claimed one", async () => {
    const fetchImpl = vi.fn(async () => json(200, { orgId: "33333333-3333-4333-8333-333333333333", userId: "u", email: "e", created: true, billingSettled: true }));
    await expect(completeSignIn("e@x.io", "123456", null, deps(fetchImpl), claim)).rejects.toThrow(/not the claimed plan org/);
  });
});
