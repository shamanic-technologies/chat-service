-- Staff copilot chat (2026-10-09): persist rich choice cards + opened pages on
-- assistant messages, and the config key a session was started under so a
-- client can read the user's latest session per config. Idempotent.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "choices" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "open_pages" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "config_key" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_org_user_config_updated_idx" ON "sessions" ("org_id", "user_id", "config_key", "updated_at");
