CREATE TABLE "app_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"org_id" text NOT NULL,
	"system_prompt" text NOT NULL,
	"mcp_server_url" text,
	"mcp_key_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_configs_app_id_org_id_unique" UNIQUE("app_id","org_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "app_id" text;--> statement-breakpoint
UPDATE "sessions" SET "app_id" = 'mcpfactory' WHERE "app_id" IS NULL;