-- Move tracking columns from messages to sessions, add run tracking to sessions

-- Step 1: Add new columns to sessions
ALTER TABLE "sessions" ADD COLUMN "run_id" uuid;
ALTER TABLE "sessions" ADD COLUMN "parent_run_id" uuid;
ALTER TABLE "sessions" ADD COLUMN "campaign_id" text;
ALTER TABLE "sessions" ADD COLUMN "brand_ids" text[];
ALTER TABLE "sessions" ADD COLUMN "workflow_slug" text;
ALTER TABLE "sessions" ADD COLUMN "feature_slug" text;

-- Step 2: Backfill from the latest message per session that has tracking data
UPDATE "sessions" s SET
  "campaign_id" = sub."campaign_id",
  "brand_ids" = sub."brand_ids",
  "workflow_slug" = sub."workflow_slug",
  "feature_slug" = sub."feature_slug",
  "run_id" = sub."run_id"
FROM (
  SELECT DISTINCT ON (session_id)
    session_id,
    campaign_id,
    brand_ids,
    workflow_slug,
    feature_slug,
    run_id
  FROM "messages"
  WHERE campaign_id IS NOT NULL
     OR brand_ids IS NOT NULL
     OR workflow_slug IS NOT NULL
     OR feature_slug IS NOT NULL
     OR run_id IS NOT NULL
  ORDER BY session_id, created_at DESC
) sub
WHERE s.id = sub.session_id;

-- Step 3: Drop tracking columns from messages
ALTER TABLE "messages" DROP COLUMN "run_id";
ALTER TABLE "messages" DROP COLUMN "campaign_id";
ALTER TABLE "messages" DROP COLUMN "brand_ids";
ALTER TABLE "messages" DROP COLUMN "workflow_slug";
ALTER TABLE "messages" DROP COLUMN "feature_slug";

-- Step 4: Add index for transfer-brand queries on sessions
CREATE INDEX "sessions_org_brand_idx" ON "sessions" ("org_id", "brand_ids");
