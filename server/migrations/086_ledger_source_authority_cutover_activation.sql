-- Migration 086 (C1B-3b): cut-over journal type and the ONLY path that activates a ledger source authority range.
--
-- Until now no path could make a range 'active' (085). This migration adds exactly one: an atomic draft -> active transition that is
-- accepted by the database only when the range is linked to a POSTED, balanced `cutover_balance` journal dated on the range's last day,
-- together with the activator, the time and the recorded accountant acknowledgements. Everything else stays as 085 left it:
--   * INSERT is draft only; DELETE is refused; an ACTIVE range is immutable and can never be voided (Owner decision 2026-10-17).
--   * draft -> voided is still allowed, but is refused once a posted cut-over journal exists for the range (no orphan journal).
-- A `cutover_balance` journal is a dedicated entry type (not `standard`, not `opening_balance`): it can be posted only while a matching
-- DRAFT range exists, there is at most one per fiscal year, and (as every posted journal) it is immutable. It cannot be reversed or deleted
-- (the reversal and deletion paths accept `standard` manual journals only).
--
-- Order inside the activation transaction (application): company authority lock -> VAT period lock -> per-month accounting locks (ascending)
-- -> create + post the cut-over journal WHILE THE RANGE IS STILL DRAFT (the 083 posting guards read active ranges only) -> UPDATE the range to
-- active. The trigger below takes the same locks in the same order, so raw SQL is serialised identically.
--
-- PREREQUISITES: migrations 001-085 applied (085 in particular). No data is changed; no existing row is rewritten.
-- PERFORMANCE: two trigger functions replaced; one CHECK re-created on journal_entries (brief lock, table scanned once); one partial unique
-- index and one tiny index. The posting trigger only fires for entry_type = 'cutover_balance'.
-- ROLLBACK (only while NO range is active and NO cutover_balance journal exists):
--   DROP TRIGGER journal_entries_cutover_posting_insert ON journal_entries; DROP TRIGGER journal_entries_cutover_posting_update ON journal_entries;
--   DROP FUNCTION journal_entries_enforce_cutover_posting();
--   ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_cutover_shape, DROP CONSTRAINT journal_entries_entry_type_check;
--   ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN ('standard','opening_balance'));
--   DROP INDEX journal_entries_one_cutover_per_year_uidx;
--   restore ledger_source_authority_guard_update() from 085_ledger_source_authority_lockdown.sql;
--   ALTER TABLE ledger_source_authority DROP CONSTRAINT ledger_source_authority_activation_columns_check,
--     DROP CONSTRAINT ledger_source_authority_cutover_journal_fk, DROP COLUMN cutover_journal_id, DROP COLUMN activated_by,
--     DROP COLUMN activated_at, DROP COLUMN activation_ack;
--   DELETE FROM capabilities WHERE id = 'source_authority.activate'; DELETE FROM _schema_migrations WHERE filename = '086_ledger_source_authority_cutover_activation.sql';
-- WARNING: never roll back once a range is active; the posting protection of that period would disappear.

-- 1) Dedicated journal type.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'journal_entries'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%entry_type%' AND pg_get_constraintdef(oid) LIKE '%opening_balance%' LOOP
    EXECUTE format('ALTER TABLE journal_entries DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN ('standard', 'opening_balance', 'cutover_balance')),
  ADD CONSTRAINT journal_entries_cutover_shape CHECK (entry_type <> 'cutover_balance' OR (source_type IS NULL AND reversal_of_journal_id IS NULL));
CREATE UNIQUE INDEX journal_entries_one_cutover_per_year_uidx ON journal_entries (company_id, fiscal_year_id) WHERE entry_type = 'cutover_balance';

-- 2) Activation record on the range.
ALTER TABLE ledger_source_authority
  ADD COLUMN cutover_journal_id UUID,
  ADD COLUMN activated_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN activated_at TIMESTAMPTZ,
  ADD COLUMN activation_ack JSONB;
ALTER TABLE ledger_source_authority
  ADD CONSTRAINT ledger_source_authority_cutover_journal_fk
    FOREIGN KEY (cutover_journal_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  ADD CONSTRAINT ledger_source_authority_activation_columns_check CHECK (
    ((cutover_journal_id IS NULL) = (activated_by IS NULL))
    AND ((activated_by IS NULL) = (activated_at IS NULL))
    AND ((activated_at IS NULL) = (activation_ack IS NULL))
    AND (cutover_journal_id IS NULL OR status = 'active'));
CREATE UNIQUE INDEX ledger_source_authority_cutover_journal_uidx ON ledger_source_authority (cutover_journal_id) WHERE cutover_journal_id IS NOT NULL;

-- 3) A cut-over journal can be posted only while a matching DRAFT range exists (row lock keeps the range from being voided mid-post).
CREATE FUNCTION journal_entries_enforce_cutover_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM ledger_source_authority a JOIN fiscal_years f ON f.id = NEW.fiscal_year_id AND f.company_id = NEW.company_id
    WHERE a.company_id = NEW.company_id AND a.status = 'draft' AND a.from_date = f.start_date AND a.to_date = NEW.accounting_date
    FOR SHARE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUTOVER_JOURNAL_NO_DRAFT_RANGE' USING ERRCODE = '55000', DETAIL = 'A cut-over journal needs a draft range from the fiscal year start to its date';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_cutover_posting_insert BEFORE INSERT ON journal_entries
  FOR EACH ROW WHEN (NEW.entry_type = 'cutover_balance' AND NEW.status = 'posted') EXECUTE FUNCTION journal_entries_enforce_cutover_posting();
CREATE TRIGGER journal_entries_cutover_posting_update BEFORE UPDATE OF status ON journal_entries
  FOR EACH ROW WHEN (NEW.entry_type = 'cutover_balance' AND NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted') EXECUTE FUNCTION journal_entries_enforce_cutover_posting();

-- 4) The range transition guard: draft -> voided (unchanged, plus "no posted cut-over journal") and draft -> active (new, fully validated).
CREATE OR REPLACE FUNCTION ledger_source_authority_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  j journal_entries%ROWTYPE;
  fy fiscal_years%ROWTYPE;
  n_lines INTEGER; total_debit NUMERIC; total_credit NUMERIC;
BEGIN
  IF OLD.status <> 'draft'
     OR (NEW.id, NEW.company_id, NEW.from_date, NEW.to_date, NEW.authority, NEW.reason, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.company_id, OLD.from_date, OLD.to_date, OLD.authority, OLD.reason, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Only draft -> voided or draft -> active (cut-over activation) is allowed';
  END IF;

  IF NEW.status = 'voided' THEN
    IF (NEW.cutover_journal_id, NEW.activated_by, NEW.activated_at, NEW.activation_ack) IS DISTINCT FROM (OLD.cutover_journal_id, OLD.activated_by, OLD.activated_at, OLD.activation_ack) THEN
      RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'A voided draft carries no activation data';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('source-authority:' || OLD.company_id::text, 0));
    IF EXISTS (SELECT 1 FROM journal_entries x JOIN fiscal_years f ON f.id = x.fiscal_year_id AND f.company_id = x.company_id
               WHERE x.company_id = OLD.company_id AND x.entry_type = 'cutover_balance' AND f.start_date = OLD.from_date AND x.accounting_date = OLD.to_date) THEN
      RAISE EXCEPTION 'AUTHORITY_CUTOVER_JOURNAL_EXISTS' USING ERRCODE = '55000', DETAIL = 'A cut-over journal exists for this range; it cannot be voided';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'active' THEN
    RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Only draft -> voided or draft -> active is allowed';
  END IF;
  IF NEW.voided_by IS NOT NULL OR NEW.voided_at IS NOT NULL OR NEW.void_reason IS NOT NULL
     OR NEW.cutover_journal_id IS NULL OR NEW.activated_by IS NULL OR NEW.activated_at IS NULL
     OR NEW.activation_ack IS NULL OR jsonb_typeof(NEW.activation_ack) <> 'object' THEN
    RAISE EXCEPTION 'AUTHORITY_ACTIVATION_INCOMPLETE' USING ERRCODE = '23514', DETAIL = 'Activation needs the cut-over journal, the activator, the time and the acknowledgements';
  END IF;

  -- Same lock order as the application: company authority -> VAT periods -> accounting months ascending.
  PERFORM pg_advisory_xact_lock(hashtextextended('source-authority:' || NEW.company_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('vat-periods:' || NEW.company_id::text, 0));
  PERFORM ledger_source_authority_lock_months(NEW.company_id, NEW.from_date, NEW.to_date);

  SELECT * INTO j FROM journal_entries WHERE id = NEW.cutover_journal_id AND company_id = NEW.company_id;
  IF NOT FOUND OR j.entry_type <> 'cutover_balance' OR j.status <> 'posted' OR j.accounting_date <> NEW.to_date THEN
    RAISE EXCEPTION 'AUTHORITY_CUTOVER_JOURNAL_INVALID' USING ERRCODE = '23514', DETAIL = 'The range needs a posted cut-over journal dated on its last day';
  END IF;
  SELECT * INTO fy FROM fiscal_years WHERE id = j.fiscal_year_id AND company_id = NEW.company_id;
  IF NOT FOUND OR fy.start_date <> NEW.from_date OR fy.status <> 'open' OR NEW.to_date >= fy.end_date THEN
    RAISE EXCEPTION 'AUTHORITY_DRAFT_FISCAL_YEAR_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.to_date <> (date_trunc('month', NEW.to_date) + INTERVAL '1 month' - INTERVAL '1 day')::date THEN
    RAISE EXCEPTION 'AUTHORITY_CUTOVER_DATE_INVALID' USING ERRCODE = '23514', DETAIL = 'The cut-over date must be the last day of a month';
  END IF;

  SELECT COUNT(*), COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0) INTO n_lines, total_debit, total_credit
    FROM journal_lines WHERE journal_entry_id = j.id AND company_id = j.company_id;
  IF n_lines < 2 OR total_debit <> total_credit OR total_debit <= 0 THEN
    RAISE EXCEPTION 'AUTHORITY_CUTOVER_UNBALANCED' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.company_id = l.company_id
             WHERE l.journal_entry_id = j.id AND l.company_id = j.company_id AND (NOT a.is_active OR a.statement_category = 'unmapped')) THEN
    RAISE EXCEPTION 'AUTHORITY_CUTOVER_ACCOUNT_INVALID' USING ERRCODE = '23514', DETAIL = 'Every cut-over account must be active and classified';
  END IF;

  IF EXISTS (SELECT 1 FROM ledger_source_authority a WHERE a.company_id = NEW.company_id AND a.id <> NEW.id AND a.status IN ('active', 'draft')
             AND a.from_date <= NEW.to_date AND a.to_date >= NEW.from_date) THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_OVERLAP' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries x WHERE x.company_id = NEW.company_id AND x.id <> j.id AND x.accounting_date BETWEEN NEW.from_date AND NEW.to_date) THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_HAS_JOURNALS' USING ERRCODE = '23514', DETAIL = 'Another journal (any status) is dated inside the range';
  END IF;
  IF EXISTS (SELECT 1 FROM monthly_close_periods p WHERE p.company_id = NEW.company_id AND p.status = 'closed'
             AND p.period_start <= NEW.to_date AND p.period_end >= NEW.from_date) THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_CLOSED_PERIOD' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries x WHERE x.company_id = fy.company_id AND x.fiscal_year_id = fy.id AND x.entry_type = 'opening_balance')
     OR EXISTS (SELECT 1 FROM opening_balance_reviews r WHERE r.company_id = fy.company_id AND r.fiscal_year_id = fy.id)
     OR EXISTS (SELECT 1 FROM fiscal_year_carryforwards c WHERE c.company_id = fy.company_id AND c.to_fiscal_year_id = fy.id) THEN
    RAISE EXCEPTION 'AUTHORITY_ONBOARDING_PATH_CONFLICT' USING ERRCODE = '23514', DETAIL = 'The fiscal year already follows the opening-balance path';
  END IF;
  IF EXISTS (SELECT 1 FROM vat_periods v WHERE v.company_id = NEW.company_id AND v.period_start <= NEW.to_date AND v.period_end >= NEW.from_date) THEN
    RAISE EXCEPTION 'AUTHORITY_VAT_PERIOD_CONFLICT' USING ERRCODE = '23514', DETAIL = 'A VAT period overlaps the externally maintained range';
  END IF;
  IF EXISTS (SELECT 1 FROM annual_closing_packages k WHERE k.company_id = NEW.company_id AND k.fiscal_year_id = fy.id AND k.status = 'approved') THEN
    RAISE EXCEPTION 'AUTHORITY_ANNUAL_PACKAGE_APPROVED' USING ERRCODE = '23514', DETAIL = 'An approved annual closing package exists for the fiscal year';
  END IF;
  RETURN NEW;
END $$;

-- 5) Registration only (as 083): no role_capabilities row, so no default role gains it; Full Access holds it through the 075 wildcard.
INSERT INTO capabilities (id) VALUES ('source_authority.activate') ON CONFLICT (id) DO NOTHING;
