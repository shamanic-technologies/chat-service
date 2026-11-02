import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { REACH_ELSEWHERE_TOOL, buildHandleBody, personKeyOf, reachPersonElsewhere } from "../../src/lib/lead-contact.js";
import type { LeadTurnRequest } from "../../src/schemas.js";

const BRAND = "22222222-2222-4222-8222-222222222222";
const PAYLOAD: LeadTurnRequest = {
  idempotencyKey: "occ-1",
  brandId: BRAND,
  medium: "whatsapp",
  recipient: { email: "t@x.co", phone: "+33600000001", name: "Tahmid" },
  assistant: null,
  systemPrompt: "GAME",
  message: "THREAD",
  responseSchema: { type: "object", properties: { message: { type: "string" } } },
  messageField: "message",
};
const CALLER = { orgId: "org-brand", userId: "user-line", runId: "run-writer" };

beforeEach(() => {
  process.env.CRM_SERVICE_URL = "http://crm";
  process.env.CRM_SERVICE_API_KEY = "k";
});
afterEach(() => {
  delete process.env.CRM_SERVICE_URL;
  delete process.env.CRM_SERVICE_API_KEY;
});

describe("reach_person_elsewhere", () => {
  it("is called before the answer, for a handle the person gave", () => {
    expect(REACH_ELSEWHERE_TOOL.description).toContain("BEFORE answer_person");
    expect(REACH_ELSEWHERE_TOOL.description).toContain("THEY gave");
  });

  it("names the person by the number first, then the email", () => {
    expect(personKeyOf(PAYLOAD.recipient)).toBe("phone:+33600000001");
    expect(personKeyOf({ email: " T@X.co ", phone: null, name: null })).toBe("email:t@x.co");
  });

  it("states exactly one handle, preferred, with the person's words", () => {
    const built = buildHandleBody({ phone: "+8801952666418", channel: "WhatsApp", reason: "reach me here" }, PAYLOAD);
    expect(built).toEqual({
      ok: true,
      body: {
        brandId: BRAND,
        personKey: "phone:+33600000001",
        phone: "+8801952666418",
        preferred: true,
        channel: "whatsapp",
        reason: "reach me here",
        evidence: { source: "lead_turn", channel: "whatsapp", text: "reach me here" },
      },
    });
    expect(buildHandleBody({}, PAYLOAD)).toMatchObject({ ok: false, refused: { reason: "one_handle" } });
    expect(buildHandleBody({ phone: "+1", email: "a@b.co" }, PAYLOAD)).toMatchObject({ ok: false });
  });

  it("calls crm as the writing brand (caller org and run), never as the person", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ handle: { handle: "+8801952666418", kind: "phone", preferred: true }, duplicate: false, whatsapp: { status: "found" } }), { status: 201 }),
    );
    const out = await reachPersonElsewhere({ phone: "+8801952666418" }, { payload: PAYLOAD, caller: CALLER }, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://crm/orgs/people/handles");
    expect(init.headers).toMatchObject({ "x-org-id": "org-brand", "x-user-id": "user-line", "x-run-id": "run-writer", "x-brand-id": BRAND });
    expect(out).toMatchObject({ stated: true, handle: "+8801952666418", kind: "phone", alreadyStated: false, onWhatsapp: "found" });
  });

  it("a crm refusal is an answer for the model; any other failure throws", async () => {
    const refused = vi.fn().mockResolvedValue(new Response(JSON.stringify({ type: "refused", reason: "invalid_handle", error: "not a number" }), { status: 422 }));
    expect(await reachPersonElsewhere({ phone: "123" }, { payload: PAYLOAD, caller: CALLER }, refused as unknown as typeof fetch)).toMatchObject({
      refused: true,
      reason: "invalid_handle",
    });
    const boom = vi.fn().mockResolvedValue(new Response("down", { status: 500 }));
    await expect(reachPersonElsewhere({ phone: "+8801952666418" }, { payload: PAYLOAD, caller: CALLER }, boom as unknown as typeof fetch)).rejects.toThrow("500");
  });
});
