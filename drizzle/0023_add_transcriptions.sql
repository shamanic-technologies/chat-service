-- Speech transcriptions of a video/audio file behind a URL (platform callers).
CREATE TABLE IF NOT EXISTS "transcriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" text NOT NULL,
  "source_url" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "model" text NOT NULL,
  "run_id" uuid,
  "languages" text[],
  "segments" jsonb,
  "duration_seconds" real,
  "tokens_input" integer,
  "tokens_output" integer,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
