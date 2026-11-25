import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createMemoryLocalLlmStore } from "../../src/lib/local-llm-store.js";
import { notifySilentRunners, silenceNoticeText, type SilenceDeps } from "../../src/lib/local-llm-silence.js";

// SOLO-PLAN-1125 AC2, on a real Postgres (CI's throwaway container): a founder
// whose Claude routine took no work for 2 h is told ONCE, fixed text, on the
// door they use. Staff test ids only: no real person or org is reached (every
// sender is a fake).

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const ORG = `org-staff-silence-${Date.now()}`;
const USER = `user-staff-silence-${Date.now()}`;
const H = 3600_000;

describe("a silent runner is told to the founder once", { timeout: 30_000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: SilenceDeps["db"];

  beforeAll(() => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL is required");
    client = postgres(connectionString, { max: 4 });
    db = drizzle(client) as unknown as SilenceDeps["db"];
  });

  afterAll(async () => {
    await client`DELETE FROM sessions WHERE org_id LIKE ${`${ORG}%`}`;
    await client.end();
  });

  async function silentOrg(orgId: string, lastSeenHoursAgo: number | null, pendingMinutes: number) {
    const store = createMemoryLocalLlmStore();
    await store.setDeclared(orgId, true, USER, new Date(Date.now() - 24 * H));
    if (lastSeenHoursAgo !== null) await store.touchRunner(orgId, new Date(Date.now() - lastSeenHoursAgo * H), { name: "claude-routine", version: null, kind: "routine" });
    const job = await store.enqueue({
      orgId,
      kind: "complete",
      route: "/complete",
      runId: null,
      request: { systemPrompt: "", prompt: "q", jsonSchema: null, model: "claude-haiku-5-5", tools: [] },
      requestKey: "k",
      pickupDeadlineAt: new Date(Date.now() + 3 * H),
      answerDeadlineAt: new Date(Date.now() + 4 * H),
    });
    store.jobs.get(job.id)!.createdAt = new Date(Date.now() - pendingMinutes * 60_000);
    return store;
  }

  const fakes = () => ({
    telegramLinker: vi.fn(async () => null as string | null),
    sendTelegram: vi.fn(async () => {}),
    sendWhatsapp: vi.fn(async () => {}),
  });

  it("silent 2 h with work waiting: one notice on the linked Telegram, never twice; nothing while the runner is fresh", async () => {
    const store = await silentOrg(`${ORG}-tg`, 3, 130);
    const f = fakes();
    f.telegramLinker.mockResolvedValue(USER);
    const deps: SilenceDeps = { store, db, ...f };
    expect(await notifySilentRunners(deps)).toEqual([{ orgId: `${ORG}-tg`, door: "telegram" }]);
    expect(f.sendTelegram).toHaveBeenCalledWith({ orgId: `${ORG}-tg`, text: silenceNoticeText(1) });
    expect(silenceNoticeText(1)).toContain("2 hours");
    expect(silenceNoticeText(1)).not.toMatch(/[—–]/);
    expect(await notifySilentRunners(deps)).toEqual([]);
    expect(f.sendTelegram).toHaveBeenCalledTimes(1);
    // The routine comes back: the next silence is told again.
    await store.touchRunner(`${ORG}-tg`, new Date(), { name: "claude-routine", version: null, kind: "routine" });
    expect((await store.getOrg(`${ORG}-tg`))?.silenceNotifiedAt).toBeNull();

    const fresh = await silentOrg(`${ORG}-fresh`, 1, 130);
    expect(await notifySilentRunners({ store: fresh, db, ...fakes() })).toEqual([]);
    const young = await silentOrg(`${ORG}-young`, null, 100);
    expect(await notifySilentRunners({ store: young, db, ...fakes() })).toEqual([]);
  });

  it("no Telegram: the WhatsApp number of their Copilot thread; a refused send is retried next tick", async () => {
    const orgId = `${ORG}-wa`;
    await client`INSERT INTO sessions (org_id, user_id, config_key, channel_phone) VALUES (${orgId}, ${USER}, 'copilot', '+33600000000')`;
    const store = await silentOrg(orgId, null, 125);
    const f = fakes();
    f.sendWhatsapp.mockRejectedValueOnce(new Error("crm 502"));
    const deps: SilenceDeps = { store, db, ...f };
    expect(await notifySilentRunners(deps)).toEqual([{ orgId, door: "failed" }]);
    expect(await notifySilentRunners(deps)).toEqual([{ orgId, door: "whatsapp" }]);
    expect(f.sendWhatsapp).toHaveBeenLastCalledWith(expect.objectContaining({ orgId, userId: USER, phone: "+33600000000", text: silenceNoticeText(1) }));
    expect(await notifySilentRunners(deps)).toEqual([]);
    expect(f.sendWhatsapp).toHaveBeenCalledTimes(2);
  });

  it("no Telegram, no WhatsApp: the notice lands in their Copilot chat", async () => {
    const orgId = `${ORG}-chat`;
    const [session] = await client`INSERT INTO sessions (org_id, user_id, config_key) VALUES (${orgId}, ${USER}, 'copilot') RETURNING id`;
    const store = await silentOrg(orgId, 5, 200);
    expect(await notifySilentRunners({ store, db, ...fakes() })).toEqual([{ orgId, door: "chat" }]);
    const rows = await client`SELECT role, content FROM messages WHERE session_id = ${session!.id}`;
    expect(rows).toEqual([{ role: "assistant", content: silenceNoticeText(1) }]);
    expect((await store.getOrg(orgId))?.silenceNoticeChannel).toBe("chat");
  });
});
