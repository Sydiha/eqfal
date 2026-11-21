-- One balance across payroll transfers, direct payments and their corrections.
-- These entries reference existing journals and never post accounting independently.
CREATE TABLE employee_bonus_balance_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  entitlement_id uuid NOT NULL,
  journal_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payroll','bank','increase','decrease','reversal')),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  reverses_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id, entitlement_id),
  UNIQUE (company_id, idempotency_key),
  UNIQUE (company_id, entitlement_id, journal_id),
  FOREIGN KEY (company_id, entitlement_id)
    REFERENCES employee_bonus_recognitions(company_id, entitlement_id),
  FOREIGN KEY (journal_id, company_id) REFERENCES journal_entries(id, company_id),
  FOREIGN KEY (reverses_id, company_id, entitlement_id)
    REFERENCES employee_bonus_balance_entries(id, company_id, entitlement_id),
  CHECK ((kind='reversal') = (reverses_id IS NOT NULL))
);

CREATE FUNCTION guard_employee_bonus_balance_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approved numeric;
  balance numeric;
  original employee_bonus_balance_entries%ROWTYPE;
  reversed numeric;
  affected integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'bonus balance history is immutable' USING ERRCODE='55000';
  END IF;

  -- A real row write serializes concurrent balance writers, including at repeatable read.
  UPDATE employee_bonus_balance_locks SET revision=revision+1
    WHERE company_id=NEW.company_id AND entitlement_id=NEW.entitlement_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'recognized bonus required' USING ERRCODE='23514';
  END IF;
  SELECT amount INTO STRICT approved FROM employee_bonus_entitlements
    WHERE company_id=NEW.company_id AND id=NEW.entitlement_id;

  IF NEW.kind='reversal' THEN
    SELECT * INTO original FROM employee_bonus_balance_entries
      WHERE id=NEW.reverses_id AND company_id=NEW.company_id AND entitlement_id=NEW.entitlement_id;
    IF NOT FOUND OR original.kind NOT IN ('payroll','bank') THEN
      RAISE EXCEPTION 'bonus reversal requires an original payment' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(sum(amount),0) INTO reversed FROM employee_bonus_balance_entries
      WHERE company_id=NEW.company_id AND entitlement_id=NEW.entitlement_id AND reverses_id=original.id;
    IF reversed+NEW.amount>original.amount THEN
      RAISE EXCEPTION 'bonus reversal exceeds original payment' USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT approved+COALESCE(sum(CASE WHEN kind IN ('increase','reversal') THEN amount ELSE -amount END),0)
    INTO balance FROM employee_bonus_balance_entries
    WHERE company_id=NEW.company_id AND entitlement_id=NEW.entitlement_id;
  IF NEW.kind IN ('payroll','bank','decrease') AND NEW.amount>balance THEN
    RAISE EXCEPTION 'bonus operation exceeds outstanding balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE employee_bonus_balance_locks (
  company_id uuid NOT NULL,
  entitlement_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, entitlement_id),
  FOREIGN KEY (company_id, entitlement_id)
    REFERENCES employee_bonus_recognitions(company_id, entitlement_id)
);

INSERT INTO employee_bonus_balance_locks(company_id, entitlement_id)
SELECT company_id, entitlement_id FROM employee_bonus_recognitions;

CREATE FUNCTION initialize_employee_bonus_balance_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO employee_bonus_balance_locks(company_id, entitlement_id)
    VALUES (NEW.company_id, NEW.entitlement_id);
  RETURN NULL;
END $$;

CREATE TRIGGER initialize_employee_bonus_balance_lock
AFTER INSERT ON employee_bonus_recognitions
FOR EACH ROW EXECUTE FUNCTION initialize_employee_bonus_balance_lock();

CREATE TRIGGER employee_bonus_balance_entry_guard
BEFORE INSERT OR UPDATE OR DELETE ON employee_bonus_balance_entries
FOR EACH ROW EXECUTE FUNCTION guard_employee_bonus_balance_entry();
