-- VENDOR-CREDIT-1030: a vendor out of credit is a stored FACT, red on dashboard
-- v2 Monitoring until a call on it succeeds. One open outage per provider (the
-- partial unique index), closed by the first successful call; a per-UTC-day
-- counter of refused and rerouted calls feeds the daily chart.
CREATE TABLE IF NOT EXISTS "vendor_credit_outages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "recovered_at" timestamp with time zone,
  "refused_calls" integer DEFAULT 0 NOT NULL,
  "rerouted_calls" integer DEFAULT 0 NOT NULL,
  "last_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_credit_outages_open_idx" ON "vendor_credit_outages" ("provider") WHERE "recovered_at" IS NULL;
CREATE INDEX IF NOT EXISTS "vendor_credit_outages_provider_seen_idx" ON "vendor_credit_outages" ("provider", "first_seen_at");
CREATE TABLE IF NOT EXISTS "vendor_credit_days" (
  "day" date NOT NULL,
  "provider" text NOT NULL,
  "refused_calls" integer DEFAULT 0 NOT NULL,
  "rerouted_calls" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "vendor_credit_days_pk" PRIMARY KEY ("day", "provider")
);
