-- LOCAL-CLAUDE-1116: an org whose LLM runs on its own Claude Code subscription, on the user's machine.
-- local_llm_orgs = the org's declaration + its runner's last heartbeat; local_llm_jobs = every LLM call
-- chat-service would have made for that org, waiting for / claimed by / answered by the runner, with the
-- usage the CLI reported (measured, never billed: the org pays $0 for these calls).
CREATE TABLE IF NOT EXISTS "local_llm_orgs" (
  "org_id" text PRIMARY KEY NOT NULL,
  "declared" boolean DEFAULT false NOT NULL,
  "declared_by_user_id" text,
  "declared_at" timestamp with time zone,
  "runner_last_seen_at" timestamp with time zone,
  "runner_name" text,
  "runner_version" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "local_llm_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "kind" text NOT NULL,
  "route" text NOT NULL,
  "run_id" uuid,
  "request" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "lease_id" uuid,
  "pickup_deadline_at" timestamp with time zone NOT NULL,
  "answer_deadline_at" timestamp with time zone NOT NULL,
  "claimed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "result" jsonb,
  "error" text,
  "model" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "cache_read_tokens" integer,
  "cache_write_tokens" integer,
  "notional_cost_usd" real,
  "duration_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "local_llm_jobs_org_status_idx" ON "local_llm_jobs" ("org_id", "status", "created_at");
