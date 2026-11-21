CREATE TABLE employee_bonus_recognitions (
  entitlement_id uuid NOT NULL,
  company_id uuid NOT NULL,
  journal_id uuid NOT NULL,
  verified_by uuid NOT NULL REFERENCES users(id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_on date NOT NULL,
  accounting_date date NOT NULL CHECK (accounting_date >= fulfilled_on),
  evidence text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 1 AND 4000),
  date_reason text CHECK (length(btrim(date_reason)) BETWEEN 1 AND 1000),
  expense_account_id uuid NOT NULL,
  liability_account_id uuid NOT NULL,
  PRIMARY KEY (company_id, entitlement_id),
  UNIQUE (company_id, journal_id),
  FOREIGN KEY (entitlement_id, company_id) REFERENCES employee_bonus_entitlements(id, company_id),
  FOREIGN KEY (journal_id, company_id) REFERENCES journal_entries(id, company_id),
  FOREIGN KEY (expense_account_id, company_id) REFERENCES accounts(id, company_id),
  FOREIGN KEY (liability_account_id, company_id) REFERENCES accounts(id, company_id),
  CHECK (accounting_date = fulfilled_on OR date_reason IS NOT NULL),
  CHECK (expense_account_id <> liability_account_id)
);

CREATE FUNCTION guard_bonus_recognition_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bonus recognition history is immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER bonus_recognition_history_guard
BEFORE UPDATE OR DELETE ON employee_bonus_recognitions
FOR EACH ROW EXECUTE FUNCTION guard_bonus_recognition_history();

-- The journal is created and posted in the same transaction as verification.
CREATE FUNCTION verify_bonus_recognition_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM journal_entries j
    JOIN employee_bonus_entitlements e ON e.id=NEW.entitlement_id AND e.company_id=NEW.company_id
    WHERE j.id=NEW.journal_id AND j.company_id=NEW.company_id
      AND j.status='posted' AND j.entry_type='standard'
      AND j.source_type='employee_bonus_recognition' AND j.source_id=e.id
      AND j.accounting_date=NEW.accounting_date AND e.approved_at IS NOT NULL AND e.amount>0
      AND (SELECT count(*) FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.company_id=j.company_id)=2
      AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.company_id=j.company_id
        AND l.account_id=NEW.expense_account_id AND l.debit=e.amount AND l.credit=0)
      AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.company_id=j.company_id
        AND l.account_id=NEW.liability_account_id AND l.credit=e.amount AND l.debit=0)
  ) THEN
    RAISE EXCEPTION 'bonus recognition requires its exact posted journal' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER bonus_recognition_journal_guard
AFTER INSERT ON employee_bonus_recognitions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_bonus_recognition_journal();
