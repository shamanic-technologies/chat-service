-- SKILL-TREE-EDIT-1122: staff delete and move skills from the dashboard.
-- deleted_at/deleted_by = a soft delete (versions kept, no agent reads it, the seed never re-creates it).
-- placed_by = a staff member set this skill's parent/order: the seed stops moving it back.
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "placed_by" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "deleted_by" text;
