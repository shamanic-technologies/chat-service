import { describe, it, expect } from "vitest";
import { readHistoryPage, HISTORY_PAGE_MAX, type ReadOlderRows } from "../../src/lib/session-history-page.js";
import type { Message } from "../../src/db/schema.js";

function msg(i: number, over: Partial<Message> = {}): Message {
  return {
    id: `m${i}`,
    sessionId: "s",
    role: i % 2 ? "assistant" : "user",
    content: `turn ${i}`,
    contentBlocks: null,
    toolCalls: null,
    buttons: null,
    choices: null,
    openPages: null,
    creditsRequired: null,
    proactiveTrigger: false,
    tokenCount: null,
    createdAt: new Date(Date.UTC(2026, 10, 16, 0, 0, i)),
    ...over,
  };
}

/** A reader over an in-memory session (oldest first), newest first like the SQL one. */
function readerOver(all: Message[]): { read: ReadOlderRows; calls: number[] } {
  const calls: number[] = [];
  const read: ReadOlderRows = async (before, n) => {
    calls.push(n);
    const end = before === null ? all.length : all.findIndex((m) => m.id === before);
    return all.slice(0, end).reverse().slice(0, n);
  };
  return { read, calls };
}

describe("readHistoryPage (MON-PAGE-SPEED-1114)", () => {
  const all = Array.from({ length: 75 }, (_, i) => msg(i));

  it("serves the newest `limit` messages oldest first, and says older ones exist", async () => {
    const page = await readHistoryPage(readerOver(all).read, 30, null);
    expect(page.messages.map((m) => m.id)).toEqual(all.slice(45).map((m) => m.id));
    expect(page.hasOlder).toBe(true);
  });

  it("pages back to the very first message with no gap and no repeat", async () => {
    const { read } = readerOver(all);
    const seen: string[] = [];
    let before: string | null = null;
    for (;;) {
      const page = await readHistoryPage(read, 30, before);
      seen.unshift(...page.messages.map((m) => m.id));
      if (!page.hasOlder) break;
      before = page.messages[0].id;
    }
    expect(seen).toEqual(all.map((m) => m.id));
  });

  it("skips hidden rows yet still fills the page", async () => {
    const withHidden = all.map((m, i) => (i >= 60 && i % 2 === 1 ? { ...m, content: "  " } : m));
    const page = await readHistoryPage(readerOver(withHidden).read, 20, null);
    expect(page.messages).toHaveLength(20);
    expect(page.messages.every((m) => m.content.trim())).toBe(true);
    expect(page.hasOlder).toBe(true);
  });

  it("a short session is one page with nothing older", async () => {
    const page = await readHistoryPage(readerOver(all.slice(0, 5)).read, 30, null);
    expect(page.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(page.hasOlder).toBe(false);
  });

  it("refuses a limit out of range", async () => {
    await expect(readHistoryPage(readerOver(all).read, 0, null)).rejects.toThrow(/limit/);
    await expect(readHistoryPage(readerOver(all).read, HISTORY_PAGE_MAX + 1, null)).rejects.toThrow(/limit/);
  });
});
