-- LEDGER-HISTORY-1024: a chat config states the support function its /chat turns
-- serve (runs-service SUPPORT_FUNCTIONS), so each turn is marked at creation and
-- never left undeclared. NULL = the turn rides its caller's run. Registration
-- preserves it on omit (buildConfigConflictSet). Idempotent.
ALTER TABLE "app_configs" ADD COLUMN IF NOT EXISTS "support_kind" text;
--> statement-breakpoint
ALTER TABLE "platform_configs" ADD COLUMN IF NOT EXISTS "support_kind" text;
--> statement-breakpoint
-- Dashboard-registered platform configs (the dashboard re-registers them at boot
-- without this field, so the value stays). Same functions their past turns were
-- marked with (COST-SUPPORT-1024 backfill). `default` has no single purpose: left NULL.
UPDATE "platform_configs" SET "support_kind" = 'copilot' WHERE "key" = 'copilot' AND "support_kind" IS NULL;
--> statement-breakpoint
UPDATE "platform_configs" SET "support_kind" = 'product_feature' WHERE "key" IN ('workflow', 'feature', 'press-kit', 'campaign-prefill') AND "support_kind" IS NULL;
