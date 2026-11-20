-- DISTRY-PROMPT-PARTS-1120: every text Distry reads is a part, in an order staff set.
-- prompt_parts = { order, texts, toolDescriptions } (only what staff changed); NULL = the code's.
-- distry_prompt_samples = the last real Distry turn per audience, as the model received it.
-- Hand-authored and idempotent.
ALTER TABLE "distry_config_versions" ADD COLUMN IF NOT EXISTS "prompt_parts" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "distry_prompt_samples" (
  "audience" text PRIMARY KEY NOT NULL,
  "version" integer,
  "org_id" text NOT NULL,
  "session_id" text,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "system_prompt" text NOT NULL,
  "turn_context" text NOT NULL,
  "tools" jsonb NOT NULL,
  "parts" jsonb NOT NULL,
  "history_messages" integer NOT NULL,
  "user_message" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
