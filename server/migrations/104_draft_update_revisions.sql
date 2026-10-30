-- Migration 104: revision counters for stale-write protection on draft edits (G7).
-- documents (intake), journal_entries (draft header + line replacement) and fixed_assets (draft edit) gain `version`. A BEFORE UPDATE trigger
-- bumps it on every UPDATE of the row, so no write path can change a row without changing its revision. The API compares the caller's revision
-- inside the row-locked transaction. Existing rows start at 1 (ADD COLUMN with a constant default is metadata-only). No data is modified.
-- Rollback: DROP TRIGGER zz_<table>_bump_version ON <table>; ALTER TABLE <table> DROP COLUMN version; DROP FUNCTION bump_row_version();
CREATE FUNCTION bump_row_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

ALTER TABLE documents       ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CONSTRAINT documents_version_check CHECK (version > 0);
ALTER TABLE journal_entries ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CONSTRAINT journal_entries_version_check CHECK (version > 0);
ALTER TABLE fixed_assets    ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CONSTRAINT fixed_assets_version_check CHECK (version > 0);

-- The zz_ prefix makes the bump fire after the existing guard triggers (PostgreSQL fires same-event triggers alphabetically).
CREATE TRIGGER zz_documents_bump_version       BEFORE UPDATE ON documents       FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER zz_journal_entries_bump_version BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER zz_fixed_assets_bump_version    BEFORE UPDATE ON fixed_assets    FOR EACH ROW EXECUTE FUNCTION bump_row_version();
