-- SOPHIE-JCURVE-1102: a Lead event turn never lands in a client's web chat.
-- Lead turns of an account holder ran in that person's latest Copilot session
-- (the thread the web shows): prod 2026-11-01, Jcurve's CMO saw an HTML email
-- body ("<p>Hi James...") and empty replies in his dashboard chat. From now on
-- they run in a session of their own (`lead_thread`), never served by
-- GET /sessions/latest.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "lead_thread" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- The answers past lead turns left in a web session: hidden like their trigger
-- (still replayed to the model, never shown). Idempotent: flagged rows no longer match.
UPDATE "messages" AS a SET "proactive_trigger" = true
FROM (
  SELECT "id", lag("content") OVER (PARTITION BY "session_id" ORDER BY "created_at") AS "prev"
  FROM "messages"
) AS o
WHERE a."id" = o."id"
  AND a."role" = 'assistant'
  AND a."proactive_trigger" = false
  AND o."prev" = '(Not the person''s words.) A Lead event about this person: decide and answer through answer_person.';
