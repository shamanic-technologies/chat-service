-- MON-PAGE-SPEED-1114: GET /sessions/* reads a session's messages (newest page first): index them by session,
-- in read order, instead of scanning the whole messages table.
CREATE INDEX IF NOT EXISTS "messages_session_created_idx" ON "messages" ("session_id", "created_at", "id");
