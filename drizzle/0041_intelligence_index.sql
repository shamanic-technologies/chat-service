-- DISTRY-MODELS-1119: the Artificial Analysis Intelligence Index, read daily, for the Distry
-- editor's model panel (price, score, rank, intelligence per dollar). Bronze = every read as
-- received (or its failure), silver = one row per Artificial Analysis model per read.
-- Hand-authored and idempotent.
CREATE TABLE IF NOT EXISTS "intelligence_index_reads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text NOT NULL,
  "http_status" integer,
  "error" text,
  "index_version" text,
  "body" jsonb
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intelligence_index_reads_fetched_idx" ON "intelligence_index_reads" ("fetched_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_index_scores" (
  "read_id" uuid NOT NULL REFERENCES "intelligence_index_reads"("id"),
  "aa_id" text NOT NULL,
  "aa_slug" text NOT NULL,
  "aa_name" text NOT NULL,
  "creator" text,
  "index_version" text NOT NULL,
  "score" real,
  "index_cost_usd" real,
  "price_input_per_1m_usd" real,
  "price_output_per_1m_usd" real,
  "fetched_at" timestamp with time zone NOT NULL,
  CONSTRAINT "intelligence_index_scores_pk" PRIMARY KEY ("read_id", "aa_slug")
);
