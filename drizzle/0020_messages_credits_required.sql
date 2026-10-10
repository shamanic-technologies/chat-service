-- Out-of-credits turns (owner 2026-10-10): the "Add credits" action is stored on the
-- assistant message so a reload draws the button again. Idempotent.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "credits_required" jsonb;
