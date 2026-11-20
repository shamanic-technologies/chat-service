-- DISTRY-MODELS-1119: the public-page read (0042's `raw_text`) was removed the same day: the owner got an
-- Artificial Analysis API key. No row ever carried a raw page. Idempotent.
ALTER TABLE "intelligence_index_reads" DROP COLUMN IF EXISTS "raw_text";
