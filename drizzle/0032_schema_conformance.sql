-- SCHEMA-HONOURED-1115: does a schema'd answer follow the caller's responseSchema? Measured on every answer
-- (never a refusal yet), counted per UTC day x provider x model x route, with the latest violations; feeds the
-- dashboard v2 Monitoring chart through GET /internal/schema-conformance.
CREATE TABLE IF NOT EXISTS "schema_conformance_days" (
  "day" date NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "route" text NOT NULL,
  "answered_calls" integer DEFAULT 0 NOT NULL,
  "non_conforming_calls" integer DEFAULT 0 NOT NULL,
  "last_violations" text,
  "last_non_conforming_at" timestamp with time zone,
  CONSTRAINT "schema_conformance_days_pk" PRIMARY KEY ("day", "provider", "model", "route")
);
