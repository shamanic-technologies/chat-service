ALTER TABLE "app_configs" DROP CONSTRAINT "app_configs_app_id_org_id_unique";--> statement-breakpoint
ALTER TABLE "app_configs" DROP COLUMN "app_id";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "app_id";--> statement-breakpoint
ALTER TABLE "app_configs" ADD CONSTRAINT "app_configs_org_id_unique" UNIQUE("org_id");