-- Migration 084 (C1B-2): non-active 'draft' state for ledger source authority.
--
-- A draft records the intent to follow the mid-year cut-over path for a fiscal year WITHOUT any accounting effect. Every posting guard
-- (migration 083 triggers and the application guards) reads ONLY status = 'active', so a draft never blocks posting, never makes a fiscal
-- year follow the cut-over path, and is invisible to opening balances, monthly close, VAT and reporting. Draft -> active is NOT possible
-- here (the update trigger refuses it); activation belongs to a later phase that requires an approved, balanced, posted cut-over journal.
-- Existing rows and the active/voided behaviour are unchanged.
--
-- PREREQUISITES: 083 applied. The status CHECKs are located by definition (their names are generated), dropped and re-created named.
-- PERFORMANCE: table is empty or tiny; DDL takes a brief ACCESS EXCLUSIVE lock on ledger_source_authority only (not on journal_entries).
-- ROLLBACK (only while no draft row exists, i.e. SELECT count(*) FROM ledger_source_authority WHERE status='draft' is 0):
--   restore the 083 functions/constraints from 083_ledger_source_authority.sql, DROP FUNCTION and re-create the three functions below
--   with their 083 bodies, then DELETE FROM _schema_migrations WHERE filename = '084_ledger_source_authority_draft.sql'.

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'ledger_source_authority'::regclass AND contype = 'c'
             AND (pg_get_constraintdef(oid) LIKE '%''voided''%') LOOP
    EXECUTE format('ALTER TABLE ledger_source_authority DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE ledger_source_authority
  ADD CONSTRAINT ledger_source_authority_status_check CHECK (status IN ('draft', 'active', 'voided')),
  ADD CONSTRAINT ledger_source_authority_void_columns_check CHECK (
    (status IN ('draft', 'active') AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL)
    OR (status = 'voided' AND voided_by IS NOT NULL AND voided_at IS NOT NULL AND char_length(btrim(void_reason)) BETWEEN 1 AND 500)
  );

CREATE INDEX ledger_source_authority_draft_idx ON ledger_source_authority (company_id, from_date, to_date) WHERE status = 'draft';

-- INSERT guard: 'active' keeps the exact 083 checks. 'draft' only serialises per company and refuses overlap with another draft/active range;
-- all other conflicts (journals, closed periods, opening path) are re-validated at activation, when they matter.
CREATE OR REPLACE FUNCTION ledger_source_authority_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'draft' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('source-authority:' || NEW.company_id::text, 0));
    IF EXISTS (SELECT 1 FROM ledger_source_authority a WHERE a.company_id = NEW.company_id AND a.status IN ('active', 'draft')
               AND a.from_date <= NEW.to_date AND a.to_date >= NEW.from_date) THEN
      RAISE EXCEPTION 'AUTHORITY_RANGE_OVERLAP' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'active' THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_INVALID' USING ERRCODE = '23514', DETAIL = 'A range is created draft or active';
  END IF;
  PERFORM ledger_source_authority_lock_months(NEW.company_id, NEW.from_date, NEW.to_date);
  IF EXISTS (SELECT 1 FROM ledger_source_authority a WHERE a.company_id = NEW.company_id AND a.status = 'active'
             AND a.from_date <= NEW.to_date AND a.to_date >= NEW.from_date) THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_OVERLAP' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries j WHERE j.company_id = NEW.company_id AND j.accounting_date BETWEEN NEW.from_date AND NEW.to_date) THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_HAS_JOURNALS' USING ERRCODE = '23514', DETAIL = 'A journal (any status) is dated inside the range';
  END IF;
  IF EXISTS (SELECT 1 FROM monthly_close_periods p WHERE p.company_id = NEW.company_id AND p.status = 'closed'
             AND p.period_start <= NEW.to_date AND p.period_end >= NEW.from_date)
     OR EXISTS (SELECT 1 FROM fiscal_years f WHERE f.company_id = NEW.company_id AND f.status = 'closed'
             AND f.start_date <= NEW.to_date AND f.end_date >= NEW.from_date) THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_CLOSED_PERIOD' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fiscal_years f
    WHERE f.company_id = NEW.company_id AND f.start_date <= NEW.to_date AND f.end_date >= NEW.from_date
      AND (EXISTS (SELECT 1 FROM journal_entries j WHERE j.company_id = f.company_id AND j.fiscal_year_id = f.id AND j.entry_type = 'opening_balance')
        OR EXISTS (SELECT 1 FROM opening_balance_reviews r WHERE r.company_id = f.company_id AND r.fiscal_year_id = f.id)
        OR EXISTS (SELECT 1 FROM fiscal_year_carryforwards c WHERE c.company_id = f.company_id AND c.to_fiscal_year_id = f.id))
  ) THEN
    RAISE EXCEPTION 'AUTHORITY_ONBOARDING_PATH_CONFLICT' USING ERRCODE = '23514',
      DETAIL = 'The fiscal year already follows the opening-balance path (opening journal, opening review or carry-forward)';
  END IF;
  RETURN NEW;
END $$;

-- UPDATE guard: only active -> voided (083 behaviour) and draft -> voided; draft -> active and every other change stay refused.
CREATE OR REPLACE FUNCTION ledger_source_authority_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('active', 'draft') AND NEW.status = 'voided'
     AND (NEW.id, NEW.company_id, NEW.from_date, NEW.to_date, NEW.authority, NEW.reason, NEW.created_by, NEW.created_at)
         IS NOT DISTINCT FROM (OLD.id, OLD.company_id, OLD.from_date, OLD.to_date, OLD.authority, OLD.reason, OLD.created_by, OLD.created_at) THEN
    IF OLD.status = 'active' THEN
      PERFORM ledger_source_authority_lock_months(OLD.company_id, OLD.from_date, OLD.to_date);
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Only active/draft -> voided is allowed';
END $$;
