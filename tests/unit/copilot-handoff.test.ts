import { describe, expect, it } from "vitest";
import { emailHelloAct, personPhone, startsWaitingCampaign } from "../../src/lib/copilot-handoff.js";
import { buildHelloTriggerMessage } from "../../src/lib/copilot-proactive.js";
import { assemblePrompt, codePromptOverrides, emptyTurnPromptData } from "../../src/agent/distry-prompt.js";
import { OUR_WHATSAPP_URL } from "../../src/lib/distry-spend.js";

const C = "11111111-2222-4333-8444-555555555555";

describe("startsWaitingCampaign: only the one start the signup's yes covers", () => {
  it("matches PATCH activate on the waiting campaign", () => {
    expect(startsWaitingCampaign({ method: "PATCH", path: `/v1/sales-funnel-campaigns/${C}`, body: { status: "activate" } }, C)).toBe(true);
  });
  it("refuses any other campaign, method, body or no waiting campaign", () => {
    expect(startsWaitingCampaign({ method: "PATCH", path: "/v1/sales-funnel-campaigns/other", body: { status: "activate" } }, C)).toBe(false);
    expect(startsWaitingCampaign({ method: "PATCH", path: `/v1/sales-funnel-campaigns/${C}`, body: { status: "stop" } }, C)).toBe(false);
    expect(startsWaitingCampaign({ method: "PATCH", path: `/v1/sales-funnel-campaigns/${C}`, body: { status: "activate", maxBudgetUsd: 500 } }, C)).toBe(false);
    expect(startsWaitingCampaign({ method: "POST", path: `/v1/sales-funnel-campaigns/${C}`, body: { status: "activate" } }, C)).toBe(false);
    expect(startsWaitingCampaign({ method: "PATCH", path: `/v1/sales-funnel-campaigns/${C}`, body: { status: "activate" } }, null)).toBe(false);
    expect(startsWaitingCampaign(null, C)).toBe(false);
  });
});

describe("personPhone", () => {
  it("prefers the linked number, then the one typed at signup", () => {
    expect(personPhone({ phone: "+33600000001", onboardingPhone: "+33600000002" })).toBe("+33600000001");
    expect(personPhone({ phone: null, onboardingPhone: "+33600000002" })).toBe("+33600000002");
    expect(personPhone({ phone: " ", onboardingPhone: null })).toBeNull();
    expect(personPhone(null)).toBeNull();
  });
});

describe("hello words", () => {
  it("the WhatsApp hello says the answer is the go only while a campaign waits", () => {
    expect(buildHelloTriggerMessage({ kind: "hello", channel: "whatsapp", campaignWaiting: true })).toMatch(/starts as soon as they answer/);
    expect(buildHelloTriggerMessage({ kind: "hello", channel: "whatsapp", campaignWaiting: false })).toMatch(/finish their setup here/);
    expect(buildHelloTriggerMessage({ kind: "hello", channel: "whatsapp", campaignWaiting: true })).not.toMatch(/—/);
  });
  it("the email hand-off files their act, and says a reply starts the waiting campaign", () => {
    expect(emailHelloAct(true)).toMatch(/continue with Distry by email.*waits for my first reply/);
    expect(emailHelloAct(false)).not.toMatch(/waits/);
  });
});

describe("waiting-campaign prompt part", () => {
  it("is sent only when a campaign waits, naming its start request", () => {
    const none = assemblePrompt(codePromptOverrides(), emptyTurnPromptData("ROLE"));
    expect(JSON.stringify(none)).not.toContain("is waiting for them");
    const withIt = assemblePrompt(codePromptOverrides(), { ...emptyTurnPromptData("ROLE"), waitingCampaignId: C });
    expect(JSON.stringify(withIt)).toContain(`/v1/sales-funnel-campaigns/${C}`);
  });
});

describe("our WhatsApp line", () => {
  it("is the live line +33 6 80 47 87 02 (crm sends from it), never the …402 typo", () => {
    expect(OUR_WHATSAPP_URL).toBe("https://wa.me/33680478702");
  });
});
