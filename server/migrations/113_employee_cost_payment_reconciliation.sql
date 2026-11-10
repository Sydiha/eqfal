-- ECC-02: verified employee-cost payments.  This adds settlement evidence only;
-- it does not recognize expenses or create journals.
INSERT INTO capabilities (id) VALUES
  ('employee_cost.payment.view'),
  ('employee_cost.payment.allocate'),
  ('employee_cost.payment.reverse')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE employee_cost_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_transaction_id UUID NOT NULL,
  cost_record_id UUID NOT NULL,
  cost_allocation_id UUID NOT NULL,
  allocation_type TEXT NOT NULL CHECK (allocation_type IN ('payment','reversal')),
  beneficiary_type TEXT NOT NULL CHECK (beneficiary_type IN ('employee','counterparty')),
  counterparty_id UUID,
  reverses_allocation_id UUID,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  reason TEXT CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 500),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  FOREIGN KEY (bank_transaction_id, company_id) REFERENCES bank_transactions(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (cost_record_id, company_id) REFERENCES employee_cost_records(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (cost_allocation_id, company_id) REFERENCES employee_cost_allocations(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (counterparty_id, company_id) REFERENCES counterparties(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (reverses_allocation_id, company_id) REFERENCES employee_cost_payment_allocations(id, company_id) ON DELETE RESTRICT,
  CHECK ((beneficiary_type = 'employee' AND counterparty_id IS NULL) OR (beneficiary_type = 'counterparty' AND counterparty_id IS NOT NULL)),
  CHECK ((allocation_type = 'payment' AND reverses_allocation_id IS NULL AND reason IS NULL)
      OR (allocation_type = 'reversal' AND reverses_allocation_id IS NOT NULL AND reason IS NOT NULL))
);
CREATE INDEX employee_cost_payment_cost_idx ON employee_cost_payment_allocations(company_id,cost_record_id,created_at);
CREATE INDEX employee_cost_payment_bank_idx ON employee_cost_payment_allocations(company_id,bank_transaction_id);
CREATE UNIQUE INDEX employee_cost_payment_reverse_uidx ON employee_cost_payment_allocations(company_id,reverses_allocation_id,bank_transaction_id)
  WHERE allocation_type='reversal';

-- Shared bank-row serialization and capacity check. Existing workflows retain their
-- specific checks; this trigger makes their combined allocations visible to one
-- database invariant and also covers direct/concurrent writes.
CREATE FUNCTION guard_shared_bank_transaction_allocation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  tx UUID;
  co UUID;
  old_tx UUID;
  bank_amount NUMERIC;
  document_total NUMERIC := 0;
  employee_total NUMERIC := 0;
  whole_exists BOOLEAN := FALSE;
  current_whole BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  tx := NEW.bank_transaction_id;
  co := NEW.company_id;
  IF tx IS NULL THEN RETURN NEW; END IF;

  IF TG_OP='UPDATE' AND OLD.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'settlement allocation cannot move between companies' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.bank_transaction_id IS DISTINCT FROM NEW.bank_transaction_id THEN
    old_tx := OLD.bank_transaction_id;
    PERFORM id FROM bank_transactions WHERE company_id=co AND id IN (old_tx,tx) ORDER BY id FOR UPDATE;
  END IF;

  SELECT amount INTO bank_amount FROM bank_transactions
   WHERE id=tx AND company_id=co FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bank transaction not found for company' USING ERRCODE='23503'; END IF;
  IF bank_amount = 0 THEN RAISE EXCEPTION 'zero-value bank transactions cannot be allocated' USING ERRCODE='23514'; END IF;

  SELECT COALESCE(SUM(amount),0) INTO document_total FROM document_settlements
   WHERE bank_transaction_id=tx AND company_id=co
     AND (TG_TABLE_NAME <> 'document_settlements' OR id <> NEW.id);
  SELECT COALESCE(SUM(amount),0) INTO employee_total FROM employee_cost_payment_allocations
   WHERE bank_transaction_id=tx AND company_id=co
     AND (TG_TABLE_NAME <> 'employee_cost_payment_allocations' OR id <> NEW.id);
  IF TG_TABLE_NAME='document_settlements' THEN document_total := document_total + NEW.amount; END IF;
  IF TG_TABLE_NAME='employee_cost_payment_allocations' THEN employee_total := employee_total + NEW.amount; END IF;

  SELECT
    EXISTS(SELECT 1 FROM obligation_settlements s WHERE s.bank_transaction_id=tx AND s.company_id=co
      AND (TG_TABLE_NAME <> 'obligation_settlements' OR s.id <> NEW.id))
    OR EXISTS(SELECT 1 FROM personal_payment_reimbursements r WHERE r.bank_transaction_id=tx AND r.company_id=co
      AND (TG_TABLE_NAME <> 'personal_payment_reimbursements' OR r.id <> NEW.id))
    OR EXISTS(SELECT 1 FROM partner_transactions p WHERE p.bank_transaction_id=tx AND p.company_id=co AND p.status IN ('draft','posted')
      AND (TG_TABLE_NAME <> 'partner_transactions' OR p.id <> NEW.id))
    OR EXISTS(SELECT 1 FROM bank_transaction_matches m WHERE m.bank_transaction_id=tx AND m.company_id=co AND m.match_type <> 'document'
      AND (TG_TABLE_NAME <> 'bank_transaction_matches' OR m.id <> NEW.id))
  INTO whole_exists;

  current_whole := TG_TABLE_NAME IN ('obligation_settlements','personal_payment_reimbursements');
  IF TG_TABLE_NAME='partner_transactions' THEN current_whole := NEW.status IN ('draft','posted'); END IF;
  IF TG_TABLE_NAME='bank_transaction_matches' THEN current_whole := NEW.match_type <> 'document'; END IF;

  IF (whole_exists OR current_whole) AND (document_total + employee_total > 0 OR whole_exists AND current_whole) THEN
    RAISE EXCEPTION 'bank transaction is already allocated through another settlement workflow' USING ERRCODE='23505';
  END IF;
  IF document_total + employee_total > ABS(bank_amount) THEN
    RAISE EXCEPTION 'combined bank transaction allocations exceed the bank transaction amount' USING ERRCODE='23514';
  END IF;

  IF TG_TABLE_NAME='employee_cost_payment_allocations' AND TG_OP='INSERT' THEN
    IF NEW.allocation_type='payment' AND bank_amount >= 0 THEN
      RAISE EXCEPTION 'employee cost payments require a bank outflow' USING ERRCODE='23514';
    ELSIF NEW.allocation_type='reversal' AND bank_amount <= 0 THEN
      RAISE EXCEPTION 'employee cost payment reversals require a bank inflow' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER shared_bank_allocation_document BEFORE INSERT OR UPDATE ON document_settlements
FOR EACH ROW EXECUTE FUNCTION guard_shared_bank_transaction_allocation();
CREATE TRIGGER shared_bank_allocation_obligation BEFORE INSERT OR UPDATE ON obligation_settlements
FOR EACH ROW EXECUTE FUNCTION guard_shared_bank_transaction_allocation();
CREATE TRIGGER shared_bank_allocation_match BEFORE INSERT OR UPDATE ON bank_transaction_matches
FOR EACH ROW EXECUTE FUNCTION guard_shared_bank_transaction_allocation();
CREATE TRIGGER shared_bank_allocation_personal_payment BEFORE INSERT ON personal_payment_reimbursements
FOR EACH ROW EXECUTE FUNCTION guard_shared_bank_transaction_allocation();
CREATE TRIGGER shared_bank_allocation_partner BEFORE INSERT OR UPDATE OF bank_transaction_id,status ON partner_transactions
FOR EACH ROW EXECUTE FUNCTION guard_shared_bank_transaction_allocation();
CREATE TRIGGER shared_bank_allocation_employee_cost BEFORE INSERT ON employee_cost_payment_allocations
FOR EACH ROW EXECUTE FUNCTION guard_shared_bank_transaction_allocation();

CREATE FUNCTION employee_cost_payment_allocation_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  cost_row RECORD;
  cost_allocation RECORD;
  bank_row RECORD;
  original RECORD;
  net_paid NUMERIC;
  reversed NUMERIC;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'employee cost payment history is immutable; add a reversal instead' USING ERRCODE='55000';
  END IF;

  -- Follow the shared lock order: bank transaction first, then cost record.
  SELECT amount,transaction_date,currency_code,source_kind,manual_category,reconciliation_status
    INTO bank_row FROM bank_transactions WHERE id=NEW.bank_transaction_id AND company_id=NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bank transaction not found for company' USING ERRCODE='23503'; END IF;
  IF bank_row.reconciliation_status='reconciled' THEN RAISE EXCEPTION 'reopen bank reconciliation before allocating' USING ERRCODE='23514'; END IF;
  IF bank_row.source_kind='manual' AND COALESCE(bank_row.manual_category,'') NOT IN ('supplier_payment','government_payment','other') THEN
    RAISE EXCEPTION 'manual bank transaction category cannot pay employee costs' USING ERRCODE='23514';
  END IF;
  IF bank_row.currency_code <> (SELECT currency_code FROM employee_cost_records WHERE id=NEW.cost_record_id AND company_id=NEW.company_id) THEN
    RAISE EXCEPTION 'bank transaction and cost currency must match' USING ERRCODE='23514';
  END IF;

  SELECT r.*,e.id AS verified_employee_id INTO cost_row
    FROM employee_cost_records r JOIN employees e ON e.id=r.employee_id AND e.company_id=r.company_id
   WHERE r.id=NEW.cost_record_id AND r.company_id=NEW.company_id FOR UPDATE OF r;
  IF NOT FOUND OR cost_row.status <> 'approved' OR cost_row.nature='employee_deduction' THEN
    RAISE EXCEPTION 'only approved earnings and employer costs may be paid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO cost_allocation FROM employee_cost_allocations
   WHERE id=NEW.cost_allocation_id AND cost_record_id=NEW.cost_record_id AND company_id=NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment allocation must reference a month allocated to this cost' USING ERRCODE='23503'; END IF;

  IF NEW.beneficiary_type='employee' THEN
    IF NEW.counterparty_id IS NOT NULL OR cost_row.nature <> 'earning' THEN
      RAISE EXCEPTION 'employee beneficiaries are valid only for earnings' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM counterparties WHERE id=NEW.counterparty_id AND company_id=NEW.company_id AND is_active) THEN
      RAISE EXCEPTION 'third-party beneficiary must be active in this company' USING ERRCODE='23503';
    END IF;
  END IF;

  IF NEW.allocation_type='payment' THEN
    IF bank_row.amount >= 0 OR EXISTS (SELECT 1 FROM employee_cost_records n WHERE n.company_id=NEW.company_id AND n.supersedes_id=NEW.cost_record_id AND n.status='approved') THEN
      RAISE EXCEPTION 'payment requires an active approved cost and an outbound bank transaction' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(SUM(CASE WHEN allocation_type='payment' THEN amount ELSE -amount END),0) INTO net_paid
      FROM employee_cost_payment_allocations WHERE company_id=NEW.company_id AND cost_allocation_id=NEW.cost_allocation_id;
    IF net_paid + NEW.amount > cost_allocation.amount THEN
      RAISE EXCEPTION 'employee cost payment exceeds the outstanding amount' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT a.* INTO original FROM employee_cost_payment_allocations a
     WHERE a.id=NEW.reverses_allocation_id AND a.company_id=NEW.company_id FOR UPDATE;
    IF NOT FOUND OR original.allocation_type <> 'payment' OR original.cost_record_id <> NEW.cost_record_id
       OR original.cost_allocation_id <> NEW.cost_allocation_id
       OR original.beneficiary_type <> NEW.beneficiary_type OR original.counterparty_id IS DISTINCT FROM NEW.counterparty_id
       OR bank_row.amount <= 0 THEN
      RAISE EXCEPTION 'reversal must reference a matching payment and an inbound bank transaction' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(SUM(amount),0) INTO reversed FROM employee_cost_payment_allocations
      WHERE company_id=NEW.company_id AND reverses_allocation_id=original.id;
    IF reversed + NEW.amount > original.amount THEN
      RAISE EXCEPTION 'reversal exceeds the unreversed payment amount' USING ERRCODE='23514';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM fiscal_years fy WHERE fy.company_id=NEW.company_id AND fy.status='closed'
      AND bank_row.transaction_date BETWEEN fy.start_date AND fy.end_date)
     OR EXISTS (SELECT 1 FROM monthly_close_periods m WHERE m.company_id=NEW.company_id AND m.status='closed'
      AND bank_row.transaction_date BETWEEN m.period_start AND m.period_end) THEN
    RAISE EXCEPTION 'employee cost payment date is in a closed accounting period' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_cost_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON employee_cost_payment_allocations
FOR EACH ROW EXECUTE FUNCTION employee_cost_payment_allocation_guard();

CREATE FUNCTION employee_cost_paid_correction_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE paid NUMERIC;
BEGIN
  IF NEW.supersedes_id IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM employee_cost_records WHERE id=NEW.supersedes_id AND company_id=NEW.company_id FOR UPDATE;
  SELECT COALESCE(SUM(CASE WHEN allocation_type='payment' THEN amount ELSE -amount END),0) INTO paid
    FROM employee_cost_payment_allocations WHERE company_id=NEW.company_id AND cost_record_id=NEW.supersedes_id;
  IF paid <> 0 THEN RAISE EXCEPTION 'reverse or reassign active payments before correcting a paid employee cost' USING ERRCODE='23514', CONSTRAINT='employee_cost_payment_active'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_cost_paid_correction BEFORE INSERT OR UPDATE OF status,supersedes_id ON employee_cost_records
FOR EACH ROW EXECUTE FUNCTION employee_cost_paid_correction_guard();
