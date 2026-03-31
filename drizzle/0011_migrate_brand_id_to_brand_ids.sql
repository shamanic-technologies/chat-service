-- Migrate brand_id (text) to brand_ids (text[]) on messages table
ALTER TABLE "messages" ADD COLUMN "brand_ids" text[];

-- Migrate existing single-brand data into the array column
UPDATE "messages" SET "brand_ids" = ARRAY["brand_id"] WHERE "brand_id" IS NOT NULL;

-- Drop the old column
ALTER TABLE "messages" DROP COLUMN "brand_id";

-- Add GIN index for efficient ANY() queries on brand_ids
CREATE INDEX "messages_brand_ids_idx" ON "messages" USING GIN ("brand_ids");
