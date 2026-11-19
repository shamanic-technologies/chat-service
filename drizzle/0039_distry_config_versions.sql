-- DISTRY-PRINCIPAL-1119: Distry's definition (prompt, tools, skills, model) is
-- stored and versioned; staff edit it from dashboard v2 Monitoring > Distry.
-- Every save is a new row (version + 1); the current one is the highest version
-- and is materialized onto platform_configs.key = 'copilot' (what /chat reads).
-- Version 1 = the code's values at ship. Hand-authored and idempotent.
CREATE TABLE IF NOT EXISTS "distry_config_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "version" integer NOT NULL,
  "system_prompt" text NOT NULL,
  "enabled_tools" jsonb NOT NULL,
  "skill_slugs" jsonb,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "effort" text,
  "edited_by" text NOT NULL,
  "note" text,
  "restored_from" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "distry_config_versions_version_unique" ON "distry_config_versions" ("version");
