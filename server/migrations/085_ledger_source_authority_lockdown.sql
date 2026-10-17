-- Migration 085 (C1B-3a): no path may create or void an ACTIVE ledger source authority range.
--
-- Until C1B-3b adds the approved, balanced, posted cut-over journal workflow, an active range has no legitimate origin. 083/084 still let
-- raw SQL (and the removed internal service create()/void()) INSERT a row as 'active' and UPDATE active -> voided. Voiding an active range
-- would reopen external periods for native posting and risk duplicated balances, so it is refused permanently (Owner decision 2026-10-17).
-- After this migration:
--   * INSERT is accepted only with status = 'draft' (084 draft checks unchanged: company lock + symmetric overlap with draft/active).
--   * UPDATE is accepted only for draft -> voided with its void audit columns (084 behaviour); every other change, including
--     draft -> active and active -> voided, raises LEDGER_SOURCE_AUTHORITY_IMMUTABLE.
--   * DELETE stays refused (083 trigger, unchanged). journal_entries posting guards (083) are unchanged, so any existing active row keeps
--     protecting its dates.
--
-- PREREQUISITES: 083 and 084 applied. Replaces two trigger functions only; no table, column, constraint, index or row changes.
-- PRE-FLIGHT (Owner, read only): SELECT count(*) FROM ledger_source_authority WHERE status='active' was 0 on Replit (2026-10-17).
-- PERFORMANCE: CREATE OR REPLACE FUNCTION only; no table lock beyond catalog updates.
-- ROLLBACK (safe at any time, changes no data): re-create ledger_source_authority_guard_insert() and ledger_source_authority_guard_update()
--   with their bodies from 084_ledger_source_authority_draft.sql, then DELETE FROM _schema_migrations WHERE filename =
--   '085_ledger_source_authority_lockdown.sql'. Rolling back re-opens raw active inserts and active voiding.

CREATE OR REPLACE FUNCTION ledger_source_authority_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'AUTHORITY_ACTIVE_INSERT_FORBIDDEN' USING ERRCODE = '55000',
      DETAIL = 'A range is created as draft only; activation requires the approved cut-over workflow';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('source-authority:' || NEW.company_id::text, 0));
  IF EXISTS (SELECT 1 FROM ledger_source_authority a WHERE a.company_id = NEW.company_id AND a.status IN ('active', 'draft')
             AND a.from_date <= NEW.to_date AND a.to_date >= NEW.from_date) THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_OVERLAP' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ledger_source_authority_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'voided'
     AND (NEW.id, NEW.company_id, NEW.from_date, NEW.to_date, NEW.authority, NEW.reason, NEW.created_by, NEW.created_at)
         IS NOT DISTINCT FROM (OLD.id, OLD.company_id, OLD.from_date, OLD.to_date, OLD.authority, OLD.reason, OLD.created_by, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Only draft -> voided is allowed';
END $$;
