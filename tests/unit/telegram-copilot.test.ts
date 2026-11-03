import { describe, it, expect, vi } from "vitest";
import { CHANNEL_FAILURE_TEXT, CONVERSATION_LINES, WHOLE_WAY_TO_USE, toPlainText } from "../../src/lib/channel-copilot.js";
import {
  TELEGRAM_TEXT_ONLY,
  acceptTelegramMessage,
  buildTelegramBlock,
  processTelegramMessage,
  resolveTelegramChat,
  sendTelegramToOrg,
  telegramTurnOutcome,
  type TelegramDeps,
} from "../../src/lib/telegram-copilot.js";
import { TelegramMessageRequestSchema } from "../../src/schemas.js";

process.env.CLIENT_SERVICE_URL = process.env.CLIENT_SERVICE_URL || "https://client.test.local";
process.env.CLIENT_SERVICE_API_KEY = process.env.CLIENT_SERVICE_API_KEY || "test-client-key";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";

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
    const accepted = await acceptTelegramMessage({ db, resolveChat }, msg());
    expect(resolveChat).toHaveBeenCalledWith("12345");
    expect(accepted).toEqual({ status: "accepted", rowId: "row-1" });
    expect(inserts[0].values).toMatchObject({ messageId: "telegram:12345:7", channel: "telegram", senderPhone: "12345", orgId: ORG, userId: USER, status: "received" });
  });

  it("an unlinked chat runs nothing on anybody's org: not_linked, nothing stored", async () => {
    const { db, inserts } = fakeDb();
    expect(await acceptTelegramMessage({ db, resolveChat: async () => [] }, msg({ chatId: "777" }))).toEqual({ status: "not_linked" });
    expect(inserts).toHaveLength(0);
  });

  it("the same Telegram message twice (a webhook retry) runs once", async () => {
    const { db } = fakeDb();
    const resolveChat = async () => [{ orgId: ORG, userId: USER }];
    expect((await acceptTelegramMessage({ db, resolveChat }, msg())).status).toBe("accepted");
    expect(await acceptTelegramMessage({ db, resolveChat }, msg())).toEqual({ status: "duplicate" });
  });

  it("client-service unreachable is an error, never a not_linked", async () => {
    const { db } = fakeDb();
    await expect(acceptTelegramMessage({ db, resolveChat: async () => { throw new Error("client-service 502"); } }, msg())).rejects.toThrow("502");
  });
});

describe("processTelegramMessage", () => {
  const row = (payload: Record<string, unknown>) => ({
    id: "row-1", messageId: "telegram:12345:7", channel: "telegram", senderPhone: "12345", orgId: ORG, userId: USER, status: "received", payload,
  });
  const deps = (db: TelegramDeps["db"], over: Partial<TelegramDeps> = {}): TelegramDeps => ({
    db,
    resolveChat: async () => [{ orgId: ORG, userId: USER }],
    listBrandIds: async () => ["b-1"],
    createRootRun: vi.fn(async () => "run-1"),
    runChat: vi.fn(async () => ({ status: 200, body: sse({ type: "token", content: "Hi! Your **Outbound** campaign sent 12 emails today." }) })),
    sendReply: vi.fn(async () => {}),
    ...over,
  });

  it("runs the turn as the person in their own Copilot thread and answers the chat in plain text", async () => {
    const { db, updates } = fakeDb([[row({ chatId: "12345", messageId: "7", text: "hi" })], [{ id: "s-web" }]]);
    const d = deps(db);
    await processTelegramMessage(d, "row-1");
    expect(d.createRootRun).toHaveBeenCalledWith({ orgId: ORG, userId: USER });
    expect(d.runChat).toHaveBeenCalledWith({ orgId: ORG, userId: USER, runId: "run-1", sessionId: "s-web", message: "hi", channelMessageId: "row-1" });
    expect(d.sendReply).toHaveBeenCalledWith({ orgId: ORG, text: "Hi! Your Outbound campaign sent 12 emails today." });
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
    expect(d.sendReply).toHaveBeenCalledWith({ orgId: ORG, text: TELEGRAM_TEXT_ONLY });
    expect(updates.at(-1)).toMatchObject({ status: "answered" });
  });

  it("a failed turn still answers the chat, and the row keeps why", async () => {
    const { db, updates } = fakeDb([[row({ chatId: "12345", messageId: "7", text: "hi" })], [{ id: "s-web" }]]);
    const d = deps(db, { runChat: vi.fn(async () => ({ status: 500, body: "boom" })) });
    await processTelegramMessage(d, "row-1");
    expect(d.sendReply).toHaveBeenCalledWith({ orgId: ORG, text: CHANNEL_FAILURE_TEXT });
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
    expect(String(updates.at(-1)!.error)).toContain("POST /chat 500");
  });

  it("a reply Telegram refused: the row is failed with no sentAt (red on Monitoring)", async () => {
    const { db, updates } = fakeDb([[row({ chatId: "12345", messageId: "7", text: "hi" })], [{ id: "s-web" }]]);
    const d = deps(db, { sendReply: vi.fn(async () => { throw new Error("telegram delivery_failed: blocked"); }) });
    await processTelegramMessage(d, "row-1");
    expect(updates.at(-1)).toMatchObject({ status: "failed", sentAt: null });
  });

  it("an already answered row is never answered twice", async () => {
    const { db } = fakeDb([[{ ...row({ chatId: "12345", messageId: "7", text: "hi" }), status: "answered" }]]);
    const d = deps(db);
    await processTelegramMessage(d, "row-1");
    expect(d.runChat).not.toHaveBeenCalled();
    expect(d.sendReply).not.toHaveBeenCalled();
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

  it("a send that did not leave throws (named outcome other than sent)", async () => {
    const sent = vi.fn(async () => new Response(JSON.stringify({ outcome: "sent", target: "linked_chat", telegramMessageId: 1 })));
    await sendTelegramToOrg({ orgId: ORG, text: "hi" }, sent as unknown as typeof fetch);
    const failed = vi.fn(async () => new Response(JSON.stringify({ outcome: "delivery_failed", target: "linked_chat", reason: "blocked" })));
    await expect(sendTelegramToOrg({ orgId: ORG, text: "hi" }, failed as unknown as typeof fetch)).rejects.toThrow("delivery_failed: blocked");
  });
});
