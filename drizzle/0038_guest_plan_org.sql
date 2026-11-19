-- DISTRY-ONE-AI-1118 increment B: a guest's plan is built on an UNCLAIMED org
-- opened for the conversation (client-service /internal/resolve anonymous: true,
-- the signup page's own org), handed to them by the email proof (claimOrgId).
-- Hand-authored and idempotent (see CLAUDE.md: db:generate is not trusted here).
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "plan_org_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "plan_org_user_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "plan_org_external_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "plan_brand_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "plan_domain" text;
