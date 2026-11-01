import { describe, it, expect, vi } from "vitest";
import {
  THREAD_MESSAGE_MAX_CHARS,
  buildChannelBlock,
  VOICE_NOTE_PREFIX,
  VOICE_NOTE_UNREADABLE,
  parseChatStream,
  renderChannelReply,
  toWhatsappText,
  CHANNEL_FAILURE_TEXT,
  channelReplyDays,
  type ChatChannelContext,
} from "../../src/lib/channel-copilot.js";

const MSG = {
  channel: "whatsapp",
  messageId: "$evt-1",
  orgId: "11111111-1111-4111-8111-111111111111",
  brandId: "22222222-2222-4222-8222-222222222222",
  accountUserId: "33333333-3333-4333-8333-333333333333",
  fromAccount: "+77776879632",
  assistant: { name: "Sophie", role: "Distribute.you Assistant", instructions: null },
  sender: { phone: "+33680478702", name: "Kevin" },
  text: "list my campaigns",
  at: "2026-10-18T10:00:00.000Z",
  thread: [{ at: "2026-10-17T10:00:00.000Z", direction: "outbound" as const, text: "Hi from our campaign" }],
};

const sse = (...events: unknown[]) => events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");

describe("parseChatStream", () => {
  it("collects tokens, choices, input requests, out-of-credits and errors", () => {
    const body = sse(
      { sessionId: "s" },
      { type: "token", content: "You have " },
      { type: "token", content: "2 campaigns." },
      { type: "choices", question: "Next?", choices: [{ label: "Stop one", value: "x" }, { label: "Add one", description: "new", value: "y" }], allowFreeText: true },
      { type: "credits_required", message: "You're out of credits.", action: "add_credits", label: "Add credits" },
      "[DONE]",
    );
    const r = parseChatStream(body);
    expect(r.text).toBe("You have 2 campaigns.");
    expect(r.choices?.choices).toEqual([{ label: "Stop one" }, { label: "Add one", description: "new" }]);
    expect(r.creditsRequired).toEqual({ message: "You're out of credits.", label: "Add credits" });
    expect(r.error).toBeNull();
  });

  it("reads CRLF framing and an error event", () => {
    const r = parseChatStream(`data: {"type":"error","message":"boom"}\r\n\r\ndata: [DONE]\r\n\r\n`);
    expect(r.error).toBe("boom");
  });
});

describe("toWhatsappText", () => {
  it("turns markdown into WhatsApp markup and never lets a long dash out", () => {
    expect(toWhatsappText("## Title\n**Bold** — and [the page](https://x.io/a) – ok")).toBe("*Title*\n*Bold*, and the page: https://x.io/a, ok");
  });
});

describe("renderChannelReply", () => {
  it("lists choices by number, with no name header (owner: a bare name line reads as a robot)", () => {
    const text = renderChannelReply({ text: "Pick one:", choices: { choices: [{ label: "A" }, { label: "B" }] }, inputLabel: null, creditsRequired: null, error: null });
    expect(text).toBe("Pick one:\n\n1. A\n2. B");
  });

  it("out of credits gives the link to add credits", () => {
    const text = renderChannelReply(
      { text: "You're out of credits. Add credits to keep going.", choices: null, inputLabel: null, creditsRequired: { message: "You're out of credits. Add credits to keep going.", label: "Add credits" }, error: null },
    );
    expect(text).toContain("Add credits: https://dashboard.distribute.you");
  });

  it("an empty answer is never sent empty", () => {
    expect(renderChannelReply({ text: "", choices: null, inputLabel: null, creditsRequired: null, error: null })).toBe(CHANNEL_FAILURE_TEXT);
  });
});

describe("buildChannelBlock", () => {
  const channel: ChatChannelContext = { kind: "whatsapp", assistant: MSG.assistant, sender: MSG.sender, thread: MSG.thread };

  it("names the assistant from the persona and shows the thread, campaign sends included", () => {
    const block = buildChannelBlock(channel, false);
    expect(block).toContain("as Sophie, Distribute.you Assistant");
    expect(block).toContain("never as a header");
    expect(block).toContain("us: Hi from our campaign");
    expect(block).toContain("exactly this person's access");
  });

  // SOPHIE-NO-ANSWER-1028: 5 Threads drafts we sent (~1,700 chars) were cut at
  // 600, the Copilot saw 1.3 of them and hunted through 15 tools.
  it("shows a whole message we sent, not its first lines", () => {
    const drafts = Array.from({ length: 5 }, (_, i) => `*${i + 1}/* ${"draft words ".repeat(28)}Get started: distribute.you`).join("\n\n");
    expect(drafts.length).toBeGreaterThan(1500);
    const block = buildChannelBlock({ ...channel, thread: [{ at: "2026-10-27T19:37:20.146Z", direction: "outbound", text: drafts }] }, false);
    expect(block).toContain("*5/*");
    expect(block.match(/Get started: distribute\.you/g)).toHaveLength(5);
    const huge = "x".repeat(THREAD_MESSAGE_MAX_CHARS + 500);
    const capped = buildChannelBlock({ ...channel, thread: [{ at: "2026-10-27T19:37:20.146Z", direction: "outbound", text: huge }] }, false);
    expect(capped).toContain("x".repeat(THREAD_MESSAGE_MAX_CHARS));
    expect(capped).not.toContain("x".repeat(THREAD_MESSAGE_MAX_CHARS + 1));
  });

  it("reads a transcribed voice note as their message, an unreadable one as a request to write, and always answers in text (SOPHIE-VOICE-1019)", () => {
    const block = buildChannelBlock(channel, false);
    expect(block).toContain(`${VOICE_NOTE_PREFIX} followed by words is what they SAID`);
    expect(block).toContain(`${VOICE_NOTE_UNREADABLE} means a voice note we could not understand`);
    expect(block).toContain("Always answer in text");
    // Byte-equal to what crm-service writes (src/lib/matrix/voice-notes.ts there).
    expect(VOICE_NOTE_PREFIX).toBe("🎤 Voice note:");
    expect(VOICE_NOTE_UNREADABLE).toBe("🎤 Voice note (could not be understood)");
  });

  it("a guest is told it sees no account and how to sign in", () => {
    const block = buildChannelBlock(channel, true);
    expect(block).toContain("NOT tied to any distribute.you account");
    expect(block).toContain("start_sign_in");
  });

  // SOPHIE-WA-SIGNED-IN-1029: "free trial? pricing?" was put behind a sign-in,
  // then "send me a quick ok and I'll come back".
  it("a guest answers a public question at once, and a sign-in never costs the person a message", () => {
    for (const block of [buildChannelBlock(channel, true), buildChannelBlock({ ...channel, sender: { ...channel.sender, knownEmails: ["a@b.co"] } }, true)]) {
      expect(block).toContain("Answer every question about distribute.you at once");
      expect(block).toContain("never put a sign-in in front of them");
      expect(block).toContain("right after complete_sign_in succeeds, you answer again with their account's access");
      expect(block).toContain("never ask them to send anything");
      expect(block).not.toContain("From their next message");
    }
  });

  it("the turn right after a sign-in answers the pending question, without a new greeting", () => {
    const block = buildChannelBlock({ ...channel, afterSignIn: true }, false);
    expect(block).toContain("Answer now, with that access, what they asked before signing in");
    expect(buildChannelBlock(channel, false)).not.toContain("what they asked before signing in");
  });

  // COPILOT-WA-REPEAT-1027: the prod thread of 2026-10-27 (a signup we wrote to first, then called).
  const known: ChatChannelContext = {
    ...channel,
    sender: { phone: "+15550001111", name: "Staff Test", knownEmails: ["staff-test@distribute.you"] },
    thread: [
      { at: "2026-10-27T13:58:29.658Z", direction: "outbound", text: "You can start from $1 a day if you want to test the water." },
      { at: "2026-10-27T14:20:00.000Z", direction: "outbound", text: "Missed voice call", kind: "call" },
    ],
  };

  it("a guest we already know is never asked for their email: the Copilot signs in with the email we hold", () => {
    const block = buildChannelBlock(known, true);
    expect(block).toContain("our own records tie their number to staff-test@distribute.you");
    expect(block).toContain("Never ask who they are or for their email");
    expect(block).toContain("call start_sign_in with that email yourself");
    expect(block).toContain("When their next step needs their account");
    expect(block).not.toContain("ask for their email (once)");
  });

  it("a known account is told it knows who they are", () => {
    expect(buildChannelBlock(known, false)).toContain("never ask for their email or name");
  });

  it("shows a call as a call and reads a person's call remark as about OUR call", () => {
    const block = buildChannelBlock(known, true);
    expect(block).toContain("us [call]: Missed voice call");
    expect(block).toContain("it is about a call from our team, even when the thread shows none");
    expect(block).toContain("never say no call was needed");
  });

  it("explains the strategy against repeating itself, and never licenses an offer term from the thread", () => {
    const block = buildChannelBlock(known, true);
    expect(block).toContain("Never send again something you already said");
    expect(block).toContain("one short warm line that still leaves their next step one click away");
    expect(block).toContain("Every message moves them one step from where they stopped");
    expect(block).toContain("Never repeat a price, amount or offer term from the thread");
  });

  // SOPHIE-INTRODUCES-HERSELF-ON-HER-LINE-1029: the person answered the founder's
  // hello on the founder's own number; the Copilot answers from its own line.
  const FOUNDER = "+15550002222";
  const founderLine: ChatChannelContext = {
    ...channel,
    sender: { phone: "+15550001111", name: "Staff Test" },
    receivedOn: { account: FOUNDER, name: "Kevin", role: "Founder" },
    thread: [
      { at: "2026-10-29T09:00:00.000Z", direction: "outbound", text: "Hi, Kevin from distribute.you here", account: FOUNDER },
      { at: "2026-10-29T09:05:00.000Z", direction: "inbound", text: "Hi Kevin, tell me more", account: FOUNDER },
    ],
  };

  it("names the founder line, the switch to its own number, and asks for one introduction", () => {
    const block = buildChannelBlock(founderLine, true);
    expect(block).toContain(`The person wrote to Kevin (Founder)'s number ${FOUNDER}, not to yours`);
    expect(block).toContain("You answer from YOUR own number, which is new to them");
    expect(block).toContain("you introduce yourself once, before you answer: who you are, Kevin's assistant");
    expect(block).toContain('"Hi, Sophie here, Kevin\'s assistant, following up on the message from Kevin"');
    expect(block).toContain("Never pretend to be Kevin: you are Sophie");
    expect(block).toContain(`us on Kevin (Founder)'s number ${FOUNDER}: Hi, Kevin from distribute.you here`);
    expect(block).toContain(`them on Kevin (Founder)'s number ${FOUNDER}: Hi Kevin, tell me more`);
    expect(block).toContain("never you. Lines with no number happened on your number.");
  });

  it("a line on another number without receivedOn is still not ours", () => {
    const block = buildChannelBlock({ ...founderLine, receivedOn: undefined }, false);
    expect(block).not.toContain("introduce yourself once");
    expect(block).toContain(`us on ${FOUNDER}: Hi, Kevin from distribute.you here`);
    expect(block).toContain('A thread line marked "on <number>" happened on another of our numbers');
  });

  it("without the two facts the block is byte-identical to before (sha256 of the pre-change output)", async () => {
    const { createHash } = await import("node:crypto");
    const legacy: ChatChannelContext = {
      ...channel,
      sender: { phone: "+33680478702", name: "Kevin" },
      thread: [
        { at: "2026-10-17T10:00:00.000Z", direction: "outbound", text: "Hi from our campaign" },
        { at: "2026-10-27T14:20:00.000Z", direction: "outbound", text: "Missed voice call", kind: "call" },
      ],
    };
    const sha = (g: boolean, c: ChatChannelContext) => createHash("sha256").update(buildChannelBlock(c, g)).digest("hex");
    // Signed-in block re-pinned by SOPHIE-WA-ONBOARD-1101 (the chat sets up an account end to end, never a dashboard hand-off).
    expect(sha(false, legacy)).toBe("f17091d7090595511372cb3db731e47e3d19905de9bd39796a1e0ffab714cc42");
    expect(sha(true, legacy)).toBe("cab705574c507f363b38b861955aeb55d502be40960a41ddfb54883feee7599d");
    expect(sha(true, { ...legacy, receivedOn: null })).toBe("cab705574c507f363b38b861955aeb55d502be40960a41ddfb54883feee7599d");
  });

  it("carries no hard-coded assistant name", () => {
    const block = buildChannelBlock({ ...channel, assistant: { name: "Ada", role: null, instructions: null } }, false);
    expect(block).toContain("as Ada.");
    expect(block).not.toContain("Sophie");
  });
});

// A scripted db: each select answers the next scripted result.
function fakeDb(script: { selects: unknown[][]; inserts: unknown[][] }) {
  return {
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve(script.selects.shift() ?? []) }) }),
    },
  };
}

describe("channelReplyDays", () => {
  it("one row per UTC day, zeros included; delivered = sent, not delivered = ended without a send", async () => {
    const { db } = fakeDb({
      selects: [[
        { createdAt: new Date("2026-10-29T08:00:00Z"), status: "answered", sentAt: new Date("2026-10-29T08:01:00Z") },
        { createdAt: new Date("2026-10-29T09:00:00Z"), status: "failed", sentAt: null },
        { createdAt: new Date("2026-10-29T10:00:00Z"), status: "processing", sentAt: null },
        { createdAt: new Date("2026-10-27T10:00:00Z"), status: "failed", sentAt: new Date("2026-10-27T10:01:00Z") },
        // The team already wrote by hand: crm refused the send, nothing is broken.
        { createdAt: new Date("2026-10-28T10:00:00Z"), status: "failed", sentAt: null, error: 'send: crm-service whatsapp send 422: {"type":"refused","code":"human_in_conversation","error":"..."}' },
      ]],
      inserts: [],
    });
    const days = await channelReplyDays(db as unknown as Parameters<typeof channelReplyDays>[0], 3, new Date("2026-10-29T12:00:00Z"));
    expect(days).toEqual([
      { day: "2026-10-27", received: 1, delivered: 1, notDelivered: 0 },
      { day: "2026-10-28", received: 1, delivered: 0, notDelivered: 0 },
      { day: "2026-10-29", received: 3, delivered: 1, notDelivered: 1 },
    ]);
  });
});
