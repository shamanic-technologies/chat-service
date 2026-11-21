-- EVAL-SPEND-CAP-1121: an eval run can no longer burn money unseen.
-- eval_spend = every eval replay's money, reserved before the call and settled at its measured
-- cost (runs-service's answer): the fleet-wide daily ceiling reads it under one advisory lock.
-- eval_replay_cache = a judged replay kept under its key (definition + code + scenario + model +
-- settings + judge): an unchanged replay is reused at $0 instead of replayed.
-- Hand-authored and idempotent.
CREATE TABLE IF NOT EXISTS "eval_spend" (
  "id" serial PRIMARY KEY NOT NULL,
  "day" text NOT NULL,
  "run_key" text NOT NULL,
  "reserved_cents" numeric NOT NULL,
  "spent_cents" numeric,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_spend_day_idx" ON "eval_spend" ("day");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_replay_cache" (
  "id" serial PRIMARY KEY NOT NULL,
  "cache_key" text NOT NULL,
  "scenario_id" text NOT NULL,
  "model" text NOT NULL,
  "cost_usd" numeric NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_replay_cache_key_idx" ON "eval_replay_cache" ("cache_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_replay_cache_model_idx" ON "eval_replay_cache" ("model", "created_at");
