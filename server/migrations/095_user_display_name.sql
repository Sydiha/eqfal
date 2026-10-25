-- Migration 095 (Phase B): optional user display name.
-- users.display_name is entered by an administrator; NULL keeps existing accounts unchanged and the UI falls back to the
-- email. It is never derived from the email. Display only: authorization never reads it.
-- DEPLOYMENT ORDER: apply this migration BEFORE deploying the code. The session lookup selects users.display_name on
-- every authenticated request, so code without the column fails all signed-in requests; the migration alone is harmless.
-- Additive and idempotent. Rollback (manual, Owner-approved): ALTER TABLE users DROP CONSTRAINT users_display_name_check,
-- DROP COLUMN display_name;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_display_name_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_display_name_check
      CHECK (display_name IS NULL OR (display_name = btrim(display_name) AND char_length(display_name) BETWEEN 1 AND 100));
  END IF;
END $$;
