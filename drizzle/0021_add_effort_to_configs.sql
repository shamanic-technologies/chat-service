-- Per-config Anthropic thinking effort for /chat (output_config.effort). NULL = the
-- model's own default, byte-identical to before. Idempotent.
ALTER TABLE "app_configs" ADD COLUMN IF NOT EXISTS "effort" text;
--> statement-breakpoint
ALTER TABLE "platform_configs" ADD COLUMN IF NOT EXISTS "effort" text;
