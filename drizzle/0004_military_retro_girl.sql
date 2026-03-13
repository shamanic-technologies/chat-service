CREATE TABLE "platform_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"system_prompt" text NOT NULL,
	"mcp_server_url" text,
	"mcp_key_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_configs_key_unique" UNIQUE("key")
);
