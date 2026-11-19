-- DISTRY-ONE-AI-1118: a website visitor signs up or in in the page chat, and a
-- message the site sends again reads its whole stored answer back.
-- Hand-authored and idempotent (see CLAUDE.md: db:generate is not trusted here).
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "web_account_email" text;--> statement-breakpoint
ALTER TABLE "channel_inbound_messages" ADD COLUMN IF NOT EXISTS "signed_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_inbound_messages" ADD COLUMN IF NOT EXISTS "answer" jsonb;
