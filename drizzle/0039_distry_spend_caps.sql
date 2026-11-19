-- DISTRY-GUEST-CAPS-1119 (owner 2026-11-19): Distry's spend on non-clients is capped in DOLLARS
-- read from the runs ledger: $5 per unidentified visitor, $30 a day for all non-clients together.
-- These tables say which runs and orgs are non-client spend and what was refused; the figures
-- themselves are read from runs-service. Hand-authored and idempotent.
CREATE TABLE IF NOT EXISTS "distry_spend_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "day" text NOT NULL,
  "person_key" text NOT NULL,
  "surface" text NOT NULL,
  "org_id" text NOT NULL,
  "run_id" text,
  "verdict" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "distry_spend_turns_person_idx" ON "distry_spend_turns" ("person_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "distry_spend_turns_day_idx" ON "distry_spend_turns" ("day");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "distry_spend_orgs" (
  "day" text NOT NULL,
  "org_id" text NOT NULL,
  "kind" text NOT NULL,
  "start_cents" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("day", "org_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "distry_spend_days" (
  "day" text PRIMARY KEY NOT NULL,
  "spend_cents" text NOT NULL,
  "threshold_cents" text NOT NULL,
  "refreshed_at" timestamp with time zone NOT NULL,
  "alert_fired_at" timestamp with time zone,
  "alert_telegram_at" timestamp with time zone,
  "alert_email_at" timestamp with time zone,
  "alert_error" text
);
