-- The user turn of a Copilot nudge (the Copilot speaking first): stored so
-- history replay keeps the user/assistant pairing, never shown on reload.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "proactive_trigger" boolean DEFAULT false NOT NULL;
