-- Copilot skill tree + staff requests (2026-10-09). Idempotent, hand-authored.
CREATE TABLE IF NOT EXISTS "skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "parent_slug" text,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "content" text NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skills_slug_unique" UNIQUE("slug")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "skill_id" uuid NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "content" text NOT NULL,
  "edited_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_versions_skill_version_unique" UNIQUE("skill_id", "version")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "brand_id" text,
  "session_id" uuid,
  "kind" text NOT NULL,
  "repo" text NOT NULL,
  "piece_key" text NOT NULL,
  "title" text NOT NULL,
  "user_request" text NOT NULL,
  "decomposition" jsonb NOT NULL,
  "missing_piece" text NOT NULL,
  "requester_is_staff" boolean NOT NULL,
  "issue_url" text,
  "issue_number" integer,
  "issue_error" text,
  "telegram_sent_at" timestamp with time zone,
  "telegram_skipped_reason" text,
  "telegram_error" text,
  "request_count" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "staff_requests_org_repo_kind_piece_unique" UNIQUE("org_id", "repo", "kind", "piece_key")
);
