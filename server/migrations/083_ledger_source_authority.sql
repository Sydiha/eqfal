-- Migration 083 (C1B-1): ledger source authority foundation.
--
-- A company may declare date ranges whose books are kept OUTSIDE EQFAL (`external_reference_only`). EQFAL then refuses to POST any
-- journal dated inside an active range. Companies with no row behave exactly as before (the guard reads an empty set).
-- This migration only adds the table, its protection triggers, a posting guard on journal_entries and two capabilities. It does NOT
-- create any range, change any existing row, or add an endpoint that creates ranges (that is C1B-2). `imported_ledger` is NOT allowed.
--
-- Concurrency design (no new lock-order edge):
--   * Every writer that must be serialised with journal posting takes the SAME per-month advisory lock key the application already uses
--     (`accounting-period:{company_id}:{YYYY-MM}`, see accounting-period.guard.ts), always in ascending month order.
--   * The two journal_entries posting triggers and the authority INSERT/UPDATE trigger take those locks themselves, so raw SQL is
--     serialised too. In the application path the posting lock is already held (re-acquiring a held advisory lock is a no-op).
--   * No trigger takes a row lock on journals, reviews or fiscal years; they only read.
--
-- PREREQUISITES: migrations 001-082 must already be applied (the server applies pending migrations in order at start-up and aborts on
-- failure). It depends on: companies, users, fiscal_years, journal_entries, monthly_close_periods, opening_balance_reviews (026),
-- fiscal_year_carryforwards (080), capabilities (075 wildcard).
-- PERFORMANCE: each journal posting (status -> posted) now runs one advisory-lock call (no-op in the app path) and one indexed EXISTS
-- on ledger_source_authority (empty table => a single index probe). No other statement is affected.
-- ROLLBACK (only while ledger_source_authority is EMPTY, and after deploying code that no longer calls the guard):
--   DROP TRIGGER journal_entries_source_authority_insert ON journal_entries;
--   DROP TRIGGER journal_entries_source_authority_post ON journal_entries;
--   DROP FUNCTION journal_entries_enforce_source_authority();
--   DROP TABLE ledger_source_authority;  -- drops its triggers
--   DROP FUNCTION ledger_source_authority_guard_insert(); DROP FUNCTION ledger_source_authority_guard_update();
--   DROP FUNCTION ledger_source_authority_guard_delete(); DROP FUNCTION ledger_source_authority_lock_months(uuid, date, date);
--   DELETE FROM capabilities WHERE id IN ('source_authority.view','source_authority.manage');
--   DELETE FROM _schema_migrations WHERE filename = '083_ledger_source_authority.sql';
-- LIMIT: once ranges exist, rolling back removes the protection that keeps those periods out of the ledger. Do not roll back then.

CREATE TABLE ledger_source_authority (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  authority TEXT NOT NULL CHECK (authority = 'external_reference_only'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  UNIQUE (id, company_id),
  CHECK (from_date <= to_date),
  CHECK (to_date - from_date <= 3660),
  CHECK (
    (status = 'active' AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL)
    OR (status = 'voided' AND voided_by IS NOT NULL AND voided_at IS NOT NULL AND char_length(btrim(void_reason)) BETWEEN 1 AND 500)
  )
);
CREATE INDEX ledger_source_authority_active_idx ON ledger_source_authority (company_id, from_date, to_date) WHERE status = 'active';

-- Takes the application's per-month accounting advisory locks for every month touched by [p_from, p_to], ascending.
CREATE FUNCTION ledger_source_authority_lock_months(p_company UUID, p_from DATE, p_to DATE) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE m DATE := date_trunc('month', p_from)::date;
BEGIN
  WHILE m <= p_to LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('accounting-period:' || p_company::text || ':' || to_char(m, 'YYYY-MM'), 0));
    m := (m + INTERVAL '1 month')::date;
  END LOOP;
END $$;

-- INSERT guard: serialised with posting, rejects overlap, existing journals, closed periods and a conflicting onboarding path.
CREATE FUNCTION ledger_source_authority_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_INVALID' USING ERRCODE = '23514', DETAIL = 'A range is created active';
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
CREATE TRIGGER ledger_source_authority_guard_insert BEFORE INSERT ON ledger_source_authority
  FOR EACH ROW EXECUTE FUNCTION ledger_source_authority_guard_insert();

-- UPDATE guard: the only permitted change is active -> voided with its void audit columns; everything else is immutable.
CREATE FUNCTION ledger_source_authority_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status = 'voided'
     AND (NEW.id, NEW.company_id, NEW.from_date, NEW.to_date, NEW.authority, NEW.reason, NEW.created_by, NEW.created_at)
         IS NOT DISTINCT FROM (OLD.id, OLD.company_id, OLD.from_date, OLD.to_date, OLD.authority, OLD.reason, OLD.created_by, OLD.created_at) THEN
    PERFORM ledger_source_authority_lock_months(OLD.company_id, OLD.from_date, OLD.to_date);
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Only active -> voided is allowed';
END $$;
CREATE TRIGGER ledger_source_authority_guard_update BEFORE UPDATE ON ledger_source_authority
  FOR EACH ROW EXECUTE FUNCTION ledger_source_authority_guard_update();

CREATE FUNCTION ledger_source_authority_guard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Authority ranges are never deleted';
END $$;
CREATE TRIGGER ledger_source_authority_guard_delete BEFORE DELETE ON ledger_source_authority
  FOR EACH ROW EXECUTE FUNCTION ledger_source_authority_guard_delete();

-- Posting guard on journal_entries: no journal may become (or be inserted as) posted inside an active range, and no opening-balance
-- journal may be posted for a fiscal year that overlaps an active range (the fiscal year follows the cut-over path, not the opening path).
-- The month lock is taken first so a concurrent range insert and this posting are strictly ordered, even for raw SQL.
-- C1B-2 will add the narrow, application-set exemption for the cut-over journal; C1B-1 has none.
CREATE FUNCTION journal_entries_enforce_source_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('accounting-period:' || NEW.company_id::text || ':' || to_char(NEW.accounting_date, 'YYYY-MM'), 0));
  IF EXISTS (SELECT 1 FROM ledger_source_authority a WHERE a.company_id = NEW.company_id AND a.status = 'active'
             AND NEW.accounting_date BETWEEN a.from_date AND a.to_date) THEN
    RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_BLOCKED' USING ERRCODE = '55000', DETAIL = 'The accounting date is inside an external-reference range';
  END IF;
  IF NEW.entry_type = 'opening_balance' AND EXISTS (
    SELECT 1 FROM ledger_source_authority a JOIN fiscal_years f ON f.id = NEW.fiscal_year_id AND f.company_id = NEW.company_id
    WHERE a.company_id = NEW.company_id AND a.status = 'active' AND a.from_date <= f.end_date AND a.to_date >= f.start_date
  ) THEN
    RAISE EXCEPTION 'ONBOARDING_PATH_CUTOVER_ACTIVE' USING ERRCODE = '55000', DETAIL = 'The fiscal year follows the cut-over path';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_source_authority_insert BEFORE INSERT ON journal_entries
  FOR EACH ROW WHEN (NEW.status = 'posted') EXECUTE FUNCTION journal_entries_enforce_source_authority();
CREATE TRIGGER journal_entries_source_authority_post BEFORE UPDATE OF status ON journal_entries
  FOR EACH ROW WHEN (NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted') EXECUTE FUNCTION journal_entries_enforce_source_authority();

-- Registration only (like 079): no role_capabilities row, so no default role gains them; Full Access holds them through the wildcard (075).
INSERT INTO capabilities (id) VALUES
  ('source_authority.view'),
  ('source_authority.manage')
ON CONFLICT (id) DO NOTHING;
