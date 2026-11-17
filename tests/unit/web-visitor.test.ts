import { describe, it, expect } from "vitest";
import {
  WEB_ASK_CONTACT_AFTER,
  WEB_MAX_VISITOR_MESSAGES,
  buildWebBlock,
  parseContinueArgs,
  webSignals,
  webTurnOutcome,
} from "../../src/lib/web-visitor.js";
import { CHANNEL_FAILURE_TEXT } from "../../src/lib/channel-copilot.js";
import { turnKeyOf } from "../../src/lib/turn-queue.js";

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

describe("web visitor (DISTRY-WEB-CHAT-1117)", () => {
  it("the web block is the page's FORM and the hand-off, never a second prompt: no account, plain text, our start link", () => {
    const block = buildWebBlock({ whatsapp: null });
    expect(block).toContain("Channel: our website");
    expect(block).toContain("plain text only");
    expect(block).toContain("no account you can read");
    expect(block).toContain("continue_on_channel");
    expect(block).not.toMatch(/[—–]/);
  });

  it("once their number is tied, the block says so and never asks for it again", () => {
    const block = buildWebBlock({ whatsapp: "+33612345678" });
    expect(block).toContain("+33612345678");
    expect(block).toContain("Never ask for it again");
    expect(block).not.toContain(`call continue_on_channel`);
  });

  it("a number is read in international form, spaces and 00 prefix included; anything else is refused for the model", () => {
    expect(parseContinueArgs({ phone: "+33 6 12 34 56 78" })).toEqual({ ok: true, phone: "+33612345678" });
    expect(parseContinueArgs({ phone: "0033 (6) 12-34-56-78" })).toEqual({ ok: true, phone: "+33612345678" });
    const refused = parseContinueArgs({ phone: "06 12 34 56 78" });
    expect(refused.ok).toBe(false);
    expect(parseContinueArgs({}).ok).toBe(false);
  });

  it("the page is told to ask for a number after a few answers, and how many answers are left", () => {
    expect(webSignals({ visitorMessages: 0, whatsapp: null })).toEqual({ askForContact: false, messagesLeft: WEB_MAX_VISITOR_MESSAGES, continuedOn: null });
    expect(webSignals({ visitorMessages: WEB_ASK_CONTACT_AFTER, whatsapp: null }).askForContact).toBe(true);
    expect(webSignals({ visitorMessages: WEB_MAX_VISITOR_MESSAGES + 3, whatsapp: null }).messagesLeft).toBe(0);
    expect(webSignals({ visitorMessages: 40, whatsapp: "+33612345678" })).toEqual({ askForContact: false, messagesLeft: null, continuedOn: "whatsapp" });
  });

  it("the answer reaches the page as plain text; a failed or empty turn is said in one line, never a silent 200", () => {
    expect(webTurnOutcome(200, sse([{ type: "token", content: "See **pricing** at [our site](https://distribute.you/pricing) — it is simple." }]))).toEqual({
      reply: "See pricing at our site: https://distribute.you/pricing, it is simple.",
      failure: null,
    });
    expect(webTurnOutcome(500, "boom")).toMatchObject({ reply: CHANNEL_FAILURE_TEXT });
    expect(webTurnOutcome(200, sse([])).failure).toBe("the turn answered nothing");
    expect(webTurnOutcome(200, sse([{ type: "error", message: "x" }])).failure).toContain("x");
  });

  it("each visitor is its own conversation in the turn queue, never queued behind our line's own user", () => {
    const identity = { orgId: "org", userId: "user" };
    expect(turnKeyOf({ webVisitorId: "v_aaaaaaaaaaaaaaaa", channelMessageId: "x" }, identity)).toBe("web:v_aaaaaaaaaaaaaaaa");
    expect(turnKeyOf({ webVisitorId: "v_bbbbbbbbbbbbbbbb", channelMessageId: "x" }, identity)).not.toBe(turnKeyOf({ webVisitorId: "v_aaaaaaaaaaaaaaaa" }, identity));
    expect(turnKeyOf({ message: "hi" }, identity)).toBe("person:org:user");
  });
});
