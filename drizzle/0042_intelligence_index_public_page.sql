-- DISTRY-MODELS-1119 follow-up: the Intelligence Index is read from Artificial Analysis's public
-- leaderboard page when no API key is set. Each read states its source and keeps the raw page;
-- silver keeps every thinking-level variant (one row per Artificial Analysis entry id) and the cost
-- per task of their index run. Both tables were empty in production (no read had run). Idempotent.
ALTER TABLE "intelligence_index_reads" ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint
ALTER TABLE "intelligence_index_reads" ADD COLUMN IF NOT EXISTS "raw_text" text;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'intelligence_index_scores' AND column_name = 'index_cost_usd') THEN
    ALTER TABLE "intelligence_index_scores" RENAME COLUMN "index_cost_usd" TO "index_cost_per_task_usd";
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "intelligence_index_scores" ADD COLUMN IF NOT EXISTS "release_slug" text;--> statement-breakpoint
ALTER TABLE "intelligence_index_scores" ADD COLUMN IF NOT EXISTS "release_name" text;--> statement-breakpoint
ALTER TABLE "intelligence_index_scores" ADD COLUMN IF NOT EXISTS "variant_label" text;--> statement-breakpoint
ALTER TABLE "intelligence_index_scores" ADD COLUMN IF NOT EXISTS "effort" text;--> statement-breakpoint
ALTER TABLE "intelligence_index_scores" DROP CONSTRAINT IF EXISTS "intelligence_index_scores_pk";--> statement-breakpoint
ALTER TABLE "intelligence_index_scores" ADD CONSTRAINT "intelligence_index_scores_pk" PRIMARY KEY ("read_id", "aa_id");
