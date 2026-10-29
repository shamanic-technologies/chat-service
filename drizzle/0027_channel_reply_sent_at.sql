-- SOPHIE-WA-SIGNED-IN-1029: when a WhatsApp reply was accepted by crm-service.
-- NULL = it never left (a refused send was silent for two days). Backfill:
-- a row marked answered was sent (status only became answered after the send).
ALTER TABLE "channel_inbound_messages" ADD COLUMN IF NOT EXISTS "sent_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "channel_inbound_messages" SET "sent_at" = "updated_at" WHERE "status" = 'answered' AND "sent_at" IS NULL;
--> statement-breakpoint
-- A failed TURN still sent its apology text; only a refused SEND left nothing.
UPDATE "channel_inbound_messages" SET "sent_at" = "updated_at" WHERE "status" = 'failed' AND "sent_at" IS NULL AND "error" IS NOT NULL AND "error" NOT LIKE 'send: %' AND "error" NOT LIKE '%; send: %';
