CREATE TABLE IF NOT EXISTS "copilot_handoffs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "campaign_id" text,
  "campaign_started_at" timestamp with time zone,
  "campaign_started_via" text,
  "hellos" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "copilot_handoffs_org_user_idx" ON "copilot_handoffs" ("org_id", "user_id");
--> statement-breakpoint
ALTER TABLE "copilot_proactive_turns" ALTER COLUMN "brand_id" DROP NOT NULL;
