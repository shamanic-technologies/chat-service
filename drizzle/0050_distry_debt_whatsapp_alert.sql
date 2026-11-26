-- SOLO-PLAN-1125: the non-payers' debt-growth alert also goes to the owner's WhatsApp (owner 2026-11-25),
-- beside Telegram and the staff email, once per UTC day. Hand-authored and idempotent.
ALTER TABLE "distry_spend_days" ADD COLUMN IF NOT EXISTS "alert_whatsapp_at" timestamp with time zone;
