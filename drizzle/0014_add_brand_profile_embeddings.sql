CREATE TABLE IF NOT EXISTS "brand_profile_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"query_text" text NOT NULL,
	"embedding" jsonb NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_profile_embeddings_org_brand_hash_unique" UNIQUE("org_id","brand_id","content_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_profile_embeddings_org_brand_idx" ON "brand_profile_embeddings" ("org_id","brand_id");
