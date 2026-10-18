import { describe, it, expect, vi, beforeEach } from "vitest";
import { completeSignIn, startSignIn } from "../../src/lib/channel-sign-in.js";

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
