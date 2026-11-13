-- FIN-PAYROLL-04: immutable evidence for a settlement allocation. The service
-- creates the allocation and its journal in the same transaction.
INSERT INTO capabilities(id, implicit_full_access) VALUES
  ('payroll.settlement.view', FALSE), ('payroll.settlement.create', FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access=FALSE;

CREATE TABLE payroll_settlement_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  bank_transaction_id UUID NOT NULL,
  liability_line_id UUID NOT NULL,
  journal_entry_id UUID NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  idempotency_key UUID NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, idempotency_key),
  UNIQUE (company_id, journal_entry_id),
  FOREIGN KEY (bank_transaction_id, company_id) REFERENCES bank_transactions(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (liability_line_id, company_id) REFERENCES journal_lines(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX payroll_settlement_bank_idx ON payroll_settlement_allocations(company_id, bank_transaction_id);
CREATE INDEX payroll_settlement_liability_idx ON payroll_settlement_allocations(company_id, liability_line_id);

-- Both sides of the ownership rule lock the same bank row. This makes the
-- exclusion effective even when different workflows race one another.
CREATE FUNCTION guard_payroll_bank_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bank_value NUMERIC; liability_value NUMERIC; allocated NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'payroll_settlement_allocations' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payroll settlement history is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.bank_transaction_id IS NULL THEN RETURN NEW; END IF;
  SELECT amount INTO bank_value FROM bank_transactions
    WHERE id=NEW.bank_transaction_id AND company_id=NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bank transaction not found' USING ERRCODE='23503'; END IF;
  IF TG_TABLE_NAME <> 'payroll_settlement_allocations' THEN
    IF EXISTS (SELECT 1 FROM payroll_settlement_allocations WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id) THEN
      RAISE EXCEPTION 'bank transaction belongs to payroll settlement' USING ERRCODE='23505';
    END IF;
    RETURN NEW;
  END IF;
  IF bank_value >= 0 OR EXISTS (SELECT 1 FROM bank_transaction_matches WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id)
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
CREATE TRIGGER payroll_settlement_ownership BEFORE INSERT OR UPDATE OR DELETE ON payroll_settlement_allocations FOR EACH ROW EXECUTE FUNCTION guard_payroll_bank_ownership();
CREATE TRIGGER payroll_ownership_document BEFORE INSERT OR UPDATE ON document_settlements FOR EACH ROW EXECUTE FUNCTION guard_payroll_bank_ownership();
CREATE TRIGGER payroll_ownership_match BEFORE INSERT OR UPDATE ON bank_transaction_matches FOR EACH ROW EXECUTE FUNCTION guard_payroll_bank_ownership();
CREATE TRIGGER payroll_ownership_employee BEFORE INSERT ON employee_cost_payment_allocations FOR EACH ROW EXECUTE FUNCTION guard_payroll_bank_ownership();
CREATE TRIGGER payroll_ownership_obligation BEFORE INSERT OR UPDATE ON obligation_settlements FOR EACH ROW EXECUTE FUNCTION guard_payroll_bank_ownership();
CREATE TRIGGER payroll_ownership_personal BEFORE INSERT ON personal_payment_reimbursements FOR EACH ROW EXECUTE FUNCTION guard_payroll_bank_ownership();
CREATE TRIGGER payroll_ownership_partner BEFORE INSERT OR UPDATE OF bank_transaction_id,status ON partner_transactions FOR EACH ROW EXECUTE FUNCTION guard_payroll_bank_ownership();

-- Settlement evidence must keep pointing at the same bank transaction facts.
CREATE FUNCTION guard_payroll_settlement_bank_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payroll_settlement_allocations WHERE company_id=OLD.company_id AND bank_transaction_id=OLD.id) THEN
    RAISE EXCEPTION 'bank transaction has payroll settlement history' USING ERRCODE='55000';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER payroll_settlement_bank_history BEFORE UPDATE OF company_id,bank_account_id,amount,transaction_date,currency_code OR DELETE ON bank_transactions
FOR EACH ROW EXECUTE FUNCTION guard_payroll_settlement_bank_history();

-- Deferred because allocation and journal are created and posted atomically.
-- The evidence is never allowed to point at an unrelated or draft journal.
CREATE FUNCTION verify_payroll_settlement_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid BOOLEAN;
BEGIN
  -- Serialize evidence validation with a concurrent end-date change.
  PERFORM b.id FROM bank_account_ledger_links b JOIN bank_transactions t
    ON t.company_id=b.company_id AND t.bank_account_id=b.bank_account_id
    WHERE t.id=NEW.bank_transaction_id AND t.company_id=NEW.company_id
      AND b.valid_from<=t.transaction_date AND (b.valid_to IS NULL OR b.valid_to>=t.transaction_date)
    FOR SHARE OF b;
  SELECT EXISTS (
    SELECT 1 FROM journal_entries j
    JOIN bank_transactions t ON t.id=NEW.bank_transaction_id AND t.company_id=NEW.company_id
    JOIN journal_lines original ON original.id=NEW.liability_line_id AND original.company_id=NEW.company_id
    JOIN bank_account_ledger_links b ON b.company_id=t.company_id AND b.bank_account_id=t.bank_account_id
      AND b.valid_from<=t.transaction_date AND (b.valid_to IS NULL OR b.valid_to>=t.transaction_date)
    WHERE j.id=NEW.journal_entry_id AND j.company_id=NEW.company_id AND j.status='posted'
      AND j.source_type='payroll_settlement' AND j.source_id=NEW.id AND j.accounting_date=t.transaction_date
      AND b.account_id<>original.account_id
      AND (SELECT COUNT(*) FROM journal_lines l WHERE l.company_id=j.company_id AND l.journal_entry_id=j.id)=2
      AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.company_id=j.company_id AND l.journal_entry_id=j.id
           AND l.account_id=original.account_id AND l.debit=NEW.amount AND l.credit=0)
      AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.company_id=j.company_id AND l.journal_entry_id=j.id
           AND l.account_id=b.account_id AND l.credit=NEW.amount AND l.debit=0)
  ) INTO valid;
  IF NOT valid THEN RAISE EXCEPTION 'payroll settlement journal does not match its evidence' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_settlement_evidence_guard AFTER INSERT ON payroll_settlement_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_payroll_settlement_evidence();

CREATE FUNCTION guard_payroll_settlement_bank_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payroll_settlement_allocations p JOIN bank_transactions t
       ON t.id=p.bank_transaction_id AND t.company_id=p.company_id
       WHERE t.company_id=OLD.company_id AND t.bank_account_id=OLD.bank_account_id
         AND t.transaction_date>=OLD.valid_from AND (OLD.valid_to IS NULL OR t.transaction_date<=OLD.valid_to)
         AND (TG_OP='DELETE' OR NEW.valid_to IS NOT NULL AND t.transaction_date>NEW.valid_to)) THEN
    RAISE EXCEPTION 'bank ledger link has payroll settlement history' USING ERRCODE='55000';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER payroll_settlement_bank_link BEFORE UPDATE OR DELETE ON bank_account_ledger_links
FOR EACH ROW EXECUTE FUNCTION guard_payroll_settlement_bank_link();
