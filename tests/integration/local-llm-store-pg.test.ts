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
    pickupDeadlineAt: new Date(Date.now() + 60_000),
    answerDeadlineAt: new Date(Date.now() + 120_000),
  });

  it("declares and reads back the org", async () => {
    const row = await store.setDeclared(ORG, true, "user-1", new Date());
    expect(row.declared).toBe(true);
    expect(await store.listDeclaredOrgIds()).toContain(ORG);
    await store.touchRunner(ORG, new Date(), { name: "mac-app", version: null });
    expect((await store.getOrg(ORG))?.runnerName).toBe("mac-app");
  });

  it("10 parallel claims over 10 calls: each call to exactly one claim", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.enqueue(job(i))));
    expect(await store.pendingCount(ORG, new Date())).toBe(10);
    const claims = await Promise.all(Array.from({ length: 10 }, () => store.claim(ORG, 3, new Date())));
    const ids = claims.flat().map((j) => j.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(await store.pendingCount(ORG, new Date())).toBe(0);
  });

  it("an answer lands once, on its own lease; a given-up call refuses it", async () => {
    const queued = await store.enqueue(job(99));
    const [claimed] = await store.claim(ORG, 1, new Date());
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
    const [lateClaim] = await store.claim(ORG, 1, new Date());
    expect(await store.expire(late.id, "local_runner_timeout", new Date())).toBe(true);
    expect(await store.submit(late.id, ORG, lateClaim.leaseId!, ok, new Date())).toBe("expired");
    expect((await store.usageSince(ORG, new Date(Date.now() - 3600_000))).calls).toBe(1);
  });

  it("a call past its pickup deadline is never handed out", async () => {
    await store.enqueue({ ...job(200), pickupDeadlineAt: new Date(Date.now() - 1000) });
    expect(await store.claim(ORG, 5, new Date())).toEqual([]);
  });
});
