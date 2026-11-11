import { describe, expect, it } from "vitest";
import { oneTurnAtATime, queuedConversations, turnKeyOf } from "../../src/lib/turn-queue.js";

// SOPHIE-CORE-1111, prod 2026-11-11: the dashboard's "Open a new chat" turn and the client's own message
// arrived in the same second, ran in parallel and answered twice, contradicting each other.
describe("one turn at a time per conversation (SOPHIE-CORE-1111)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a second message of the same person waits for the first turn to end", async () => {
    const log: string[] = [];
    const turn = (name: string, ms: number) => async () => {
      log.push(`${name} start`);
      await sleep(ms);
      log.push(`${name} end`);
      return name;
    };
    const key = turnKeyOf({ message: "hi" }, { orgId: "o1", userId: "u1" });
    const [a, b] = await Promise.all([oneTurnAtATime(key, turn("new chat", 30)), oneTurnAtATime(key, turn("their message", 1))]);
    expect([a, b]).toEqual(["new chat", "their message"]);
    expect(log).toEqual(["new chat start", "new chat end", "their message start", "their message end"]);
    expect(queuedConversations()).toBe(0);
  });

  it("two different people never wait for each other", async () => {
    let openA!: () => void;
    const gateA = new Promise<void>((r) => (openA = r));
    const a = oneTurnAtATime(turnKeyOf({}, { orgId: "o1", userId: "u1" }), () => gateA.then(() => "A"));
    // B finishes while A is still held open: no shared queue between two people.
    await expect(oneTurnAtATime(turnKeyOf({}, { orgId: "o2", userId: "u2" }), async () => "B")).resolves.toBe("B");
    openA();
    await expect(a).resolves.toBe("A");
  });

  it("a failed turn releases the next one", async () => {
    const key = "person:o3:u3";
    const first = oneTurnAtATime(key, async () => {
      throw new Error("boom");
    });
    const second = oneTurnAtATime(key, async () => "ran");
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ran");
  });

  it("a turn that never ends blocks the next one only up to the wait cap", async () => {
    const key = "person:o4:u4";
    void oneTurnAtATime(key, () => new Promise(() => {}), 10);
    const started = Date.now();
    await expect(oneTurnAtATime(key, async () => "ran", 10)).resolves.toBe("ran");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("the person's web, Telegram and WhatsApp turns share one key; a Lead event turn is its own thread", () => {
    const id = { orgId: "o1", userId: "u1" };
    expect(turnKeyOf({ sessionId: "s1" }, id)).toBe(turnKeyOf({ sessionId: "s2", channelMessageId: "m" }, id));
    expect(turnKeyOf({ sessionId: "lead-s", leadTurnId: "t1" }, id)).toBe("lead:lead-s");
  });
});
