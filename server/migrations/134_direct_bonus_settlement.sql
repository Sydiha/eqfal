CREATE OR REPLACE FUNCTION guard_payroll_bank_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bank_value NUMERIC; protected BOOLEAN; liability_value NUMERIC; allocated NUMERIC; bank_account UUID;
BEGIN
  IF TG_TABLE_NAME='payroll_settlement_allocations' AND TG_OP<>'INSERT' THEN RAISE EXCEPTION 'payroll settlement history is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.bank_transaction_id IS NULL THEN RETURN NEW; END IF;
  SELECT amount,manual_journal_binding_protected,bank_account_id INTO bank_value,protected,bank_account FROM bank_transactions WHERE id=NEW.bank_transaction_id AND company_id=NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bank transaction not found' USING ERRCODE='23503'; END IF;
  IF TG_TABLE_NAME<>'payroll_settlement_allocations' THEN
    IF EXISTS(SELECT 1 FROM payroll_settlement_allocations WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id) THEN RAISE EXCEPTION 'bank transaction belongs to payroll settlement' USING ERRCODE='23505'; END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM bank_accounts WHERE id=bank_account AND company_id=NEW.company_id FOR UPDATE;
  IF NOT protected OR bank_value>=0 OR EXISTS(SELECT 1 FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id WHERE l.company_id=NEW.company_id AND l.bank_transaction_id=NEW.bank_transaction_id AND j.status='posted')
    OR EXISTS(SELECT 1 FROM bank_transaction_matches WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id)
    OR EXISTS(SELECT 1 FROM document_settlements WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id)
    OR EXISTS(SELECT 1 FROM employee_cost_payment_allocations WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id)
    OR EXISTS(SELECT 1 FROM obligation_settlements WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id)
    OR EXISTS(SELECT 1 FROM personal_payment_reimbursements WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id)
    OR EXISTS(SELECT 1 FROM partner_transactions WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id AND status IN('draft','posted')) THEN
    RAISE EXCEPTION 'bank transaction unavailable for payroll settlement' USING ERRCODE='23505'; END IF;
  IF EXISTS(SELECT 1 FROM bank_account_ledger_links b JOIN journal_lines l ON l.company_id=b.company_id AND l.account_id=b.account_id JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id LEFT JOIN manual_bank_journal_uncertainty_reviews r ON r.company_id=l.company_id AND r.journal_line_id=l.id AND r.bank_account_id=b.bank_account_id WHERE b.company_id=NEW.company_id AND b.bank_account_id=bank_account AND b.valid_from<=j.accounting_date AND (b.valid_to IS NULL OR b.valid_to>=j.accounting_date) AND l.bank_transaction_id IS NULL AND j.status='posted' AND j.entry_type='standard' AND j.source_type IS NULL AND j.reversal_of_journal_id IS NULL AND r.id IS NULL) THEN
    RAISE EXCEPTION 'bank account has unresolved manual journal uncertainty' USING ERRCODE='23505'; END IF;
  IF EXISTS (
    SELECT 1 FROM payroll_settlement_allocations p
    JOIN journal_lines l ON l.id=p.liability_line_id AND l.company_id=p.company_id
    JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
    WHERE p.company_id=NEW.company_id AND p.bank_transaction_id=NEW.bank_transaction_id
      AND (j.source_type='employee_bonus_recognition' OR EXISTS (
        SELECT 1 FROM journal_lines target
        JOIN journal_entries source ON source.id=target.journal_entry_id AND source.company_id=target.company_id
        WHERE target.id=NEW.liability_line_id AND target.company_id=NEW.company_id
          AND source.source_type='employee_bonus_recognition'
      ))
  ) THEN
    RAISE EXCEPTION 'bonus bank transaction already allocated' USING ERRCODE='23505';
  END IF;
  SELECT l.credit INTO liability_value FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
    LEFT JOIN payroll_drafts d ON j.source_type='payroll' AND d.id=j.source_id AND d.company_id=j.company_id
    LEFT JOIN payroll_recovery_corrections rc ON j.source_type='payroll_recovery_correction' AND rc.journal_entry_id=j.id AND rc.company_id=j.company_id AND rc.status='posted'
    LEFT JOIN payroll_employee_advance_recoveries r ON r.id=rc.recovery_id AND r.company_id=rc.company_id
    LEFT JOIN payroll_drafts od ON od.id=r.draft_id AND od.company_id=r.company_id
    WHERE l.id=NEW.liability_line_id AND l.company_id=NEW.company_id AND j.status='posted' AND l.debit=0 AND l.credit>0 AND
      ((j.source_type='payroll' AND d.status='approved' AND l.memo IN('net_payroll_liability','employee_deduction_liability','employer_contribution_liability')) OR
       (j.source_type='employee_bonus_recognition' AND EXISTS (
         SELECT 1 FROM employee_bonus_recognitions bonus WHERE bonus.company_id=j.company_id
           AND bonus.journal_id=j.id AND bonus.liability_account_id=l.account_id
           AND bonus.accounting_date<=(SELECT transaction_date FROM bank_transactions WHERE id=NEW.bank_transaction_id)
       )) OR
       (j.source_type='payroll_recovery_correction' AND rc.status='posted' AND od.status='approved' AND l.memo='employee_salary_advance_payroll_liability_reversal')) FOR UPDATE OF l;
  IF NOT FOUND THEN RAISE EXCEPTION 'posted payroll liability not found' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO allocated FROM payroll_settlement_allocations WHERE company_id=NEW.company_id AND liability_line_id=NEW.liability_line_id;
  IF allocated+NEW.amount>liability_value AND NOT EXISTS (
    SELECT 1 FROM journal_lines l JOIN employee_bonus_recognitions r
      ON r.company_id=l.company_id AND r.journal_id=l.journal_entry_id AND r.liability_account_id=l.account_id
    WHERE l.company_id=NEW.company_id AND l.id=NEW.liability_line_id
  ) THEN RAISE EXCEPTION 'payroll liability exceeded' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO allocated FROM payroll_settlement_allocations WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id;
  IF allocated+NEW.amount>ABS(bank_value) THEN RAISE EXCEPTION 'bank amount exceeded' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

-- Reuse payroll settlement's bank ownership and posted-journal evidence.
CREATE FUNCTION record_direct_bonus_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO employee_bonus_balance_entries(company_id,entitlement_id,journal_id,idempotency_key,kind,amount,created_by)
    SELECT NEW.company_id,r.entitlement_id,NEW.journal_entry_id,NEW.idempotency_key,'bank',NEW.amount,NEW.created_by
    FROM journal_lines l
    JOIN employee_bonus_recognitions r ON r.company_id=l.company_id AND r.journal_id=l.journal_entry_id
    WHERE l.company_id=NEW.company_id AND l.id=NEW.liability_line_id AND l.account_id=r.liability_account_id;
  RETURN NULL;
END $$;

CREATE TRIGGER direct_bonus_settlement_balance
AFTER INSERT ON payroll_settlement_allocations
FOR EACH ROW EXECUTE FUNCTION record_direct_bonus_settlement();
