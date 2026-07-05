-- Functional index to accelerate case-insensitive email lookups used by the
-- identity resolution service when materializing connector permission ACLs.
-- The unique constraint on "email" is case-sensitive and cannot serve
-- `LOWER("email") IN (...)` queries, so this expression index is required
-- for production-scale organizations.
CREATE INDEX IF NOT EXISTS "user_lower_email_idx" ON "user" (LOWER("email"));
