-- ONE-AI-CONVERSES-1029: one Copilot answer per Lead event occurrence. A retried
-- writer node (same org, same idempotency key) gets the stored answer, never a
-- second turn (a second sign-in code, a second message).
CREATE TABLE IF NOT EXISTS "copilot_lead_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" text NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "status" text NOT NULL,
  "session_id" uuid,
  "account_org_id" text,
  "account_user_id" text,
  "signed_in" boolean DEFAULT false NOT NULL,
  "answer" jsonb,
  "model" text,
  "error" text,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "copilot_lead_turns_org_key_idx" ON "copilot_lead_turns" ("org_id", "idempotency_key");
