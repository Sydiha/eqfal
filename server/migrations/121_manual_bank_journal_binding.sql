-- FIN-PAYROLL-04 safety boundary: a standard source-less journal may affect a
-- linked bank ledger only when every bank line is bound to the exact bank
-- transaction it represents. Existing transactions fail closed because no
-- historical inference or backfill can prove that they were not posted before
-- this guard existed.

ALTER TABLE bank_transactions
  ADD COLUMN manual_journal_binding_protected BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bank_transactions
  ALTER COLUMN manual_journal_binding_protected SET DEFAULT TRUE;

ALTER TABLE journal_lines ADD COLUMN bank_transaction_id UUID;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_bank_transaction_fk
  FOREIGN KEY (bank_transaction_id, company_id)
  REFERENCES bank_transactions(id, company_id) ON DELETE RESTRICT;
CREATE INDEX journal_lines_bank_transaction_idx
  ON journal_lines(company_id, bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

CREATE FUNCTION guard_manual_bank_journal_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bank_id UUID;
  bank_row bank_transactions%ROWTYPE;
  movement NUMERIC(18,2);
BEGIN
  IF NEW.status <> 'posted' OR OLD.status = 'posted'
     OR NEW.entry_type <> 'standard' OR NEW.source_type IS NOT NULL
     OR NEW.reversal_of_journal_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- A linked bank-ledger line without a transaction identity is ambiguous.
  IF EXISTS (
    SELECT 1 FROM journal_lines l
    JOIN bank_account_ledger_links b
      ON b.company_id=l.company_id AND b.account_id=l.account_id
     AND b.valid_from<=NEW.accounting_date
     AND (b.valid_to IS NULL OR b.valid_to>=NEW.accounting_date)
    WHERE l.company_id=NEW.company_id AND l.journal_entry_id=NEW.id
      AND l.bank_transaction_id IS NULL
  ) THEN
    RAISE EXCEPTION 'manual bank journal line requires a bank transaction binding' USING ERRCODE='23514';
  END IF;

  -- Lock in UUID order, the same bank rows payroll settlement locks. This makes
  -- a manual posting and payroll allocation mutually exclusive under races.
  FOR bank_id IN
    SELECT DISTINCT l.bank_transaction_id
    FROM journal_lines l
    WHERE l.company_id=NEW.company_id AND l.journal_entry_id=NEW.id
      AND l.bank_transaction_id IS NOT NULL
    ORDER BY l.bank_transaction_id
  LOOP
    SELECT * INTO bank_row FROM bank_transactions
      WHERE id=bank_id AND company_id=NEW.company_id FOR UPDATE;
    IF NOT FOUND OR NOT bank_row.manual_journal_binding_protected THEN
      RAISE EXCEPTION 'bank transaction predates deterministic manual journal binding' USING ERRCODE='23514';
    END IF;
    IF bank_row.transaction_date <> NEW.accounting_date THEN
      RAISE EXCEPTION 'manual bank journal date must equal bank transaction date' USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM journal_lines l
      WHERE l.company_id=NEW.company_id AND l.journal_entry_id=NEW.id
        AND l.bank_transaction_id=bank_id
        AND NOT EXISTS (
          SELECT 1 FROM bank_account_ledger_links b
          WHERE b.company_id=l.company_id AND b.bank_account_id=bank_row.bank_account_id
            AND b.account_id=l.account_id AND b.valid_from<=NEW.accounting_date
            AND (b.valid_to IS NULL OR b.valid_to>=NEW.accounting_date)
        )
    ) THEN
      RAISE EXCEPTION 'manual bank journal binding does not match the linked bank ledger account' USING ERRCODE='23514';
    END IF;

    SELECT COALESCE(SUM(l.debit-l.credit),0) INTO movement
    FROM journal_lines l
    WHERE l.company_id=NEW.company_id AND l.journal_entry_id=NEW.id
      AND l.bank_transaction_id=bank_id;
    IF movement=0 OR SIGN(movement)<>SIGN(bank_row.amount) OR ABS(movement)>ABS(bank_row.amount) THEN
      RAISE EXCEPTION 'manual bank journal movement exceeds or opposes the bank transaction' USING ERRCODE='23514';
    END IF;

    IF EXISTS (SELECT 1 FROM payroll_settlement_allocations WHERE company_id=NEW.company_id AND bank_transaction_id=bank_id)
      OR EXISTS (SELECT 1 FROM bank_transaction_matches WHERE company_id=NEW.company_id AND bank_transaction_id=bank_id)
      OR EXISTS (SELECT 1 FROM document_settlements WHERE company_id=NEW.company_id AND bank_transaction_id=bank_id)
      OR EXISTS (SELECT 1 FROM employee_cost_payment_allocations WHERE company_id=NEW.company_id AND bank_transaction_id=bank_id)
      OR EXISTS (SELECT 1 FROM obligation_settlements WHERE company_id=NEW.company_id AND bank_transaction_id=bank_id)
      OR EXISTS (SELECT 1 FROM personal_payment_reimbursements WHERE company_id=NEW.company_id AND bank_transaction_id=bank_id)
      OR EXISTS (SELECT 1 FROM partner_transactions WHERE company_id=NEW.company_id AND bank_transaction_id=bank_id AND status IN ('draft','posted'))
      OR EXISTS (
        SELECT 1 FROM journal_lines l JOIN journal_entries j
          ON j.id=l.journal_entry_id AND j.company_id=l.company_id
        WHERE l.company_id=NEW.company_id AND l.bank_transaction_id=bank_id
          AND j.status='posted' AND j.id<>NEW.id
      ) THEN
      RAISE EXCEPTION 'bank transaction already has accounting ownership' USING ERRCODE='23505';
    END IF;
  END LOOP;

  -- Phase A remains non-authoritative; these immutable rows are audit evidence
  -- only. Safety comes from the binding above and the shared bank-row lock.
  INSERT INTO bank_transaction_accounting_claims(
    company_id,bank_transaction_id,owner_type,owner_id,signed_amount,created_by
  )
  SELECT l.company_id,l.bank_transaction_id,'manual_journal_line',l.id,
         l.debit-l.credit,NEW.posted_by
  FROM journal_lines l
  WHERE l.company_id=NEW.company_id AND l.journal_entry_id=NEW.id
    AND l.bank_transaction_id IS NOT NULL;

  INSERT INTO bank_transaction_journal_evidence(
    claim_id,company_id,journal_entry_id,bank_ledger_account_id
  )
  SELECT c.id,c.company_id,NEW.id,l.account_id
  FROM journal_lines l JOIN bank_transaction_accounting_claims c
    ON c.company_id=l.company_id AND c.owner_type='manual_journal_line'
   AND c.owner_id=l.id
  WHERE l.company_id=NEW.company_id AND l.journal_entry_id=NEW.id
    AND l.bank_transaction_id IS NOT NULL;
  RETURN NEW;
END $$;

CREATE TRIGGER manual_bank_journal_posting_guard
  BEFORE UPDATE OF status ON journal_entries
  FOR EACH ROW WHEN (NEW.status='posted' AND OLD.status IS DISTINCT FROM 'posted')
  EXECUTE FUNCTION guard_manual_bank_journal_posting();

CREATE FUNCTION protect_manual_bank_journal_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.manual_journal_binding_protected IS DISTINCT FROM NEW.manual_journal_binding_protected THEN
    RAISE EXCEPTION 'manual journal binding protection is immutable' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines l JOIN journal_entries j
      ON j.id=l.journal_entry_id AND j.company_id=l.company_id
    WHERE l.company_id=OLD.company_id AND l.bank_transaction_id=OLD.id
      AND j.status='posted'
  ) THEN
    RAISE EXCEPTION 'bank transaction has posted manual journal evidence' USING ERRCODE='55000';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER manual_bank_journal_history_guard
  BEFORE UPDATE OF company_id,bank_account_id,amount,transaction_date,currency_code,manual_journal_binding_protected OR DELETE
  ON bank_transactions FOR EACH ROW EXECUTE FUNCTION protect_manual_bank_journal_evidence();

CREATE FUNCTION protect_manual_bank_journal_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM journal_lines l JOIN journal_entries j
      ON j.id=l.journal_entry_id AND j.company_id=l.company_id
    JOIN bank_transactions t
      ON t.id=l.bank_transaction_id AND t.company_id=l.company_id
    WHERE j.status='posted' AND t.company_id=OLD.company_id
      AND t.bank_account_id=OLD.bank_account_id
      AND t.transaction_date>=OLD.valid_from
      AND (OLD.valid_to IS NULL OR t.transaction_date<=OLD.valid_to)
      AND (TG_OP='DELETE' OR NEW.valid_to IS NOT NULL AND t.transaction_date>NEW.valid_to)
  ) THEN
    RAISE EXCEPTION 'bank ledger link has posted manual journal evidence' USING ERRCODE='55000';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER manual_bank_journal_link_guard
  BEFORE UPDATE OR DELETE ON bank_account_ledger_links
  FOR EACH ROW EXECUTE FUNCTION protect_manual_bank_journal_link();

-- Extend migration 120's database backstop. Payroll may consume only bank rows
-- created under this binding contract and never one owned by a posted manual
-- journal. The existing function still supplies all amount and workflow checks.
CREATE OR REPLACE FUNCTION guard_payroll_bank_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bank_value NUMERIC; protected BOOLEAN; liability_value NUMERIC; allocated NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'payroll_settlement_allocations' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payroll settlement history is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.bank_transaction_id IS NULL THEN RETURN NEW; END IF;
  SELECT amount,manual_journal_binding_protected INTO bank_value,protected FROM bank_transactions
    WHERE id=NEW.bank_transaction_id AND company_id=NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bank transaction not found' USING ERRCODE='23503'; END IF;
  IF TG_TABLE_NAME <> 'payroll_settlement_allocations' THEN
    IF EXISTS (SELECT 1 FROM payroll_settlement_allocations WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id) THEN
      RAISE EXCEPTION 'bank transaction belongs to payroll settlement' USING ERRCODE='23505';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT protected OR bank_value >= 0
    OR EXISTS (SELECT 1 FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id WHERE l.company_id=NEW.company_id AND l.bank_transaction_id=NEW.bank_transaction_id AND j.status='posted')
    OR EXISTS (SELECT 1 FROM bank_transaction_matches WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id)
    OR EXISTS (SELECT 1 FROM document_settlements WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id)
    OR EXISTS (SELECT 1 FROM employee_cost_payment_allocations WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id)
    OR EXISTS (SELECT 1 FROM obligation_settlements WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id)
    OR EXISTS (SELECT 1 FROM personal_payment_reimbursements WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id)
    OR EXISTS (SELECT 1 FROM partner_transactions WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id AND status IN ('draft','posted')) THEN
    RAISE EXCEPTION 'bank transaction unavailable for payroll settlement' USING ERRCODE='23505';
  END IF;
  SELECT l.credit INTO liability_value FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
    JOIN payroll_drafts d ON d.id=j.source_id AND d.company_id=j.company_id
    WHERE l.id=NEW.liability_line_id AND l.company_id=NEW.company_id AND j.source_type='payroll' AND j.status='posted'
      AND d.status='approved' AND l.debit=0 AND l.credit>0 AND l.memo IN ('net_payroll_liability','employee_deduction_liability','employer_contribution_liability')
    FOR UPDATE OF l;
  IF NOT FOUND THEN RAISE EXCEPTION 'posted payroll liability not found' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO allocated FROM payroll_settlement_allocations WHERE company_id=NEW.company_id AND liability_line_id=NEW.liability_line_id;
  IF allocated + NEW.amount > liability_value THEN RAISE EXCEPTION 'payroll liability exceeded' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO allocated FROM payroll_settlement_allocations WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id;
  IF allocated + NEW.amount > ABS(bank_value) THEN RAISE EXCEPTION 'bank amount exceeded' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
