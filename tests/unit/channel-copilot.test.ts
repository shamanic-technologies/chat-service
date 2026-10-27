import { describe, it, expect, vi } from "vitest";
import {
  buildChannelBlock,
  VOICE_NOTE_PREFIX,
  VOICE_NOTE_UNREADABLE,
  parseChatStream,
  processChannelMessage,
  renderChannelReply,
  toWhatsappText,
  CHANNEL_FAILURE_TEXT,
  type ChannelDeps,
  type ChatChannelContext,
} from "../../src/lib/channel-copilot.js";
import type { ChannelMessageRequest } from "../../src/schemas.js";
import { ChannelMessageRequestSchema } from "../../src/schemas.js";

const MSG: ChannelMessageRequest = {
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
  thread: [{ at: "2026-10-17T10:00:00.000Z", direction: "outbound", text: "Hi from our campaign" }],
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

  it("carries no hard-coded assistant name", () => {
    const block = buildChannelBlock({ ...channel, assistant: { name: "Ada", role: null, instructions: null } }, false);
    expect(block).toContain("as Ada.");
    expect(block).not.toContain("Sophie");
  });
});

describe("ChannelMessageRequestSchema", () => {
  it("accepts crm's body and refuses a number that is not E.164", () => {
    expect(ChannelMessageRequestSchema.safeParse(MSG).success).toBe(true);
    expect(ChannelMessageRequestSchema.safeParse({ ...MSG, sender: { phone: "0680478702" } }).success).toBe(false);
  });

  it("keeps the sender's known emails and call lines crm sends (COPILOT-WA-REPEAT-1027)", () => {
    const parsed = ChannelMessageRequestSchema.parse({
      ...MSG,
      sender: { ...MSG.sender, knownEmails: ["staff-test@distribute.you"] },
      thread: [...MSG.thread, { at: "2026-10-27T14:20:00.000Z", direction: "outbound", text: "Missed voice call", kind: "call" }],
    });
    expect(parsed.sender.knownEmails).toEqual(["staff-test@distribute.you"]);
    expect(parsed.thread[parsed.thread.length - 1].kind).toBe("call");
    expect(ChannelMessageRequestSchema.safeParse({ ...MSG, sender: { ...MSG.sender, knownEmails: ["not-an-email"] } }).success).toBe(false);
  });
});

// A scripted db: each select/update/insert answers the next scripted result.
function fakeDb(script: { selects: unknown[][]; inserts: unknown[][] }) {
  const updates: Array<Record<string, unknown>> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const chain = (result: unknown[]) => {
    const p: Record<string, unknown> = {};
    for (const k of ["from", "where", "orderBy", "limit"]) p[k] = () => p;
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return p;
  };
  const db = {
    select: vi.fn(() => chain(script.selects.shift() ?? [])),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        const w = { where: () => Object.assign(Promise.resolve([]), { returning: () => Promise.resolve([]) }) };
        return w;
      },
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: () => Promise.resolve(script.inserts.shift() ?? []) };
      },
    })),
  };
  return { db, updates, inserted };
}

function deps(db: unknown, over: Partial<ChannelDeps> = {}) {
  const sent: Array<Parameters<ChannelDeps["sendReply"]>[0]> = [];
  const chats: Array<Parameters<ChannelDeps["runChat"]>[0]> = [];
  const d: ChannelDeps = {
    db: db as ChannelDeps["db"],
    resolvePhone: vi.fn(async () => ({ orgId: "org-kevin", userId: "user-kevin" })),
    listBrandIds: vi.fn(async () => ["brand-a"]),
    createRootRun: vi.fn(async () => "run-1"),
    runChat: vi.fn(async (args) => {
      chats.push(args);
      return { status: 200, body: sse({ type: "token", content: "You have **2** campaigns — Alpha and Beta." }, "[DONE]") };
    }),
    sendReply: vi.fn(async (args) => {
      sent.push(args);
    }),
    ...over,
  };
  return { d, sent, chats };
}

const ROW = { id: "row-1", messageId: MSG.messageId, status: "received", payload: MSG };

describe("processChannelMessage", () => {
  it("a known number continues that user's latest Copilot session and answers once, signed", async () => {
    const { db, updates } = fakeDb({ selects: [[ROW], [{ id: "sess-web", brandIds: ["brand-a"] }]], inserts: [] });
    const { d, sent, chats } = deps(db);
    await processChannelMessage(d, "row-1");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ orgId: "org-kevin", userId: "user-kevin", runId: "run-1", sessionId: "sess-web", message: "list my campaigns" });
    expect((chats[0].context as { channel: ChatChannelContext }).channel.assistant.name).toBe("Sophie");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ orgId: MSG.orgId, brandId: MSG.brandId, phone: "+33680478702", fromAccount: "+77776879632", idempotencyKey: "copilot:$evt-1" });
    expect(sent[0].text).toBe("You have *2* campaigns, Alpha and Beta.");
    expect(updates.at(-1)).toMatchObject({ status: "answered", error: null });
    expect(d.listBrandIds).not.toHaveBeenCalled();
  });

  it("a number linked in Integrations acts as the user who linked it, over users.phone", async () => {
    const { db } = fakeDb({ selects: [[{ ...ROW, payload: { ...MSG, sender: { ...MSG.sender, linkedBy: { orgId: "org-linked", userId: "user-linked" } } } }], [{ id: "sess-l", brandIds: ["b"] }]], inserts: [] });
    const { d, chats } = deps(db);
    await processChannelMessage(d, "row-1");
    expect(d.resolvePhone).not.toHaveBeenCalled();
    expect(chats[0]).toMatchObject({ orgId: "org-linked", userId: "user-linked", sessionId: "sess-l" });
  });

  it("an unknown number gets a guest session under the number owner's org", async () => {
    const { db, inserted } = fakeDb({ selects: [[ROW], []], inserts: [[{ id: "sess-guest" }]] });
    const { d, chats, sent } = deps(db, { resolvePhone: vi.fn(async () => null) });
    await processChannelMessage(d, "row-1");
    expect(inserted[0]).toMatchObject({ orgId: MSG.orgId, userId: MSG.accountUserId, guest: true, channelPhone: "+33680478702", configKey: "copilot" });
    expect(chats[0]).toMatchObject({ orgId: MSG.orgId, userId: MSG.accountUserId, sessionId: "sess-guest" });
    expect(sent).toHaveLength(1);
  });

  it("an already handled row runs nothing", async () => {
    const { db } = fakeDb({ selects: [[{ ...ROW, status: "answered" }]], inserts: [] });
    const { d } = deps(db);
    await processChannelMessage(d, "row-1");
    expect(d.runChat).not.toHaveBeenCalled();
    expect(d.sendReply).not.toHaveBeenCalled();
  });

  it("a failed turn still answers the person and records the failure", async () => {
    const { db, updates } = fakeDb({ selects: [[ROW], [{ id: "sess-web", brandIds: ["b"] }]], inserts: [] });
    const { d, sent } = deps(db, { runChat: vi.fn(async () => ({ status: 500, body: "boom" })) });
    await processChannelMessage(d, "row-1");
    expect(sent[0].text).toBe(CHANNEL_FAILURE_TEXT);
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
  });

  it("an agent-signup org refused for credits (HTTP 402) gets the add-credits answer", async () => {
    const { db } = fakeDb({ selects: [[ROW], [{ id: "sess-web", brandIds: ["b"] }]], inserts: [] });
    const { d, sent } = deps(db, { runChat: vi.fn(async () => ({ status: 402, body: JSON.stringify({ message: "You're out of credits. Add credits to keep going." }) })) });
    await processChannelMessage(d, "row-1");
    expect(sent[0].text).toContain("Add credits: https://dashboard.distribute.you");
  });
});
