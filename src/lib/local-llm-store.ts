// ---------------------------------------------------------------------------
// LOCAL-CLAUDE-1116: where an org's "my LLM runs on my own Claude Code"
// declaration and its waiting LLM work live.
//
// One interface, two implementations: Postgres in production (the claim is ONE
// statement with FOR UPDATE SKIP LOCKED, so N runners or N parallel polls never
// get the same item), memory for tests. Every state change is a conditional
// UPDATE on the current status, so a late answer, a double answer or an answer
// to a job its caller gave up on is refused instead of overwriting.
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";

export type LocalJobKind = "complete" | "judgment" | "chat_round";
export type LocalJobStatus = "pending" | "claimed" | "done" | "failed" | "expired";

export interface LocalOrgRow {
  orgId: string;
  declared: boolean;
  declaredByUserId: string | null;
  declaredAt: Date | null;
  runnerLastSeenAt: Date | null;
  runnerName: string | null;
  runnerVersion: string | null;
}

export interface LocalUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  notionalCostUsd: number | null;
  durationMs: number | null;
}

export interface LocalJobRow {
  id: string;
  orgId: string;
  kind: LocalJobKind;
  route: string;
  runId: string | null;
  request: unknown;
  status: LocalJobStatus;
  leaseId: string | null;
  pickupDeadlineAt: Date;
  answerDeadlineAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  result: unknown;
  error: string | null;
  model: string | null;
  usage: LocalUsage;
  createdAt: Date;
}

export interface NewLocalJob {
  orgId: string;
  kind: LocalJobKind;
  route: string;
  runId: string | null;
  request: unknown;
  pickupDeadlineAt: Date;
  answerDeadlineAt: Date;
}

export type LocalAnswerOutcome =
  | { ok: true; result: unknown; model: string; usage: LocalUsage }
  | { ok: false; error: string; model: string | null; usage: LocalUsage };

/** Why an answer was not stored. */
export type SubmitVerdict = "stored" | "not_found" | "lease_mismatch" | "expired" | "already_answered" | "not_claimed";

export interface LocalUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  notionalCostUsd: number;
}

/** One declaring org, with the calls waiting for its runner right now. */
export interface DeclaredLocalOrg extends LocalOrgRow {
  pendingCalls: number;
}

export interface LocalLlmStore {
  listDeclaredOrgIds(): Promise<string[]>;
  /** Every org that declared, oldest declaration first; `orgIds` narrows to those ids (empty array = none). */
  listDeclaredOrgs(at: Date, orgIds?: string[]): Promise<DeclaredLocalOrg[]>;
  getOrg(orgId: string): Promise<LocalOrgRow | null>;
  setDeclared(orgId: string, declared: boolean, userId: string, at: Date): Promise<LocalOrgRow>;
  touchRunner(orgId: string, at: Date, runner: { name: string | null; version: string | null }): Promise<void>;
  enqueue(job: NewLocalJob): Promise<LocalJobRow>;
  /** Atomically hands up to `max` pending, still-wanted jobs of the org to ONE caller. */
  claim(orgId: string, max: number, at: Date): Promise<LocalJobRow[]>;
  getJob(id: string): Promise<LocalJobRow | null>;
  submit(id: string, orgId: string, leaseId: string, outcome: LocalAnswerOutcome, at: Date): Promise<SubmitVerdict>;
  /** Gives up on a job still pending/claimed. false = it was answered (or ended) first. */
  expire(id: string, reason: string, at: Date): Promise<boolean>;
  pendingCount(orgId: string, at: Date): Promise<number>;
  /** Boot: jobs whose caller died with the previous process are ended, never run. */
  expireAbandoned(createdBefore: Date, at: Date): Promise<number>;
  usageSince(orgId: string, since: Date): Promise<LocalUsageTotals>;
}

const NO_USAGE: LocalUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  notionalCostUsd: null,
  durationMs: null,
};

// --- memory (tests) ---------------------------------------------------------

export function createMemoryLocalLlmStore(): LocalLlmStore & { jobs: Map<string, LocalJobRow>; orgs: Map<string, LocalOrgRow> } {
  const orgs = new Map<string, LocalOrgRow>();
  const jobs = new Map<string, LocalJobRow>();
  const blankOrg = (orgId: string): LocalOrgRow => ({
    orgId,
    declared: false,
    declaredByUserId: null,
    declaredAt: null,
    runnerLastSeenAt: null,
    runnerName: null,
    runnerVersion: null,
  });
  return {
    orgs,
    jobs,
    async listDeclaredOrgIds() {
      return [...orgs.values()].filter((o) => o.declared).map((o) => o.orgId);
    },
    async listDeclaredOrgs(at, orgIds) {
      const only = orgIds ? new Set(orgIds) : null;
      return [...orgs.values()]
        .filter((o) => o.declared && (!only || only.has(o.orgId)))
        .sort((a, b) => (a.declaredAt?.getTime() ?? 0) - (b.declaredAt?.getTime() ?? 0))
        .map((o) => ({
          ...o,
          pendingCalls: [...jobs.values()].filter((j) => j.orgId === o.orgId && j.status === "pending" && j.pickupDeadlineAt > at).length,
        }));
    },
    async getOrg(orgId) {
      return orgs.get(orgId) ?? null;
    },
    async setDeclared(orgId, declared, userId, at) {
      const row = { ...(orgs.get(orgId) ?? blankOrg(orgId)) };
      row.declared = declared;
      if (declared) {
        row.declaredByUserId = userId;
        row.declaredAt = at;
      }
      orgs.set(orgId, row);
      return row;
    },
    async touchRunner(orgId, at, runner) {
      const row = { ...(orgs.get(orgId) ?? blankOrg(orgId)) };
      row.runnerLastSeenAt = at;
      if (runner.name) row.runnerName = runner.name;
      if (runner.version) row.runnerVersion = runner.version;
      orgs.set(orgId, row);
    },
    async enqueue(job) {
      const row: LocalJobRow = {
        ...job,
        id: crypto.randomUUID(),
        status: "pending",
        leaseId: null,
        claimedAt: null,
        completedAt: null,
        result: null,
        error: null,
        model: null,
        usage: NO_USAGE,
        createdAt: new Date(),
      };
      jobs.set(row.id, row);
      return row;
    },
    async claim(orgId, max, at) {
      // Synchronous body: no await between the read and the write, so two
      // concurrent claims can never take the same job (the JS twin of SKIP LOCKED).
      const picked = [...jobs.values()]
        .filter((j) => j.orgId === orgId && j.status === "pending" && j.pickupDeadlineAt > at)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, max);
      for (const j of picked) {
        j.status = "claimed";
        j.leaseId = crypto.randomUUID();
        j.claimedAt = at;
      }
      return picked.map((j) => ({ ...j }));
    },
    async getJob(id) {
      const j = jobs.get(id);
      return j ? { ...j } : null;
    },
    async submit(id, orgId, leaseId, outcome, at) {
      const j = jobs.get(id);
      if (!j || j.orgId !== orgId) return "not_found";
      if (j.status === "expired") return "expired";
      if (j.status === "done" || j.status === "failed") return "already_answered";
      if (j.status !== "claimed") return "not_claimed";
      if (j.leaseId !== leaseId) return "lease_mismatch";
      j.status = outcome.ok ? "done" : "failed";
      j.completedAt = at;
      j.result = outcome.ok ? outcome.result : null;
      j.error = outcome.ok ? null : outcome.error;
      j.model = outcome.model;
      j.usage = outcome.usage;
      return "stored";
    },
    async expire(id, reason, at) {
      const j = jobs.get(id);
      if (!j || (j.status !== "pending" && j.status !== "claimed")) return false;
      j.status = "expired";
      j.error = reason;
      j.completedAt = at;
      return true;
    },
    async expireAbandoned(createdBefore, at) {
      let n = 0;
      for (const j of jobs.values()) {
        if ((j.status === "pending" || j.status === "claimed") && j.createdAt < createdBefore) {
          j.status = "expired";
          j.error = "caller_restarted";
          j.completedAt = at;
          n++;
        }
      }
      return n;
    },
    async pendingCount(orgId, at) {
      return [...jobs.values()].filter((j) => j.orgId === orgId && j.status === "pending" && j.pickupDeadlineAt > at).length;
    },
    async usageSince(orgId, since) {
      const done = [...jobs.values()].filter((j) => j.orgId === orgId && j.status === "done" && j.createdAt >= since);
      return {
        calls: done.length,
        inputTokens: done.reduce((s, j) => s + (j.usage.inputTokens ?? 0), 0),
        outputTokens: done.reduce((s, j) => s + (j.usage.outputTokens ?? 0), 0),
        notionalCostUsd: done.reduce((s, j) => s + (j.usage.notionalCostUsd ?? 0), 0),
      };
    },
  };
}

// --- Postgres (production) ----------------------------------------------------

/** The slice of a drizzle client this store needs (raw SQL only). */
export interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

type Raw = Record<string, unknown>;

function rowsOf(result: unknown): Raw[] {
  // drizzle on postgres-js returns the row array itself.
  if (Array.isArray(result)) return result as Raw[];
  const rows = (result as { rows?: unknown }).rows;
  if (Array.isArray(rows)) return rows as Raw[];
  throw new Error("[local-llm-store] unexpected execute() result shape");
}

const dateOrNull = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

function toOrg(r: Raw): LocalOrgRow {
  return {
    orgId: String(r.org_id),
    declared: r.declared === true,
    declaredByUserId: (r.declared_by_user_id as string | null) ?? null,
    declaredAt: dateOrNull(r.declared_at),
    runnerLastSeenAt: dateOrNull(r.runner_last_seen_at),
    runnerName: (r.runner_name as string | null) ?? null,
    runnerVersion: (r.runner_version as string | null) ?? null,
  };
}

function toJob(r: Raw): LocalJobRow {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    kind: r.kind as LocalJobKind,
    route: String(r.route),
    runId: (r.run_id as string | null) ?? null,
    request: r.request,
    status: r.status as LocalJobStatus,
    leaseId: (r.lease_id as string | null) ?? null,
    pickupDeadlineAt: dateOrNull(r.pickup_deadline_at)!,
    answerDeadlineAt: dateOrNull(r.answer_deadline_at)!,
    claimedAt: dateOrNull(r.claimed_at),
    completedAt: dateOrNull(r.completed_at),
    result: r.result ?? null,
    error: (r.error as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    usage: {
      inputTokens: numOrNull(r.input_tokens),
      outputTokens: numOrNull(r.output_tokens),
      cacheReadTokens: numOrNull(r.cache_read_tokens),
      cacheWriteTokens: numOrNull(r.cache_write_tokens),
      notionalCostUsd: numOrNull(r.notional_cost_usd),
      durationMs: numOrNull(r.duration_ms),
    },
    createdAt: dateOrNull(r.created_at)!,
  };
}

const iso = (d: Date) => d.toISOString();

export function createPgLocalLlmStore(db: SqlExecutor): LocalLlmStore {
  const run = async (q: ReturnType<typeof sql>) => rowsOf(await db.execute(q));
  return {
    async listDeclaredOrgIds() {
      return (await run(sql`SELECT org_id FROM local_llm_orgs WHERE declared = true`)).map((r) => String(r.org_id));
    },
    async listDeclaredOrgs(at, orgIds) {
      if (orgIds && orgIds.length === 0) return [];
      const only = orgIds ? sql` AND o.org_id IN (${sql.join(orgIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
      const rows = await run(sql`
        SELECT o.*, (SELECT count(*)::int FROM local_llm_jobs j
          WHERE j.org_id = o.org_id AND j.status = 'pending' AND j.pickup_deadline_at > ${iso(at)}) AS pending_calls
        FROM local_llm_orgs o
        WHERE o.declared = true${only}
        ORDER BY o.declared_at ASC NULLS FIRST, o.org_id ASC`);
      return rows.map((r) => ({ ...toOrg(r), pendingCalls: Number(r.pending_calls ?? 0) }));
    },
    async getOrg(orgId) {
      const [r] = await run(sql`SELECT * FROM local_llm_orgs WHERE org_id = ${orgId}`);
      return r ? toOrg(r) : null;
    },
    async setDeclared(orgId, declared, userId, at) {
      const [r] = declared
        ? await run(sql`
            INSERT INTO local_llm_orgs (org_id, declared, declared_by_user_id, declared_at, updated_at)
            VALUES (${orgId}, true, ${userId}, ${iso(at)}, ${iso(at)})
            ON CONFLICT (org_id) DO UPDATE SET declared = true, declared_by_user_id = ${userId},
              declared_at = ${iso(at)}, updated_at = ${iso(at)}
            RETURNING *`)
        : await run(sql`
            INSERT INTO local_llm_orgs (org_id, declared, updated_at) VALUES (${orgId}, false, ${iso(at)})
            ON CONFLICT (org_id) DO UPDATE SET declared = false, updated_at = ${iso(at)}
            RETURNING *`);
      return toOrg(r);
    },
    async touchRunner(orgId, at, runner) {
      await run(sql`
        INSERT INTO local_llm_orgs (org_id, runner_last_seen_at, runner_name, runner_version, updated_at)
        VALUES (${orgId}, ${iso(at)}, ${runner.name}, ${runner.version}, ${iso(at)})
        ON CONFLICT (org_id) DO UPDATE SET runner_last_seen_at = ${iso(at)},
          runner_name = COALESCE(${runner.name}, local_llm_orgs.runner_name),
          runner_version = COALESCE(${runner.version}, local_llm_orgs.runner_version)`);
    },
    async enqueue(job) {
      const [r] = await run(sql`
        INSERT INTO local_llm_jobs (org_id, kind, route, run_id, request, pickup_deadline_at, answer_deadline_at)
        VALUES (${job.orgId}, ${job.kind}, ${job.route}, ${job.runId}, ${JSON.stringify(job.request)}::jsonb,
          ${iso(job.pickupDeadlineAt)}, ${iso(job.answerDeadlineAt)})
        RETURNING *`);
      return toJob(r);
    },
    async claim(orgId, max, at) {
      const rows = await run(sql`
        UPDATE local_llm_jobs SET status = 'claimed', lease_id = gen_random_uuid(), claimed_at = ${iso(at)}
        WHERE id IN (
          SELECT id FROM local_llm_jobs
          WHERE org_id = ${orgId} AND status = 'pending' AND pickup_deadline_at > ${iso(at)}
          ORDER BY created_at
          LIMIT ${max}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *`);
      return rows.map(toJob).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async getJob(id) {
      const [r] = await run(sql`SELECT * FROM local_llm_jobs WHERE id = ${id}`);
      return r ? toJob(r) : null;
    },
    async submit(id, orgId, leaseId, outcome, at) {
      const u = outcome.usage;
      const [stored] = await run(sql`
        UPDATE local_llm_jobs SET
          status = ${outcome.ok ? "done" : "failed"},
          completed_at = ${iso(at)},
          result = ${outcome.ok ? JSON.stringify(outcome.result ?? null) : null}::jsonb,
          error = ${outcome.ok ? null : outcome.error},
          model = ${outcome.model},
          input_tokens = ${u.inputTokens}, output_tokens = ${u.outputTokens},
          cache_read_tokens = ${u.cacheReadTokens}, cache_write_tokens = ${u.cacheWriteTokens},
          notional_cost_usd = ${u.notionalCostUsd}, duration_ms = ${u.durationMs}
        WHERE id = ${id} AND org_id = ${orgId} AND status = 'claimed' AND lease_id = ${leaseId}
        RETURNING id`);
      if (stored) return "stored";
      const [r] = await run(sql`SELECT status, lease_id, org_id FROM local_llm_jobs WHERE id = ${id}`);
      if (!r || r.org_id !== orgId) return "not_found";
      if (r.status === "expired") return "expired";
      if (r.status === "done" || r.status === "failed") return "already_answered";
      if (r.status !== "claimed") return "not_claimed";
      return "lease_mismatch";
    },
    async expire(id, reason, at) {
      const rows = await run(sql`
        UPDATE local_llm_jobs SET status = 'expired', error = ${reason}, completed_at = ${iso(at)}
        WHERE id = ${id} AND status IN ('pending', 'claimed')
        RETURNING id`);
      return rows.length > 0;
    },
    async expireAbandoned(createdBefore, at) {
      const rows = await run(sql`
        UPDATE local_llm_jobs SET status = 'expired', error = 'caller_restarted', completed_at = ${iso(at)}
        WHERE status IN ('pending', 'claimed') AND created_at < ${iso(createdBefore)}
        RETURNING id`);
      return rows.length;
    },
    async pendingCount(orgId, at) {
      const [r] = await run(sql`
        SELECT count(*)::int AS n FROM local_llm_jobs
        WHERE org_id = ${orgId} AND status = 'pending' AND pickup_deadline_at > ${iso(at)}`);
      return Number(r?.n ?? 0);
    },
    async usageSince(orgId, since) {
      const [r] = await run(sql`
        SELECT count(*)::int AS calls, COALESCE(sum(input_tokens), 0)::bigint AS input_tokens,
          COALESCE(sum(output_tokens), 0)::bigint AS output_tokens,
          COALESCE(sum(notional_cost_usd), 0)::float8 AS notional_cost_usd
        FROM local_llm_jobs WHERE org_id = ${orgId} AND status = 'done' AND created_at >= ${iso(since)}`);
      return {
        calls: Number(r?.calls ?? 0),
        inputTokens: Number(r?.input_tokens ?? 0),
        outputTokens: Number(r?.output_tokens ?? 0),
        notionalCostUsd: Number(r?.notional_cost_usd ?? 0),
      };
    },
  };
}
