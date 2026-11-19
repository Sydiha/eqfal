-- Preserve reviewed worksheet metadata and audit history when opening a correction revision.
-- Only a status transition is allowed; reviewer identity, timestamps, snapshots, and all other fields remain immutable.
CREATE OR REPLACE FUNCTION zakat_worksheet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved','superseded') THEN RAISE EXCEPTION 'Approved Zakat worksheet revisions cannot be deleted' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('approved','superseded') OR (OLD.status = 'reviewed' AND NEW.status = 'superseded') THEN
    IF NOT (OLD.status IN ('approved','reviewed') AND NEW.status = 'superseded'
            AND to_jsonb(NEW) - 'status' - 'version' - 'updated_at' = to_jsonb(OLD) - 'status' - 'version' - 'updated_at') THEN
      RAISE EXCEPTION 'Approved or superseded Zakat worksheet revisions are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
