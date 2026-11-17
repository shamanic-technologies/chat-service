-- DISTRY-WEB-CHAT-1117: a visitor of our public site talks to the Copilot in the page.
-- sessions.web_visitor_id = the visitor's opaque id (the site's first-party cookie): one
-- conversation per visitor across page loads. The WhatsApp number a visitor gives goes to
-- channel_phone, as for leads, so their WhatsApp reply continues the same conversation.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "web_visitor_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_web_visitor_idx" ON "sessions" ("web_visitor_id");
