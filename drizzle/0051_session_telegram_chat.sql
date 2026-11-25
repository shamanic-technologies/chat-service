ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "telegram_chat_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_telegram_chat_idx" ON "sessions" ("telegram_chat_id");
