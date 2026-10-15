-- Migration 082 (Phase B4): user password management.
-- 1. users.must_change_password: set by an administrative reset (temporary password); cleared when the user chooses a new
--    password. While TRUE the API only allows change-password, session read and logout.
-- 2. users.password_changed_at: when the password was last changed (informational; never contains secrets).
-- 3. access.user.password.reset: explicit, company-scoped capability to reset a staff member's password. Full Access holds it
--    through the wildcard and an active System Admin through global authority. It is NOT granted to any existing role here
--    (no automatic role grants): a company grants it on purpose.
-- Additive and idempotent. Rollback (manual, Owner-approved): DELETE FROM role_capabilities WHERE capability_id =
-- 'access.user.password.reset'; DELETE FROM capabilities WHERE id = 'access.user.password.reset';
-- ALTER TABLE users DROP COLUMN must_change_password, DROP COLUMN password_changed_at;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
INSERT INTO capabilities (id) VALUES ('access.user.password.reset') ON CONFLICT (id) DO NOTHING;
