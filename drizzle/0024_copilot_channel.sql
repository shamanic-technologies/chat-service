-- The Copilot on WhatsApp (SOPHIE-COPILOT-WA-1018): a session can be talking to a
-- WhatsApp number, and a number with no account yet is a guest session.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "channel_phone" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "guest" boolean DEFAULT false NOT NULL;
CREATE INDEX IF NOT EXISTS "sessions_channel_phone_idx" ON "sessions" ("channel_phone");
-- One row per inbound channel message crm-service hands over: dedupes a retry,
-- and records what was answered (or why not).
CREATE TABLE IF NOT EXISTS "channel_inbound_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" text NOT NULL,
  "channel" text NOT NULL,
  "sender_phone" text NOT NULL,
  "org_id" text,
  "user_id" text,
  "session_id" uuid,
  "status" text NOT NULL,
  "reply_text" text,
  "error" text,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "channel_inbound_messages_message_id_idx" ON "channel_inbound_messages" ("message_id");
