-- BRAND-MCP-1109: the MCP servers a brand gives to our conversation AI. The
-- Authorization value is a key-service brand key (`mcp-server-<id>`), never
-- stored here; the last connect check is (status, error, tool names).
CREATE TABLE IF NOT EXISTS "brand_mcp_servers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "has_auth" boolean DEFAULT false NOT NULL,
  "created_by_user_id" text NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "tool_names" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brand_mcp_servers_org_brand_url_idx" ON "brand_mcp_servers" ("org_id", "brand_id", "url");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_mcp_servers_org_brand_idx" ON "brand_mcp_servers" ("org_id", "brand_id");
