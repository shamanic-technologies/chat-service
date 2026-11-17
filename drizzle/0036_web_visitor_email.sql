-- DISTRY-WEB-CHAT-EMAIL-1117: the email a site visitor gave to continue there. Set only by
-- chat-service (continue_on_channel); every later page turn re-hands the conversation to
-- crm-service (idempotent on message id) so the Lead event campaign's email follows it.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "channel_email" text;
