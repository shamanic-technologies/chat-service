-- Add provider and model columns to chat config tables
-- NULL = use default (anthropic / sonnet) for backward compatibility

ALTER TABLE "app_configs" ADD COLUMN "provider" text;
ALTER TABLE "app_configs" ADD COLUMN "model" text;
ALTER TABLE "platform_configs" ADD COLUMN "provider" text;
ALTER TABLE "platform_configs" ADD COLUMN "model" text;
