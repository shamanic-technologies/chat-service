import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPgLocalLlmStore, type LocalLlmStore } from "../../src/lib/local-llm-store.js";

// LOCAL-CLAUDE-1116, on a real Postgres (CI's throwaway container, migrated
// from the journal): parallel claims never hand one call to two runners, an
// answer only lands once, on its own lease, and never on a call its caller
// gave up on.

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const ORG = `org-local-pg-${Date.now()}`;

describe("local LLM store on Postgres", { timeout: 30_000 }, () => {
  let client: ReturnType<typeof postgres>;
  let store: LocalLlmStore;

  beforeAll(() => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL is required");
    client = postgres(connectionString, { max: 12 });
    store = createPgLocalLlmStore(drizzle(client));
  });

  afterAll(async () => {
    await client`DELETE FROM local_llm_jobs WHERE org_id = ${ORG}`;
    await client`DELETE FROM local_llm_orgs WHERE org_id = ${ORG}`;
    await client.end();
  });

  const job = (n: number) => ({
    orgId: ORG,
    kind: "complete" as const,
    route: "/complete",
    runId: null,
    request: { prompt: `q${n}`, systemPrompt: "", jsonSchema: null, model: "claude-haiku-5-5", tools: [] },
    requestKey: null as string | null,
    pickupDeadlineAt: new Date(Date.now() + 60_000),
    answerDeadlineAt: new Date(Date.now() + 120_000),
  });

  it("declares and reads back the org", async () => {
    const row = await store.setDeclared(ORG, true, "user-1", new Date());
    expect(row.declared).toBe(true);
    expect(await store.listDeclaredOrgIds()).toContain(ORG);
    await store.touchRunner(ORG, new Date(), { name: "mac-app", version: null, kind: null });
    expect((await store.getOrg(ORG))?.runnerName).toBe("mac-app");
  });

  it("10 parallel claims over 10 calls: each call to exactly one claim", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.enqueue(job(i))));
    expect(await store.pendingCount(ORG, new Date())).toBe(10);
    const claims = await Promise.all(Array.from({ length: 10 }, () => store.claim(ORG, 3, new Date(), 60_000)));
    const ids = claims.flat().map((j) => j.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(await store.pendingCount(ORG, new Date())).toBe(0);
  });

  it("an answer lands once, on its own lease; a given-up call refuses it", async () => {
    const queued = await store.enqueue(job(99));
    const [claimed] = await store.claim(ORG, 1, new Date(), 60_000);
    expect(claimed.id).toBe(queued.id);
    const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, notionalCostUsd: 0.001, durationMs: 50 };
    const ok = { ok: true as const, result: { text: "hi" }, model: "claude-haiku-5-5", usage };
    expect(await store.submit(claimed.id, ORG, crypto.randomUUID(), ok, new Date())).toBe("lease_mismatch");
    expect(await store.submit(claimed.id, ORG, claimed.leaseId!, ok, new Date())).toBe("stored");
    expect(await store.submit(claimed.id, ORG, claimed.leaseId!, ok, new Date())).toBe("already_answered");
    const stored = await store.getJob(claimed.id);
    expect(stored).toMatchObject({ status: "done", model: "claude-haiku-5-5", result: { text: "hi" } });
    expect(stored!.usage.inputTokens).toBe(10);

    const late = await store.enqueue(job(100));
    const [lateClaim] = await store.claim(ORG, 1, new Date(), 60_000);
    expect(await store.expire(late.id, "local_runner_timeout", new Date())).toBe(true);
    expect(await store.submit(late.id, ORG, lateClaim.leaseId!, ok, new Date())).toBe("expired");
    expect((await store.usageSince(ORG, new Date(Date.now() - 3600_000))).calls).toBe(1);
  });

  it("a call past its pickup deadline is never handed out", async () => {
    await store.enqueue({ ...job(200), pickupDeadlineAt: new Date(Date.now() - 1000) });
    expect(await store.claim(ORG, 5, new Date(), 60_000)).toEqual([]);
  });

  it("LOCAL-CLAUDE-ORGS-1116: lists declaring orgs with their waiting calls, narrowed by id", async () => {
    const at = new Date();
    await store.setDeclared(ORG, true, "user-pg", at);
    await store.enqueue(job(900));
    const all = await store.listDeclaredOrgs(new Date());
    const mine = all.find((o) => o.orgId === ORG);
    expect(mine).toMatchObject({ declared: true, declaredByUserId: "user-pg" });
    expect(mine!.pendingCalls).toBeGreaterThanOrEqual(1);
    expect((await store.listDeclaredOrgs(new Date(), [ORG])).map((o) => o.orgId)).toEqual([ORG]);
    expect(await store.listDeclaredOrgs(new Date(), [])).toEqual([]);
    expect(await store.listDeclaredOrgs(new Date(), [`${ORG}-nobody`])).toEqual([]);
  });

  it("SOLO-PLAN-1125: a resent call finds its job while it waits, then its answer once; a delivered answer is never handed out again", async () => {
    const key = `key-${Date.now()}`;
    const queued = await store.enqueue({ ...job(300), requestKey: key, pickupDeadlineAt: new Date(Date.now() + 3 * 3600_000) });
    const since = new Date(Date.now() - 3 * 3600_000);
    expect((await store.findReusable(ORG, key, new Date(), since))?.id).toBe(queued.id);
    expect(await store.findReusable(ORG, "another-key", new Date(), since)).toBeNull();
    const claimedAt = new Date();
    const claimed = (await store.claim(ORG, 10, claimedAt, 30 * 60_000)).find((j) => j.id === queued.id)!;
    expect(claimed.answerDeadlineAt.getTime()).toBe(claimedAt.getTime() + 30 * 60_000);
    expect((await store.findReusable(ORG, key, new Date(), since))?.status).toBe("claimed");
    const usage = { inputTokens: 5, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, notionalCostUsd: null, durationMs: null };
    expect(await store.submit(queued.id, ORG, claimed.leaseId!, { ok: true, result: { text: "late" }, model: "claude-haiku-5-5", usage }, new Date())).toBe("stored");
    expect((await store.findReusable(ORG, key, new Date(), since))?.status).toBe("done");
    await store.markDelivered(queued.id, new Date());
    expect(await store.findReusable(ORG, key, new Date(), since)).toBeNull();
  });

  it("SOLO-PLAN-1125: an org whose work waits 2 h with no runner is listed once; a runner coming back clears it", async () => {
    const SILENT = `${ORG}-silent`;
    try {
      await store.setDeclared(SILENT, true, "user-s", new Date());
      await store.enqueue({ ...job(400), orgId: SILENT, pickupDeadlineAt: new Date(Date.now() + 3 * 3600_000) });
      await client`UPDATE local_llm_jobs SET created_at = now() - interval '130 minutes' WHERE org_id = ${SILENT}`;
      await client`UPDATE local_llm_orgs SET runner_last_seen_at = now() - interval '3 hours' WHERE org_id = ${SILENT}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      const listed = (await store.listSilentOrgs(new Date(), twoHoursAgo)).filter((o) => o.orgId === SILENT);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ pendingCalls: 1, declaredByUserId: "user-s" });
      expect(await store.claimSilenceNotice(SILENT, new Date())).toBe(true);
      expect(await store.claimSilenceNotice(SILENT, new Date())).toBe(false);
      await store.settleSilenceNotice(SILENT, "telegram");
      expect((await store.getOrg(SILENT))?.silenceNoticeChannel).toBe("telegram");
      expect((await store.listSilentOrgs(new Date(), twoHoursAgo)).some((o) => o.orgId === SILENT)).toBe(false);
      await store.touchRunner(SILENT, new Date(), { name: "claude-routine", version: null, kind: "routine" });
      expect(await store.getOrg(SILENT)).toMatchObject({ runnerKind: "routine", silenceNotifiedAt: null });
    } finally {
      await client`DELETE FROM local_llm_jobs WHERE org_id = ${SILENT}`;
      await client`DELETE FROM local_llm_orgs WHERE org_id = ${SILENT}`;
    }
  });

  it("SOLO-PLAN-1125: a restart ends only the chat rounds it cut off; other calls stay queued for a resend", async () => {
    const R = `${ORG}-restart`;
    try {
      const c = await store.enqueue({ ...job(500), orgId: R });
      const r = await store.enqueue({ ...job(501), orgId: R, kind: "chat_round" });
      await store.expireAbandoned(new Date(Date.now() + 1000), new Date(), ["chat_round"]);
      expect((await store.getJob(c.id))?.status).toBe("pending");
      expect((await store.getJob(r.id))?.status).toBe("expired");
    } finally {
      await client`DELETE FROM local_llm_jobs WHERE org_id = ${R}`;
    }
  });
});
