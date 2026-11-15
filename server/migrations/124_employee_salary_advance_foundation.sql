-- Employee Salary Advance Phase A. These are employee receivables and remain
-- separate from expense custody. No historical records are migrated.
INSERT INTO capabilities(id) VALUES
  ('employee_salary_advance.view'),
  ('employee_salary_advance.create'),
  ('employee_salary_advance.approve'),
  ('employee_salary_advance.issue'),
  ('employee_salary_advance.mapping.manage')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE employee_salary_advance_account_mappings (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  updated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);

CREATE TABLE employee_salary_advances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency_code CHAR(3) NOT NULL DEFAULT 'SAR' CHECK (currency_code = 'SAR'),
  issue_date DATE NOT NULL,
  description TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','pending_posting','issued')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  bank_transaction_match_id UUID,
  journal_entry_id UUID,
  UNIQUE (id, company_id),
  UNIQUE (bank_transaction_match_id),
  UNIQUE (journal_entry_id),
  FOREIGN KEY (employee_id, company_id) REFERENCES employees(id, company_id) ON DELETE RESTRICT,
  CHECK ((status='draft' AND approved_by IS NULL AND approved_at IS NULL AND bank_transaction_match_id IS NULL AND journal_entry_id IS NULL)
      OR (status='approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND bank_transaction_match_id IS NULL AND journal_entry_id IS NULL)
      OR (status='pending_posting' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND bank_transaction_match_id IS NOT NULL AND journal_entry_id IS NULL)
      OR (status='issued' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND bank_transaction_match_id IS NOT NULL AND journal_entry_id IS NOT NULL))
);
CREATE INDEX employee_salary_advances_company_employee_idx ON employee_salary_advances(company_id,employee_id,created_at DESC);
CREATE INDEX employee_salary_advances_company_status_idx ON employee_salary_advances(company_id,status,created_at DESC);

ALTER TABLE bank_transaction_matches ADD COLUMN employee_salary_advance_id UUID;
ALTER TABLE bank_transaction_matches DROP CONSTRAINT bank_transaction_matches_type_check;
ALTER TABLE bank_transaction_matches ADD CONSTRAINT bank_transaction_matches_type_check CHECK (
  (match_type='document' AND document_id IS NOT NULL AND custody_id IS NULL AND employee_salary_advance_id IS NULL)
  OR (match_type IN ('custody_funding','custody_return') AND document_id IS NULL AND custody_id IS NOT NULL AND employee_salary_advance_id IS NULL)
  OR (match_type='employee_advance_funding' AND document_id IS NULL AND custody_id IS NULL AND employee_salary_advance_id IS NOT NULL)
);
ALTER TABLE bank_transaction_matches ADD CONSTRAINT bank_transaction_matches_employee_advance_company_fk
  FOREIGN KEY (employee_salary_advance_id,company_id) REFERENCES employee_salary_advances(id,company_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX bank_transaction_matches_employee_advance_uidx
  ON bank_transaction_matches(company_id,employee_salary_advance_id) WHERE employee_salary_advance_id IS NOT NULL;
ALTER TABLE employee_salary_advances ADD CONSTRAINT employee_salary_advances_match_company_fk
  FOREIGN KEY (bank_transaction_match_id,company_id) REFERENCES bank_transaction_matches(id,company_id) ON DELETE RESTRICT;
ALTER TABLE employee_salary_advances ADD CONSTRAINT employee_salary_advances_journal_company_fk
  FOREIGN KEY (journal_entry_id,company_id) REFERENCES journal_entries(id,company_id) ON DELETE RESTRICT;

CREATE FUNCTION employee_salary_advance_transition_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status<>'draft' THEN RAISE EXCEPTION 'Only draft employee salary advances may be deleted' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status='issued' THEN RAISE EXCEPTION 'Issued employee salary advances are immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status='draft' AND NEW.status NOT IN ('draft','approved') THEN RAISE EXCEPTION 'Invalid employee salary advance transition' USING ERRCODE='55000'; END IF;
  IF OLD.status='approved' AND NEW.status NOT IN ('approved','pending_posting') THEN RAISE EXCEPTION 'Invalid employee salary advance transition' USING ERRCODE='55000'; END IF;
  IF OLD.status='pending_posting' AND NEW.status NOT IN ('pending_posting','issued') THEN RAISE EXCEPTION 'Invalid employee salary advance transition' USING ERRCODE='55000'; END IF;
  IF OLD.status<>'draft' AND (NEW.company_id<>OLD.company_id OR NEW.employee_id<>OLD.employee_id OR NEW.amount<>OLD.amount OR NEW.currency_code<>OLD.currency_code OR NEW.issue_date<>OLD.issue_date OR NEW.description<>OLD.description OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'Approved employee salary advance facts are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='pending_posting' AND (NEW.bank_transaction_match_id IS DISTINCT FROM OLD.bank_transaction_match_id OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id AND NEW.status<>'issued') THEN
    RAISE EXCEPTION 'Pending employee salary advance funding is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.status='issued' AND (NEW.journal_entry_id IS NULL OR NEW.bank_transaction_match_id IS NULL) THEN RAISE EXCEPTION 'Issued employee salary advance requires posted journal evidence' USING ERRCODE='23514'; END IF;
  IF NEW.status='issued' AND NOT EXISTS(SELECT 1 FROM journal_entries WHERE id=NEW.journal_entry_id AND company_id=NEW.company_id AND status='posted' AND source_type='employee_advance_funding') THEN
    RAISE EXCEPTION 'Employee salary advance can be issued only with a posted funding journal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_salary_advance_transition BEFORE UPDATE OR DELETE ON employee_salary_advances
FOR EACH ROW EXECUTE FUNCTION employee_salary_advance_transition_guard();

-- The existing triggers in migrations 100, 113, 120 and 121 already serialize
-- document/custody, employee-cost, payroll and manual-journal claims by locking
-- the bank row. This claim trigger applies the same lock and rejects all other
-- ownership classes before allowing the advance match to commit.
CREATE FUNCTION employee_salary_advance_bank_claim_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bank_amount NUMERIC;
BEGIN
  IF NEW.match_type<>'employee_advance_funding' THEN RETURN NEW; END IF;
  SELECT amount INTO bank_amount FROM bank_transactions WHERE id=NEW.bank_transaction_id AND company_id=NEW.company_id FOR UPDATE;
  IF NOT FOUND OR bank_amount>=0 THEN RAISE EXCEPTION 'Employee salary advance requires an outbound bank transaction' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
      WHERE l.company_id=NEW.company_id AND l.bank_transaction_id=NEW.bank_transaction_id AND j.source_type IS NULL AND j.status IN('draft','posted')) THEN
    RAISE EXCEPTION 'Bank transaction is bound to a manual journal' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_salary_advance_bank_claim BEFORE INSERT ON bank_transaction_matches
FOR EACH ROW EXECUTE FUNCTION employee_salary_advance_bank_claim_guard();

-- Keep advance bank and match facts immutable from the moment issuance is queued.
CREATE FUNCTION employee_salary_advance_match_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE advance_status TEXT;
BEGIN
  IF OLD.match_type='employee_advance_funding' THEN
    SELECT status INTO advance_status FROM employee_salary_advances WHERE id=OLD.employee_salary_advance_id AND company_id=OLD.company_id FOR UPDATE;
    IF advance_status IN ('pending_posting','issued') THEN RAISE EXCEPTION 'Pending or issued employee advance funding cannot be changed' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER employee_salary_advance_match_guard BEFORE UPDATE OR DELETE ON bank_transaction_matches
FOR EACH ROW EXECUTE FUNCTION employee_salary_advance_match_guard();

-- A queued or issued advance owns its bank source until the posted history is preserved.
CREATE FUNCTION employee_salary_advance_bank_transaction_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='DELETE' OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id)
    AND EXISTS(
      SELECT 1 FROM bank_transaction_matches m
      JOIN employee_salary_advances a ON a.id=m.employee_salary_advance_id AND a.company_id=m.company_id
      WHERE m.company_id=OLD.company_id AND m.bank_transaction_id=OLD.id AND a.status IN ('pending_posting','issued')
    ) THEN
    RAISE EXCEPTION 'Pending or issued employee advance bank transaction is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_salary_advance_bank_transaction_guard BEFORE UPDATE OF amount,transaction_date,bank_account_id OR DELETE ON bank_transactions
FOR EACH ROW EXECUTE FUNCTION employee_salary_advance_bank_transaction_guard();
