-- Migration 080: controlled reversal of posted MANUAL journals + auditable fiscal-year carry-forward record.
-- Additive only: no existing row is changed, no default role gains the new capabilities (Full Access / System Admin hold them through the
-- wildcard of migration 075). Posted journals stay immutable: a reversal is a NEW journal that points at the original.
-- Rollback (only while no reversal / carry-forward row exists): DROP TABLE fiscal_year_carryforwards; drop the three journal_entries constraints,
-- the unique index, the trigger and the two columns; DELETE FROM capabilities WHERE id IN (...).

INSERT INTO capabilities (id) VALUES
  ('accounting.journal.reverse'),
  ('fiscal_year.carryforward.prepare')
ON CONFLICT (id) DO NOTHING;

-- 1) Reversal link. A reversal is an ordinary 'standard' journal with reversal_of_journal_id set.
ALTER TABLE journal_entries
  ADD COLUMN reversal_of_journal_id UUID,
  ADD COLUMN reversal_reason TEXT;

ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_reversal_fk
    FOREIGN KEY (reversal_of_journal_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  ADD CONSTRAINT journal_entries_reversal_shape CHECK (
    reversal_of_journal_id IS NULL
    OR (source_type IS NULL AND entry_type = 'standard' AND reversal_of_journal_id <> id
        AND reversal_reason IS NOT NULL AND char_length(btrim(reversal_reason)) BETWEEN 1 AND 500)),
  ADD CONSTRAINT journal_entries_reversal_reason_only CHECK (reversal_reason IS NULL OR reversal_of_journal_id IS NOT NULL);

-- At most one reversal per original journal, enforced by the database even under concurrent requests.
CREATE UNIQUE INDEX journal_entries_one_reversal_uidx
  ON journal_entries (company_id, reversal_of_journal_id) WHERE reversal_of_journal_id IS NOT NULL;

-- Database backstop for eligibility (the service checks the same rules first and gives the user a clear error code).
CREATE FUNCTION journal_reversal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o journal_entries%ROWTYPE;
BEGIN
  IF NEW.reversal_of_journal_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO o FROM journal_entries WHERE id = NEW.reversal_of_journal_id AND company_id = NEW.company_id;
  IF NOT FOUND OR o.status <> 'posted' THEN RAISE EXCEPTION 'only a posted journal can be reversed' USING ERRCODE = '23514'; END IF;
  IF o.source_type IS NOT NULL OR o.entry_type <> 'standard' THEN
    RAISE EXCEPTION 'only a posted manual journal can be reversed' USING ERRCODE = '23514';
  END IF;
  IF o.reversal_of_journal_id IS NOT NULL THEN RAISE EXCEPTION 'a reversal journal cannot be reversed' USING ERRCODE = '23514'; END IF;
  IF NEW.accounting_date < o.accounting_date THEN
    RAISE EXCEPTION 'reversal date cannot precede the original journal date' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_reversal_guard BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_reversal_guard();

-- 2) Carry-forward record: one prepared opening-balance proposal per (prior year -> next year). Nothing is posted by preparing it;
-- the proposal is a DRAFT opening balance review that follows the existing submit / approve / post flow.
CREATE TABLE fiscal_year_carryforwards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_fiscal_year_id UUID NOT NULL,
  to_fiscal_year_id UUID NOT NULL,
  opening_balance_review_id UUID NOT NULL,
  retained_earnings_account_id UUID NOT NULL,
  net_result NUMERIC(18,2) NOT NULL,
  total_debit NUMERIC(18,2) NOT NULL,
  total_credit NUMERIC(18,2) NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count > 0),
  prepared_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, from_fiscal_year_id),
  UNIQUE (company_id, to_fiscal_year_id),
  UNIQUE (company_id, opening_balance_review_id),
  CHECK (from_fiscal_year_id <> to_fiscal_year_id),
  CHECK (total_debit = total_credit),
  FOREIGN KEY (from_fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (opening_balance_review_id, company_id) REFERENCES opening_balance_reviews(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (retained_earnings_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);

CREATE FUNCTION fiscal_year_carryforwards_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fiscal year carry-forward records are immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER fiscal_year_carryforwards_immutable BEFORE UPDATE OR DELETE ON fiscal_year_carryforwards
  FOR EACH ROW EXECUTE FUNCTION fiscal_year_carryforwards_immutable();
