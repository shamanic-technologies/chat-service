-- Add per-config `thinking_level` to chat config tables.
-- NULL = use the code default (GEMINI_3_THINKING_LEVEL = "low"). Only applied on
-- the /chat Gemini-3 path; /complete never reads it (must stay low). Idempotent
-- and boot-safe: nullable, no backfill.

ALTER TABLE "app_configs" ADD COLUMN IF NOT EXISTS "thinking_level" text;
ALTER TABLE "platform_configs" ADD COLUMN IF NOT EXISTS "thinking_level" text;
