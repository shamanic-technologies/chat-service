import { describe, it, expect, vi } from "vitest";
import { CHANNEL_FAILURE_TEXT, CONVERSATION_LINES, WHOLE_WAY_TO_USE, toPlainText } from "../../src/lib/channel-copilot.js";
import {
  TELEGRAM_AFTER_SIGN_IN_TRIGGER,
  TELEGRAM_TEXT_ONLY,
  acceptTelegramMessage,
  buildTelegramBlock,
  buildTelegramDoorBlock,
  linkTelegramChat,
  processTelegramMessage,
  resolveTelegramChat,
  sendTelegramToChat,
  sendTelegramToOrg,
  telegramOpening,
  telegramOpeningTrigger,
  telegramStartLink,
  telegramTurnOutcome,
  type TelegramDeps,
} from "../../src/lib/telegram-copilot.js";
import { TelegramMessageRequestSchema } from "../../src/schemas.js";
import { DISTRY_LIMIT_NOTICE_ACCOUNT, type DistryGate, type DistryPerson } from "../../src/lib/distry-spend.js";

/** Distry's limits never reached here (their own tests: distry-spend-pg, and the capped door tests). */
const PASS_GATE: DistryGate = { gate: async (person) => ({ run: true, tracked: false, person }), record: async () => {} };

process.env.CLIENT_SERVICE_URL = process.env.CLIENT_SERVICE_URL || "https://client.test.local";
process.env.CLIENT_SERVICE_API_KEY = process.env.CLIENT_SERVICE_API_KEY || "test-client-key";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const LINE = { orgId: "line-org", brandId: "line-brand", userId: "line-user" };

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

/** A db fake: inserts recorded (a repeated message key returns nothing), selects from a queue, updates recorded. */
function fakeDb(selects: unknown[][] = []) {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const seenKeys = new Set<string>();
  const queue = [...selects];
  const chain = () => {
    const rows = queue.shift() ?? [];
    const p = Promise.resolve(rows) as Promise<unknown[]> & { orderBy: () => unknown };
    p.orderBy = () => ({ limit: () => Promise.resolve(rows) });
    return p;
  };
  const db = {
    insert: (table: { [k: symbol]: unknown }) => ({
      values: (values: Record<string, unknown>) => {
        const name = String((table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")]);
        inserts.push({ table: name, values });
        const duplicate = typeof values.messageId === "string" && seenKeys.has(values.messageId);
        if (typeof values.messageId === "string") seenKeys.add(values.messageId);
        const rows = duplicate ? [] : [{ id: `row-${inserts.length}` }];
        return {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve(rows) }),
          returning: () => Promise.resolve([{ id: `session-${inserts.length}` }]),
        };
      },
    }),
    select: () => ({ from: () => ({ where: chain }) }),
    update: () => ({ set: (s: Record<string, unknown>) => ({ where: () => { updates.push(s); return Promise.resolve(); } }) }),
  };
  return { db: db as unknown as TelegramDeps["db"], inserts, updates };
}

const msg = (over: Partial<{ chatId: string; messageId: string; text: string | null }> = {}) =>
  TelegramMessageRequestSchema.parse({ chatId: 12345, messageId: 7, text: "hi", ...over });

describe("Telegram routing: who a chat talks with (SOPHIE-TELEGRAM-1103)", () => {
  it("a linked chat runs as the member who linked it, on the newest link's org", async () => {
    const { db, inserts } = fakeDb();
    const resolveChat = vi.fn(async () => [{ orgId: ORG, userId: USER }, { orgId: OTHER_ORG, userId: "u-old" }]);
    const accepted = await acceptTelegramMessage({ db, resolveChat, copilotLine: () => LINE }, msg());
    expect(resolveChat).toHaveBeenCalledWith("12345");
    expect(accepted).toEqual({ status: "accepted", rowId: "row-1" });
    expect(inserts[0].values).toMatchObject({ messageId: "telegram:12345:7", channel: "telegram", senderPhone: "12345", orgId: ORG, userId: USER, status: "received" });
  });

  it("a chat linked to no account is a guest on our own line, never someone else's org (DISTRY-START-DOOR-1125)", async () => {
    const { db, inserts } = fakeDb([[]]);
    expect(await acceptTelegramMessage({ db, resolveChat: async () => [], copilotLine: () => LINE }, msg({ chatId: "777" }))).toEqual({ status: "accepted", rowId: "row-1" });
    expect(inserts[0].values).toMatchObject({ messageId: "telegram:777:7", senderPhone: "777", orgId: LINE.orgId, userId: LINE.userId });
  });

  it("a chat that signed in in its own conversation (link not made yet) runs as that account", async () => {
    const { db, inserts } = fakeDb([[{ id: "s-door", orgId: ORG, userId: USER, guest: false, planOrgId: null }]]);
    await acceptTelegramMessage({ db, resolveChat: async () => [], copilotLine: () => LINE }, msg({ chatId: "777" }));
    expect(inserts[0].values).toMatchObject({ orgId: ORG, userId: USER });
  });

  it("the same Telegram message twice (a webhook retry) runs once", async () => {
    const { db } = fakeDb();
    const resolveChat = async () => [{ orgId: ORG, userId: USER }];
    expect((await acceptTelegramMessage({ db, resolveChat, copilotLine: () => LINE }, msg())).status).toBe("accepted");
    expect(await acceptTelegramMessage({ db, resolveChat, copilotLine: () => LINE }, msg())).toEqual({ status: "duplicate" });
  });

  it("client-service unreachable is an error, never a guest turn", async () => {
    const { db } = fakeDb();
    await expect(acceptTelegramMessage({ db, resolveChat: async () => { throw new Error("client-service 502"); }, copilotLine: () => LINE }, msg())).rejects.toThrow("502");
  });
});

describe("processTelegramMessage", () => {
  const row = (payload: Record<string, unknown>) => ({
    id: "row-1", messageId: "telegram:12345:7", channel: "telegram", senderPhone: "12345", orgId: ORG, userId: USER, status: "received", payload,
  });
  const deps = (db: TelegramDeps["db"], over: Partial<TelegramDeps> = {}): TelegramDeps => ({
    db,
    copilotLine: () => LINE,
    resolveChat: async () => [{ orgId: ORG, userId: USER }],
    listBrandIds: async () => ["b-1"],
    createRootRun: vi.fn(async () => "run-1"),
    runChat: vi.fn(async () => ({ status: 200, body: sse({ type: "token", content: "Hi! Your **Outbound** campaign sent 12 emails today." }) })),
    sendReply: vi.fn(async () => {}),
    linkChat: vi.fn(async () => {}),
    spend: PASS_GATE,
    ...over,
  });

  it("runs the turn as the person in their own Copilot thread and answers the chat in plain text", async () => {
    const { db, updates } = fakeDb([[row({ chatId: "12345", messageId: "7", text: "hi" })], [{ id: "s-web" }]]);
    const d = deps(db);
    await processTelegramMessage(d, "row-1");
    expect(d.createRootRun).toHaveBeenCalledWith({ orgId: ORG, userId: USER });
    expect(d.runChat).toHaveBeenCalledWith({ orgId: ORG, userId: USER, runId: "run-1", sessionId: "s-web", message: "hi", channelMessageId: "row-1" });
    expect(d.sendReply).toHaveBeenCalledWith({ chatId: "12345", text: "Hi! Your Outbound campaign sent 12 emails today." });
    expect(updates.at(-1)).toMatchObject({ status: "answered", error: null });
    expect(updates.at(-1)!.sentAt).toBeInstanceOf(Date);
  });

  it("no Copilot thread yet: one is opened for them with their brands", async () => {
    const { db, inserts } = fakeDb([[row({ chatId: "12345", messageId: "7", text: "hi" })], []]);
    const d = deps(db);
    await processTelegramMessage(d, "row-1");
    expect(inserts[0].values).toMatchObject({ orgId: ORG, userId: USER, configKey: "copilot", guest: false, brandIds: ["b-1"], parentRunId: "run-1" });
    expect(d.runChat).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
  });

  it("a photo or voice note with no text: no turn, no spend, one line saying to write", async () => {
    const { db, updates } = fakeDb([[row({ chatId: "12345", messageId: "7", text: null })]]);
    const d = deps(db);
    await processTelegramMessage(d, "row-1");
    expect(d.createRootRun).not.toHaveBeenCalled();
    expect(d.runChat).not.toHaveBeenCalled();
    expect(d.sendReply).toHaveBeenCalledWith({ chatId: "12345", text: TELEGRAM_TEXT_ONLY });
    expect(updates.at(-1)).toMatchObject({ status: "answered" });
  });

  it("a failed turn still answers the chat, and the row keeps why", async () => {
    const { db, updates } = fakeDb([[row({ chatId: "12345", messageId: "7", text: "hi" })], [{ id: "s-web" }]]);
    const d = deps(db, { runChat: vi.fn(async () => ({ status: 500, body: "boom" })) });
    await processTelegramMessage(d, "row-1");
    expect(d.sendReply).toHaveBeenCalledWith({ chatId: "12345", text: CHANNEL_FAILURE_TEXT });
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
    expect(String(updates.at(-1)!.error)).toContain("POST /chat 500");
  });

  it("a reply Telegram refused: the row is failed with no sentAt (red on Monitoring)", async () => {
    const { db, updates } = fakeDb([[row({ chatId: "12345", messageId: "7", text: "hi" })], [{ id: "s-web" }]]);
    const d = deps(db, { sendReply: vi.fn(async () => { throw new Error("telegram delivery_failed: blocked"); }) });
    await processTelegramMessage(d, "row-1");
    expect(updates.at(-1)).toMatchObject({ status: "failed", sentAt: null });
  });

  it("an account that never paid, past the day's non-client limit: the notice in the chat, no run, no model (DISTRY-GUEST-CAPS-1119)", async () => {
    const { db, updates } = fakeDb([[row({ chatId: "12345", messageId: "7", text: "hi" })]]);
    const gate = vi.fn(async (person: DistryPerson) => ({ run: false as const, reason: "day_cap" as const, notice: DISTRY_LIMIT_NOTICE_ACCOUNT, person }));
    const d = deps(db, { spend: { gate, record: vi.fn() } });
    await processTelegramMessage(d, "row-1");
    expect(gate).toHaveBeenCalledWith({ key: `org:${ORG}`, surface: "telegram", guest: false, turnOrgId: ORG, planOrgId: null });
    expect(d.createRootRun).not.toHaveBeenCalled();
    expect(d.runChat).not.toHaveBeenCalled();
    expect(d.sendReply).toHaveBeenCalledWith({ chatId: "12345", text: DISTRY_LIMIT_NOTICE_ACCOUNT });
    expect(updates.at(-1)).toMatchObject({ status: "answered" });
  });

  it("an already answered row is never answered twice", async () => {
    const { db } = fakeDb([[{ ...row({ chatId: "12345", messageId: "7", text: "hi" }), status: "answered" }]]);
    const d = deps(db);
    await processTelegramMessage(d, "row-1");
    expect(d.runChat).not.toHaveBeenCalled();
    expect(d.sendReply).not.toHaveBeenCalled();
  });
});

describe("a chat with no account: the guest door (DISTRY-START-DOOR-1125)", () => {
  const guestRow = (text: string | null) => ({
    id: "row-1", messageId: "telegram:777:9", channel: "telegram", senderPhone: "777", orgId: LINE.orgId, userId: LINE.userId, status: "received", payload: { chatId: "777", messageId: "9", text },
  });
  const deps = (db: TelegramDeps["db"], over: Partial<TelegramDeps> = {}): TelegramDeps => ({
    db,
    copilotLine: () => LINE,
    resolveChat: async () => [],
    listBrandIds: async () => [],
    createRootRun: vi.fn(async () => "run-1"),
    runChat: vi.fn(async () => ({ status: 200, body: sse({ type: "token", content: "Hi, I'm Distry. What's your website?" }) })),
    sendReply: vi.fn(async () => {}),
    linkChat: vi.fn(async () => {}),
    spend: PASS_GATE,
    ...over,
  });

  it("the deep link opens a guest conversation tied to the chat, under our line, our trigger in place of their words", async () => {
    const site = Buffer.from("acme.com").toString("base64url");
    // row, door session (none), session after the turn (still a guest)
    const { db, inserts } = fakeDb([[guestRow(`/start site-${site}`)], [], [{ orgId: LINE.orgId, userId: LINE.userId, guest: true, planOrgId: null }]]);
    const gate = vi.fn(PASS_GATE.gate);
    const d = deps(db, { spend: { gate, record: async () => {} } });
    await processTelegramMessage(d, "row-1");
    expect(gate).toHaveBeenCalledWith({ key: "telegram:777", surface: "telegram", guest: true, turnOrgId: LINE.orgId, planOrgId: null });
    expect(inserts[0].values).toMatchObject({ orgId: LINE.orgId, userId: LINE.userId, guest: true, telegramChatId: "777", configKey: "copilot", brandIds: [LINE.brandId] });
    expect(d.runChat).toHaveBeenCalledWith({ orgId: LINE.orgId, userId: LINE.userId, runId: "run-1", sessionId: "session-1", message: telegramOpeningTrigger("acme.com"), channelMessageId: "row-1" });
    expect(d.sendReply).toHaveBeenCalledWith({ chatId: "777", text: "Hi, I'm Distry. What's your website?" });
    expect(d.linkChat).not.toHaveBeenCalled();
  });

  it("signed up in the turn: the chat is linked to their account and the answer with their access replaces the sign-in words", async () => {
    const session = { id: "s-door", orgId: LINE.orgId, userId: LINE.userId, guest: true, planOrgId: "plan-org" };
    const { db, updates } = fakeDb([
      [guestRow("123456")],
      [session],
      [{ orgId: ORG, userId: USER, guest: false, planOrgId: "plan-org" }],
      [{ id: "m-sign-in" }],
    ]);
    const runChat = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: sse({ type: "token", content: "You're in." }) })
      .mockResolvedValueOnce({ status: 200, body: sse({ type: "token", content: "You're in. Your plan for acme.com is ready: pay here https://x" }) });
    const d = deps(db, { runChat });
    await processTelegramMessage(d, "row-1");
    expect(runChat.mock.calls[0][0]).toMatchObject({ orgId: LINE.orgId, sessionId: "s-door", message: "123456" });
    expect(d.linkChat).toHaveBeenCalledWith({ chatId: "777", orgId: ORG, userId: USER });
    expect(runChat.mock.calls[1][0]).toMatchObject({ orgId: ORG, userId: USER, sessionId: "s-door", message: TELEGRAM_AFTER_SIGN_IN_TRIGGER, channelMessageId: "row-1" });
    expect(d.sendReply).toHaveBeenCalledTimes(1);
    expect(d.sendReply).toHaveBeenCalledWith({ chatId: "777", text: "You're in. Your plan for acme.com is ready: pay here https://x" });
    expect(updates).toContainEqual(expect.objectContaining({ orgId: ORG, userId: USER, signedIn: true }));
    expect(updates).toContainEqual({ proactiveTrigger: true });
    expect(updates.at(-1)).toMatchObject({ status: "answered" });
  });

  it("a link that fails never hides that they are in: the answer still comes", async () => {
    const { db } = fakeDb([[guestRow("123456")], [{ id: "s-door", orgId: LINE.orgId, userId: LINE.userId, guest: true, planOrgId: null }], [{ orgId: ORG, userId: USER, guest: false, planOrgId: null }], []]);
    const runChat = vi.fn(async () => ({ status: 200, body: sse({ type: "token", content: "Welcome." }) }));
    const d = deps(db, { runChat, linkChat: vi.fn(async () => { throw new Error("client-service 502"); }) });
    await processTelegramMessage(d, "row-1");
    expect(runChat).toHaveBeenCalledTimes(2);
    expect(d.sendReply).toHaveBeenCalledWith({ chatId: "777", text: "Welcome." });
  });

  it("the guest block: same form and identity builder, sign-in right in the chat", () => {
    const block = buildTelegramDoorBlock({ guest: true, afterSignIn: false });
    expect(block).toContain("## Channel: Telegram");
    expect(block).toContain("This Telegram chat is NOT tied to any distribute.you account yet");
    expect(block).toContain("start_sign_in");
    for (const line of CONVERSATION_LINES) expect(block).toContain(line);
    expect(buildTelegramDoorBlock({ guest: false, afterSignIn: true })).toContain("They signed in a moment ago");
  });
});

describe("the bot's deep link", () => {
  it("carries the visitor's website when it fits, and reads it back", () => {
    const link = telegramStartLink("DistributeBot", "acme.com");
    expect(link).toMatch(/^https:\/\/t\.me\/DistributeBot\?start=site-[A-Za-z0-9_-]+$/);
    expect(telegramOpening(`/start ${link.split("start=")[1]}`)).toEqual({ website: "acme.com" });
    expect(telegramStartLink("DistributeBot", null)).toBe("https://t.me/DistributeBot");
    expect(telegramStartLink("DistributeBot", `${"a".repeat(60)}.com`)).toBe("https://t.me/DistributeBot");
  });

  it("opens on /start alone or with any parameter, never on their words; an unreadable website is dropped", () => {
    expect(telegramOpening("/start")).toEqual({ website: null });
    expect(telegramOpening("/start@DistributeBot hi")).toEqual({ website: null });
    expect(telegramOpening(`/start site-${Buffer.from("not a site").toString("base64url")}`)).toEqual({ website: null });
    expect(telegramOpening("hello")).toBeNull();
    expect(telegramOpening("/start talking about my start")).toBeNull();
    expect(telegramOpening(null)).toBeNull();
  });
});

describe("Telegram form", () => {
  it("one Sophie: the Telegram block carries the shared conversation strategy, only the form differs", () => {
    const block = buildTelegramBlock();
    expect(block).toContain("## Channel: Telegram");
    expect(block).toContain("plain text only");
    for (const line of CONVERSATION_LINES) expect(block).toContain(line);
    expect(block).toContain(WHOLE_WAY_TO_USE);
    expect(block).not.toContain("WhatsApp");
  });

  it("plain text: no markdown survives, links keep their URL, no long dash", () => {
    expect(toPlainText("## Plan\n**Bold** and *soft* and `code` — see [the page](https://dashboard.distribute.you/x)"))
      .toBe("Plan\nBold and soft and code, see the page: https://dashboard.distribute.you/x");
    expect(toPlainText("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("a 402 (an API-born org out of money) is still an answer", () => {
    const out = telegramTurnOutcome(402, JSON.stringify({ message: "Add funds to continue." }));
    expect(out.failure).toBeNull();
    expect(out.replyText).toContain("Add funds to continue.");
  });
});

describe("client-service calls", () => {
  it("reads the chat's links and refuses a malformed answer", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ links: [{ orgId: ORG, orgName: "Acme", userId: USER, linkedAt: "2026-11-03T00:00:00.000Z" }] })));
    expect(await resolveTelegramChat("12345", ok as unknown as typeof fetch)).toEqual([{ orgId: ORG, userId: USER }]);
    expect(String((ok.mock.calls[0] as unknown as [string])[0])).toBe("https://client.test.local/internal/owner-telegram/chats/12345");
    const bad = vi.fn(async () => new Response(JSON.stringify({ links: [{ orgId: ORG }] })));
    await expect(resolveTelegramChat("12345", bad as unknown as typeof fetch)).rejects.toThrow("without orgId/userId");
    const down = vi.fn(async () => new Response("down", { status: 502 }));
    await expect(resolveTelegramChat("12345", down as unknown as typeof fetch)).rejects.toThrow("502");
  });

  it("answers the chat that wrote through the bot, and throws when Telegram refuses", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
    await sendTelegramToChat({ chatId: "777", text: "hi" }, ok as unknown as typeof fetch);
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(JSON.parse(String(init.body))).toMatchObject({ chat_id: "777", text: "hi" });
    const blocked = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }), { status: 403 }));
    await expect(sendTelegramToChat({ chatId: "777", text: "hi" }, blocked as unknown as typeof fetch)).rejects.toThrow("blocked");
  });

  it("links the chat with client-service's own one-time code, made and used at once", async () => {
    const calls: Array<[string, unknown]> = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, JSON.parse(String(init.body))]);
      return new Response(JSON.stringify(url.endsWith("/link-codes") ? { code: "c0de", linkUrl: "x", expiresAt: "y" } : { orgId: ORG }), { status: url.endsWith("/link-codes") ? 201 : 200 });
    });
    await linkTelegramChat({ chatId: "777", orgId: ORG, userId: USER }, f as unknown as typeof fetch);
    expect(calls).toEqual([
      [`https://client.test.local/internal/orgs/${ORG}/owner-telegram/link-codes`, { userId: USER }],
      ["https://client.test.local/internal/owner-telegram/links", { code: "c0de", chatId: "777" }],
    ]);
    const refused = vi.fn(async () => new Response("no", { status: 404 }));
    await expect(linkTelegramChat({ chatId: "777", orgId: ORG, userId: USER }, refused as unknown as typeof fetch)).rejects.toThrow("404");
  });

  it("a send that did not leave throws (named outcome other than sent)", async () => {
    const sent = vi.fn(async () => new Response(JSON.stringify({ outcome: "sent", target: "linked_chat", telegramMessageId: 1 })));
    await sendTelegramToOrg({ orgId: ORG, text: "hi" }, sent as unknown as typeof fetch);
    const failed = vi.fn(async () => new Response(JSON.stringify({ outcome: "delivery_failed", target: "linked_chat", reason: "blocked" })));
    await expect(sendTelegramToOrg({ orgId: ORG, text: "hi" }, failed as unknown as typeof fetch)).rejects.toThrow("delivery_failed: blocked");
  });
});
