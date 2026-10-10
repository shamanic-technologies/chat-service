-- contact_human requests reach a person, not a repo: repo becomes optional.
-- Idempotent: DROP NOT NULL on a nullable column is a no-op.
ALTER TABLE "staff_requests" ALTER COLUMN "repo" DROP NOT NULL;
