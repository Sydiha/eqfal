-- Migration 086 (C1B-3b): cut-over balance journal and activation of a ledger source authority range.
--
-- Until now no path could make a range ACTIVE (085). This migration adds the ONLY path: a dedicated `cutover_balance` journal, posted
-- while its range is still a draft, followed in the same transaction by draft -> active. Everything the activation relies on is enforced
-- here, in the database, so raw SQL cannot activate a range, void or change an active range, or leave an orphan cut-over journal.
-- What this migration does NOT do: create any range or journal, change any existing row, or touch 083/084/085 behaviour for the
-- draft -> voided path. No role is granted the new capability (Full Access holds it through the 075 wildcard).
--
-- Contents:
--   1. journal_entries.entry_type accepts 'cutover_balance'; one cut-over journal per fiscal year; shape / orphan / VAT-memo guards.
--   2. ledger_source_authority gains the activation evidence columns (journal link, who/when, trial-balance reference + preparer,
--      accountant acknowledgements, validation snapshot, idempotency key + payload hash).
--   3. ledger_source_authority_guard_update(): draft -> active only when every invariant below holds; active/voided stay immutable.
--   4. journal_entries_enforce_source_authority(): a cut-over journal posts only against a matching DRAFT range (never an active one).
--   5. vat_periods cannot be inserted/moved into an active range; approved accounting profiles cannot be changed retroactively over
--      the cut-over window (VAT frequency evidence at D+1 stays true).
--   6. Capability source_authority.activate (registration only).
--
-- Lock order (matches the application): company authority lock -> VAT keys -> accounting month keys (ascending). Re-acquiring a held
-- advisory lock is a no-op, so the application path (which takes them first) adds no new wait.
-- PREREQUISITES: 083, 084, 085 applied; tables companies, users, fiscal_years, journal_entries, journal_lines, accounts, vat_periods,
--   company_accounting_profiles, annual_closing_packages, monthly_close_periods, opening_balance_reviews, fiscal_year_carryforwards.
-- PERFORMANCE: entry_type CHECK is added NOT VALID then validated (no long ACCESS EXCLUSIVE scan). journal_lines trigger fires only for
--   VAT_INPUT/VAT_OUTPUT memos. The journal_entries post trigger gains one cheap branch for cutover_balance only.
-- ROLLBACK (only while no cutover_balance journal and no activated range exists; after deploying code that no longer calls them):
--   DROP TRIGGER vat_periods_external_guard ON vat_periods; DROP TRIGGER company_accounting_profiles_cutover_guard ON company_accounting_profiles;
--   DROP TRIGGER journal_lines_cutover_memo_guard ON journal_lines; DROP TRIGGER journal_entries_cutover_orphan ON journal_entries;
--   DROP TRIGGER journal_entries_cutover_shape ON journal_entries; DROP the functions created below;
--   restore ledger_source_authority_guard_update() from 085 and journal_entries_enforce_source_authority() from 083;
--   DROP INDEX journal_entries_one_cutover_uidx; restore the 021 entry_type CHECK; ALTER TABLE ledger_source_authority DROP the added columns;
--   DELETE FROM capabilities WHERE id = 'source_authority.activate'; DELETE FROM _schema_migrations WHERE filename = '086_cutover_balance_activation.sql'.
-- LIMIT: once a range is active, rolling back removes the protection that keeps the external period out of the ledger. Do not roll back then.

-- 1) journal type -------------------------------------------------------------------------------------------------------------
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
  ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN ('standard', 'opening_balance', 'cutover_balance')) NOT VALID;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_entry_type_check;

-- At most one cut-over journal (any status) per company and fiscal year: no duplicate, no second attempt left behind.
CREATE UNIQUE INDEX journal_entries_one_cutover_uidx ON journal_entries (company_id, fiscal_year_id) WHERE entry_type = 'cutover_balance';

CREATE FUNCTION journal_entries_cutover_shape() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type IS NOT NULL OR NEW.source_id IS NOT NULL
     OR NEW.accounting_date <> (date_trunc('month', NEW.accounting_date) + INTERVAL '1 month - 1 day')::date THEN
    RAISE EXCEPTION 'CUTOVER_JOURNAL_SHAPE_INVALID' USING ERRCODE = '23514', DETAIL = 'A cut-over journal has no operational source and is dated the last day of a month';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_cutover_shape BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW WHEN (NEW.entry_type = 'cutover_balance') EXECUTE FUNCTION journal_entries_cutover_shape();

-- No orphan: at COMMIT a posted cut-over journal must be the linked journal of an ACTIVE range of its company.
CREATE FUNCTION journal_entries_cutover_orphan_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_source_authority a WHERE a.company_id = NEW.company_id AND a.status = 'active' AND a.cutover_journal_id = NEW.id) THEN
    RAISE EXCEPTION 'CUTOVER_JOURNAL_ORPHAN' USING ERRCODE = '23514', DETAIL = 'A posted cut-over journal must belong to an active authority range';
  END IF;
  RETURN NULL;
END $$;
-- (created after the column exists, see below)

-- Cut-over lines never carry the VAT recognition markers (VAT recognition/reconciliation read these memos).
CREATE FUNCTION journal_lines_cutover_memo_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = NEW.journal_entry_id AND j.company_id = NEW.company_id AND j.entry_type = 'cutover_balance') THEN
    RAISE EXCEPTION 'CUTOVER_VAT_MEMO_FORBIDDEN' USING ERRCODE = '23514', DETAIL = 'Cut-over lines cannot use the VAT_INPUT/VAT_OUTPUT markers';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_cutover_memo_guard BEFORE INSERT OR UPDATE OF memo ON journal_lines
  FOR EACH ROW WHEN (NEW.memo IN ('VAT_INPUT', 'VAT_OUTPUT')) EXECUTE FUNCTION journal_lines_cutover_memo_guard();

-- 2) activation evidence ------------------------------------------------------------------------------------------------------
ALTER TABLE ledger_source_authority
  ADD COLUMN cutover_journal_id UUID,
  ADD COLUMN activated_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN activated_at TIMESTAMPTZ,
  ADD COLUMN tb_reference TEXT,
  ADD COLUMN tb_prepared_by TEXT,
  ADD COLUMN acknowledgements JSONB,
  ADD COLUMN activation_snapshot JSONB,
  ADD COLUMN activation_idempotency_key TEXT,
  ADD COLUMN activation_payload_hash TEXT,
  ADD CONSTRAINT ledger_source_authority_cutover_journal_fk
    FOREIGN KEY (cutover_journal_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  ADD CONSTRAINT ledger_source_authority_activation_text_check CHECK (
    (tb_reference IS NULL OR char_length(btrim(tb_reference)) BETWEEN 1 AND 200)
    AND (tb_prepared_by IS NULL OR char_length(btrim(tb_prepared_by)) BETWEEN 1 AND 200)
    AND (activation_idempotency_key IS NULL OR char_length(activation_idempotency_key) BETWEEN 8 AND 128));
-- A journal activates at most one range; a key is single-use per company.
CREATE UNIQUE INDEX ledger_source_authority_cutover_journal_uidx ON ledger_source_authority (cutover_journal_id) WHERE cutover_journal_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_source_authority_idem_uidx ON ledger_source_authority (company_id, activation_idempotency_key) WHERE activation_idempotency_key IS NOT NULL;

CREATE CONSTRAINT TRIGGER journal_entries_cutover_orphan AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.entry_type = 'cutover_balance' AND NEW.status = 'posted')
  EXECUTE FUNCTION journal_entries_cutover_orphan_check();

-- 3) VAT frequency evidence at D+1 (shared by the activation guard and the application preview) ------------------------------------
-- Returns NULL when acceptable, otherwise a stable code. Exactly one APPROVED profile must govern D+1 (a gap or an overlap is refused).
CREATE FUNCTION ledger_cutover_vat_issue(p_company UUID, p_to DATE) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE n INT; p company_accounting_profiles%ROWTYPE; nxt DATE := p_to + 1;
BEGIN
  SELECT COUNT(*) INTO n FROM company_accounting_profiles x
   WHERE x.company_id = p_company AND x.workflow_status = 'approved' AND x.effective_from <= nxt AND (x.effective_to IS NULL OR x.effective_to >= nxt);
  IF n <> 1 THEN RETURN 'CUTOVER_PROFILE_NOT_UNIQUE'; END IF;
  SELECT x.* INTO p FROM company_accounting_profiles x
   WHERE x.company_id = p_company AND x.workflow_status = 'approved' AND x.effective_from <= nxt AND (x.effective_to IS NULL OR x.effective_to >= nxt);
  IF p.vat_status = 'needs_review' THEN RETURN 'CUTOVER_VAT_PROFILE_NEEDS_REVIEW'; END IF;
  IF p.vat_status = 'not_registered' THEN RETURN NULL; END IF;
  IF p.vat_status = 'deregistered' AND p.vat_deregistered_from <= nxt THEN RETURN NULL; END IF;
  IF p.vat_status = 'registered' AND p.vat_registered_from > nxt THEN RETURN NULL; END IF;
  IF p.vat_filing_frequency = 'monthly' THEN RETURN NULL; END IF;
  IF p.vat_filing_frequency = 'quarterly' THEN
    IF to_char(p_to, 'MM-DD') IN ('03-31', '06-30', '09-30', '12-31') THEN RETURN NULL; END IF;
    RETURN 'CUTOVER_VAT_QUARTER_BOUNDARY';
  END IF;
  RETURN 'CUTOVER_VAT_FREQUENCY_MISSING';
END $$;

-- Takes the VAT writers' keys for [p_from, p_to] (same keys as vat.router.ts: vat-periods:{co}, then vat-period:{co}:{YYYY-MM}).
CREATE FUNCTION ledger_source_authority_lock_vat(p_company UUID, p_from DATE, p_to DATE) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE m DATE := date_trunc('month', p_from)::date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('vat-periods:' || p_company::text, 0));
  WHILE m <= p_to LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('vat-period:' || p_company::text || ':' || to_char(m, 'YYYY-MM'), 0));
    m := (m + INTERVAL '1 month')::date;
  END LOOP;
END $$;

-- 4) UPDATE guard: draft -> voided (085 behaviour) and draft -> active (new). Nothing else, ever.
CREATE OR REPLACE FUNCTION ledger_source_authority_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  j journal_entries%ROWTYPE; f fiscal_years%ROWTYPE; cnt INT; sum_d NUMERIC; sum_c NUMERIC; issue TEXT;
BEGIN
  IF (NEW.id, NEW.company_id, NEW.from_date, NEW.to_date, NEW.authority, NEW.reason, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.company_id, OLD.from_date, OLD.to_date, OLD.authority, OLD.reason, OLD.created_by, OLD.created_at)
     OR OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Only draft -> voided or draft -> active is allowed';
  END IF;

  IF NEW.status = 'voided' THEN
    IF NEW.cutover_journal_id IS NOT NULL OR NEW.activated_by IS NOT NULL OR NEW.activated_at IS NOT NULL OR NEW.tb_reference IS NOT NULL
       OR NEW.tb_prepared_by IS NOT NULL OR NEW.acknowledgements IS NOT NULL OR NEW.activation_snapshot IS NOT NULL
       OR NEW.activation_idempotency_key IS NOT NULL OR NEW.activation_payload_hash IS NOT NULL THEN
      RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'A void carries no activation data';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'active' THEN
    RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Only draft -> voided or draft -> active is allowed';
  END IF;
  IF NEW.voided_by IS NOT NULL OR NEW.voided_at IS NOT NULL OR NEW.void_reason IS NOT NULL THEN
    RAISE EXCEPTION 'LEDGER_SOURCE_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  -- Serialise with every writer the checks below depend on.
  PERFORM pg_advisory_xact_lock(hashtextextended('source-authority:' || NEW.company_id::text, 0));
  PERFORM ledger_source_authority_lock_vat(NEW.company_id, NEW.from_date, NEW.to_date);
  PERFORM ledger_source_authority_lock_months(NEW.company_id, NEW.from_date, NEW.to_date);

  IF NEW.cutover_journal_id IS NULL OR NEW.activated_by IS NULL OR NEW.activated_at IS NULL
     OR NEW.activation_idempotency_key IS NULL OR NEW.activation_payload_hash IS NULL OR NEW.activation_snapshot IS NULL THEN
    RAISE EXCEPTION 'CUTOVER_ACTIVATION_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  IF NEW.tb_reference IS NULL OR btrim(NEW.tb_reference) = '' OR NEW.tb_prepared_by IS NULL OR btrim(NEW.tb_prepared_by) = '' THEN
    RAISE EXCEPTION 'CUTOVER_TB_REFERENCE_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF NEW.acknowledgements IS NULL OR jsonb_typeof(NEW.acknowledgements) <> 'object'
     OR COALESCE(NEW.acknowledgements -> 'retained_earnings', 'false'::jsonb) <> 'true'::jsonb
     OR COALESCE(NEW.acknowledgements -> 'current_year_pnl', 'false'::jsonb) <> 'true'::jsonb
     OR COALESCE(NEW.acknowledgements -> 'cash_balances', 'false'::jsonb) <> 'true'::jsonb
     OR COALESCE(NEW.acknowledgements -> 'account_level_limitations', 'false'::jsonb) <> 'true'::jsonb THEN
    RAISE EXCEPTION 'CUTOVER_ACKNOWLEDGEMENTS_REQUIRED' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO j FROM journal_entries WHERE id = NEW.cutover_journal_id AND company_id = NEW.company_id;
  IF NOT FOUND OR j.entry_type <> 'cutover_balance' OR j.status <> 'posted' OR j.accounting_date <> NEW.to_date THEN
    RAISE EXCEPTION 'CUTOVER_JOURNAL_INVALID' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO f FROM fiscal_years WHERE id = j.fiscal_year_id AND company_id = NEW.company_id;
  IF NOT FOUND OR f.start_date <> NEW.from_date OR NEW.to_date >= f.end_date THEN
    RAISE EXCEPTION 'AUTHORITY_DRAFT_FISCAL_YEAR_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.to_date <> (date_trunc('month', NEW.to_date) + INTERVAL '1 month - 1 day')::date THEN
    RAISE EXCEPTION 'CUTOVER_DATE_NOT_MONTH_END' USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*), COALESCE(SUM(l.debit), 0), COALESCE(SUM(l.credit), 0) INTO cnt, sum_d, sum_c
    FROM journal_lines l WHERE l.journal_entry_id = j.id AND l.company_id = j.company_id;
  IF cnt < 2 OR sum_d <> sum_c OR sum_d <= 0 THEN RAISE EXCEPTION 'CUTOVER_JOURNAL_UNBALANCED' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.company_id = l.company_id
             WHERE l.journal_entry_id = j.id AND l.company_id = j.company_id AND a.statement_category = 'unmapped') THEN
    RAISE EXCEPTION 'CUTOVER_ACCOUNT_UNMAPPED' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (SELECT 1 FROM ledger_source_authority a WHERE a.company_id = NEW.company_id AND a.id <> NEW.id AND a.status IN ('active', 'draft')
             AND a.from_date <= NEW.to_date AND a.to_date >= NEW.from_date) THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_OVERLAP' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries x WHERE x.company_id = NEW.company_id AND x.accounting_date BETWEEN NEW.from_date AND NEW.to_date AND x.id <> j.id) THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_HAS_JOURNALS' USING ERRCODE = '23514', DETAIL = 'A journal (any status) other than the cut-over journal is dated inside the range';
  END IF;
  IF f.status <> 'open'
     OR EXISTS (SELECT 1 FROM monthly_close_periods p WHERE p.company_id = NEW.company_id AND p.status = 'closed' AND p.period_start <= NEW.to_date AND p.period_end >= NEW.from_date)
     OR EXISTS (SELECT 1 FROM fiscal_years y WHERE y.company_id = NEW.company_id AND y.status = 'closed' AND y.start_date <= NEW.to_date AND y.end_date >= NEW.from_date) THEN
    RAISE EXCEPTION 'AUTHORITY_RANGE_CLOSED_PERIOD' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries x WHERE x.company_id = f.company_id AND x.fiscal_year_id = f.id AND x.entry_type = 'opening_balance')
     OR EXISTS (SELECT 1 FROM opening_balance_reviews r WHERE r.company_id = f.company_id AND r.fiscal_year_id = f.id)
     OR EXISTS (SELECT 1 FROM fiscal_year_carryforwards c WHERE c.company_id = f.company_id AND c.to_fiscal_year_id = f.id) THEN
    RAISE EXCEPTION 'AUTHORITY_ONBOARDING_PATH_CONFLICT' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM vat_periods v WHERE v.company_id = NEW.company_id AND v.period_start <= NEW.to_date AND v.period_end >= NEW.from_date) THEN
    RAISE EXCEPTION 'CUTOVER_VAT_PERIOD_EXISTS' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM annual_closing_packages k WHERE k.company_id = NEW.company_id AND k.fiscal_year_id = f.id AND k.status = 'approved') THEN
    RAISE EXCEPTION 'CUTOVER_ANNUAL_PACKAGE_APPROVED' USING ERRCODE = '23514';
  END IF;
  issue := ledger_cutover_vat_issue(NEW.company_id, NEW.to_date);
  IF issue IS NOT NULL THEN RAISE EXCEPTION '%', issue USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

-- 5) Posting guard: a cut-over journal posts only against a matching DRAFT range (so the active-range block never applies to it).
CREATE OR REPLACE FUNCTION journal_entries_enforce_source_authority() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.entry_type = 'cutover_balance' AND NOT EXISTS (
    SELECT 1 FROM ledger_source_authority a JOIN fiscal_years f ON f.id = NEW.fiscal_year_id AND f.company_id = NEW.company_id
    WHERE a.company_id = NEW.company_id AND a.status = 'draft' AND a.from_date = f.start_date AND a.to_date = NEW.accounting_date
  ) THEN
    RAISE EXCEPTION 'CUTOVER_CONTEXT_INVALID' USING ERRCODE = '55000', DETAIL = 'A cut-over journal posts only against a matching draft range';
  END IF;
  RETURN NEW;
END $$;

-- 6) VAT periods never overlap an active range; approved profiles cannot be rewritten over the cut-over window.
CREATE FUNCTION vat_periods_external_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_source_authority a WHERE a.company_id = NEW.company_id AND a.status = 'active'
             AND a.from_date <= NEW.period_end AND a.to_date >= NEW.period_start) THEN
    RAISE EXCEPTION 'VAT_PERIOD_EXTERNAL' USING ERRCODE = '55000', DETAIL = 'VAT for an externally maintained period is not managed in EQFAL';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vat_periods_external_guard BEFORE INSERT OR UPDATE OF period_start, period_end ON vat_periods
  FOR EACH ROW EXECUTE FUNCTION vat_periods_external_guard();

-- Window protected for an active range: [from_date, to_date + 1] (D+1 is the date whose profile was recorded as evidence).
-- Allowed: a NEW version that starts after D+1, and the supersede of the profile governing D+1 by closing its effective_to at or after D+1.
CREATE FUNCTION company_accounting_profiles_cutover_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD; touched BOOLEAN := FALSE;
BEGIN
  FOR a IN SELECT from_date, to_date FROM ledger_source_authority WHERE company_id = NEW.company_id AND status = 'active' LOOP
    IF NEW.workflow_status = 'approved' AND NEW.effective_from IS NOT NULL
       AND NEW.effective_from <= a.to_date + 1 AND COALESCE(NEW.effective_to, 'infinity'::date) >= a.from_date
       AND (TG_OP = 'INSERT' OR OLD.workflow_status IS DISTINCT FROM 'approved') THEN
      touched := TRUE;
    ELSIF TG_OP = 'UPDATE' AND OLD.workflow_status = 'approved'
       AND OLD.effective_from <= a.to_date + 1 AND COALESCE(OLD.effective_to, 'infinity'::date) >= a.from_date THEN
      IF NEW.workflow_status IS DISTINCT FROM OLD.workflow_status OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
         OR NEW.vat_status IS DISTINCT FROM OLD.vat_status OR NEW.vat_registered_from IS DISTINCT FROM OLD.vat_registered_from
         OR NEW.vat_deregistered_from IS DISTINCT FROM OLD.vat_deregistered_from OR NEW.vat_filing_frequency IS DISTINCT FROM OLD.vat_filing_frequency
         OR (NEW.effective_to IS DISTINCT FROM OLD.effective_to AND NEW.effective_to IS NOT NULL AND NEW.effective_to < a.to_date + 1) THEN
        touched := TRUE;
      END IF;
    END IF;
  END LOOP;
  IF touched THEN
    RAISE EXCEPTION 'CUTOVER_PROFILE_CHANGE_FORBIDDEN' USING ERRCODE = '55000',
      DETAIL = 'An approved accounting profile covering an activated cut-over window cannot be changed retroactively';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_accounting_profiles_cutover_guard BEFORE INSERT OR UPDATE ON company_accounting_profiles
  FOR EACH ROW EXECUTE FUNCTION company_accounting_profiles_cutover_guard();

-- 7) Capability (registration only, like 079/083: no role_capabilities row; Full Access holds it through the 075 wildcard).
INSERT INTO capabilities (id) VALUES ('source_authority.activate') ON CONFLICT (id) DO NOTHING;
