-- Add audience_id to sessions for per-audience cost attribution.
-- Idempotent: ADD COLUMN IF NOT EXISTS is safe on partial-apply replay.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "audience_id" text;
