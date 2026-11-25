-- SOLO-PLAN-1125: a declaring org's runner may be the founder's own Claude routine, taking the waiting
-- work about once an hour. A call's work item now lives for hours (its caller may stop waiting and
-- resend the same call: the answer is kept for it), the runner says which kind it is, and the founder
-- is told once when no runner took their work for about two hours. Hand-authored and idempotent.
ALTER TABLE "local_llm_orgs" ADD COLUMN IF NOT EXISTS "runner_kind" text;
ALTER TABLE "local_llm_orgs" ADD COLUMN IF NOT EXISTS "silence_notified_at" timestamp with time zone;
ALTER TABLE "local_llm_orgs" ADD COLUMN IF NOT EXISTS "silence_notice_channel" text;
ALTER TABLE "local_llm_jobs" ADD COLUMN IF NOT EXISTS "request_key" text;
ALTER TABLE "local_llm_jobs" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "local_llm_jobs_org_request_key_idx" ON "local_llm_jobs" ("org_id", "request_key");
