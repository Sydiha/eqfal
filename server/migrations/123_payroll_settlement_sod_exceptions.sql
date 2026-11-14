-- A narrowly scoped, independently approved, single-use exception for payroll settlement SoD.
-- The capability is intentionally not placed on any role by this migration.
INSERT INTO capabilities(id, implicit_full_access)
VALUES ('payroll.settlement.exception.approve', FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access = FALSE;

CREATE TABLE payroll_settlement_sod_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  payroll_draft_id UUID NOT NULL,
  liability_line_id UUID NOT NULL,
  intended_actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_reason TEXT NOT NULL CHECK (length(btrim(request_reason)) BETWEEN 1 AND 1000),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','consumed')),
  participant_fingerprint TEXT NOT NULL CHECK (participant_fingerprint ~ '^[0-9a-f]{64}$'),
  payroll_journal_id UUID NOT NULL,
  liability_amount NUMERIC(18,2) NOT NULL CHECK (liability_amount > 0),
  settled_amount NUMERIC(18,2) NOT NULL CHECK (settled_amount >= 0 AND settled_amount < liability_amount),
  decided_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ,
  decision_reason TEXT CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 1 AND 1000),
  approval_expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  settlement_id UUID,
  UNIQUE (id, company_id),
  FOREIGN KEY (payroll_draft_id, company_id) REFERENCES payroll_drafts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (liability_line_id, company_id) REFERENCES journal_lines(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (payroll_journal_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (settlement_id, company_id) REFERENCES payroll_settlement_allocations(id, company_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (requested_by = intended_actor_id),
  CHECK (decided_by IS NULL OR (decided_by <> requested_by AND decided_by <> intended_actor_id)),
  CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL AND approval_expires_at IS NULL AND consumed_at IS NULL AND settlement_id IS NULL)
    OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND approval_expires_at IS NOT NULL AND approval_expires_at > decided_at AND approval_expires_at <= decided_at + INTERVAL '24 hours' AND consumed_at IS NULL AND settlement_id IS NULL)
    OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND approval_expires_at IS NULL AND consumed_at IS NULL AND settlement_id IS NULL)
    OR (status = 'consumed' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND approval_expires_at IS NOT NULL AND approval_expires_at > decided_at AND approval_expires_at <= decided_at + INTERVAL '24 hours' AND consumed_at IS NOT NULL AND settlement_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX payroll_settlement_sod_pending_uidx
  ON payroll_settlement_sod_exceptions(company_id, liability_line_id, intended_actor_id)
  WHERE status = 'pending';
CREATE INDEX payroll_settlement_sod_company_queue_idx
  ON payroll_settlement_sod_exceptions(company_id, status, requested_at);

ALTER TABLE payroll_settlement_allocations
  ADD COLUMN sod_exception_id UUID,
  ADD CONSTRAINT payroll_settlement_sod_exception_fk
    FOREIGN KEY (sod_exception_id, company_id)
    REFERENCES payroll_settlement_sod_exceptions(id, company_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT payroll_settlement_sod_exception_unique
    UNIQUE (company_id, sod_exception_id);

CREATE FUNCTION guard_payroll_settlement_sod_exception_use() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE exception_row payroll_settlement_sod_exceptions%ROWTYPE;
BEGIN
  IF NEW.sod_exception_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO exception_row FROM payroll_settlement_sod_exceptions
    WHERE id=NEW.sod_exception_id AND company_id=NEW.company_id FOR UPDATE;
  IF NOT FOUND OR exception_row.status <> 'approved' OR exception_row.intended_actor_id <> NEW.created_by
     OR exception_row.approval_expires_at IS NULL OR exception_row.approval_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'payroll settlement SoD exception is invalid or already used' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_settlement_sod_exception_use
  BEFORE INSERT ON payroll_settlement_allocations
  FOR EACH ROW EXECUTE FUNCTION guard_payroll_settlement_sod_exception_use();

CREATE FUNCTION guard_payroll_settlement_sod_exception_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll settlement SoD exception history is immutable' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.company_id, NEW.payroll_draft_id, NEW.liability_line_id, NEW.intended_actor_id,
      NEW.requested_by, NEW.request_reason, NEW.requested_at, NEW.participant_fingerprint, NEW.payroll_journal_id,
      NEW.liability_amount, NEW.settled_amount)
     IS DISTINCT FROM
     (OLD.id, OLD.company_id, OLD.payroll_draft_id, OLD.liability_line_id, OLD.intended_actor_id,
      OLD.requested_by, OLD.request_reason, OLD.requested_at, OLD.participant_fingerprint, OLD.payroll_journal_id,
      OLD.liability_amount, OLD.settled_amount) THEN
    RAISE EXCEPTION 'payroll settlement SoD exception scope is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('approved','rejected') AND NEW.decided_by IS NOT NULL AND NEW.decided_at IS NOT NULL AND NEW.decision_reason IS NOT NULL)
    OR (OLD.status = 'approved' AND NEW.status = 'consumed' AND
        (NEW.decided_by, NEW.decided_at, NEW.decision_reason, NEW.approval_expires_at) IS NOT DISTINCT FROM
        (OLD.decided_by, OLD.decided_at, OLD.decision_reason, OLD.approval_expires_at) AND NEW.consumed_at IS NOT NULL AND NEW.settlement_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'invalid payroll settlement SoD exception transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_settlement_sod_exception_history
  BEFORE UPDATE OR DELETE ON payroll_settlement_sod_exceptions
  FOR EACH ROW EXECUTE FUNCTION guard_payroll_settlement_sod_exception_history();
