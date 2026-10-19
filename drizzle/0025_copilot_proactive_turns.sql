-- A proactive Copilot turn a campaign step asked for (HOT-LEAD-PROPOSAL-1019):
-- one row per (org, idempotency key), so a retried step never writes twice.
CREATE TABLE IF NOT EXISTS "copilot_proactive_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" text NOT NULL,
  "kind" text NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "recipient_user_id" text NOT NULL,
  "session_id" uuid NOT NULL,
  "delivery" text NOT NULL,
  "status" text NOT NULL,
  "parent_run_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "reply_text" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "copilot_proactive_turns_org_key_idx" ON "copilot_proactive_turns" ("org_id", "idempotency_key");
