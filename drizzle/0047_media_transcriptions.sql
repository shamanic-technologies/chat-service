-- REELS-1124: one transcription of a long audio/video recording, run on our own server
-- (the transcriber sidecar: an open speech model on our CPU, charged $0, no vendor).
-- The source URL is stored WITHOUT its query string (a presigned signature is never kept).
-- status: downloading (source -> sidecar) | transcribing | completed | failed.
-- Hand-authored and idempotent.
CREATE TABLE IF NOT EXISTS "media_transcriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "idempotency_key" text,
  "status" text NOT NULL,
  "source_url" text NOT NULL,
  "mime_type" text,
  "size_bytes" bigint,
  "language_hint" text,
  "run_id" uuid,
  "model" text,
  "language" text,
  "language_probability" real,
  "duration_seconds" real,
  "transcribed_seconds" real,
  "compute_seconds" real,
  "segments" jsonb,
  "words" jsonb,
  "segment_count" integer,
  "word_count" integer,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "media_transcriptions_org_idempotency_idx" ON "media_transcriptions" ("org_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_transcriptions_status_idx" ON "media_transcriptions" ("status");
