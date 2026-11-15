-- Controlled cancellation of an unposted salary-advance issuance. Posted
-- issuance remains immutable and must be corrected through normal accounting.
INSERT INTO capabilities(id) VALUES ('employee_salary_advance.cancel') ON CONFLICT(id) DO NOTHING;

ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_voided_source_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_voided_source_check CHECK (
  status <> 'voided' OR
  (source_type='invoice_adjustment' AND source_id IS NOT NULL) OR
  (source_type='employee_advance_funding' AND source_id IS NOT NULL)
);

-- Preserve the existing invoice-adjustment void protocol and add a distinct
-- transaction-local authorization for pending employee advance issuance.
CREATE OR REPLACE FUNCTION guard_journal_void() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE note_status TEXT; advance_id UUID; old_j JSONB; new_j JSONB;
        meta TEXT[] := ARRAY['status','voided_at','voided_by','void_reason','updated_at'];
BEGIN
  IF TG_OP='INSERT' THEN
    RAISE EXCEPTION 'a journal cannot be created as voided' USING ERRCODE='23514';
  END IF;
  IF NEW.status='voided' THEN
    IF OLD.status<>'draft' THEN RAISE EXCEPTION 'only a draft journal can be voided' USING ERRCODE='23514'; END IF;
    old_j:=to_jsonb(OLD);new_j:=to_jsonb(NEW);
    IF (old_j-meta)<>(new_j-meta) THEN RAISE EXCEPTION 'voiding cannot alter the journal' USING ERRCODE='23514'; END IF;
    IF OLD.source_type='invoice_adjustment' THEN
      IF current_setting('eqfal.adjustment_void',true) IS DISTINCT FROM OLD.source_id::text THEN
        RAISE EXCEPTION 'a note journal is voided only by the controlled note cancellation' USING ERRCODE='23514';
      END IF;
      SELECT status INTO note_status FROM invoice_adjustments WHERE id=OLD.source_id AND company_id=OLD.company_id;
      IF note_status IS DISTINCT FROM 'cancelled' THEN RAISE EXCEPTION 'the note must be cancelled before its journal is voided' USING ERRCODE='23514'; END IF;
    ELSIF OLD.source_type='employee_advance_funding' THEN
      SELECT a.id INTO advance_id FROM employee_salary_advances a
      JOIN bank_transaction_matches m ON m.id=a.bank_transaction_match_id AND m.company_id=a.company_id
      WHERE a.company_id=OLD.company_id AND a.status='pending_posting'
        AND a.id::text=current_setting('eqfal.employee_salary_advance_cancel',true)
        AND m.id=OLD.source_id AND m.match_type='employee_advance_funding';
      IF advance_id IS NULL THEN RAISE EXCEPTION 'employee advance journal can be voided only by cancelling its pending issuance' USING ERRCODE='23514'; END IF;
    ELSE
      RAISE EXCEPTION 'this journal source cannot be voided' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.status='posted' AND NEW.source_type='invoice_adjustment' THEN
    SELECT status INTO note_status FROM invoice_adjustments WHERE id=NEW.source_id AND company_id=NEW.company_id;
    IF note_status IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'the journal of a note that is not approved cannot be posted' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION employee_salary_advance_transition_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status<>'draft' THEN RAISE EXCEPTION 'Only draft employee salary advances may be deleted' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status='issued' THEN RAISE EXCEPTION 'Issued employee salary advances are immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status='draft' AND NEW.status NOT IN ('draft','approved') THEN RAISE EXCEPTION 'Invalid employee salary advance transition' USING ERRCODE='55000'; END IF;
  IF OLD.status='approved' AND NEW.status NOT IN ('approved','pending_posting') THEN RAISE EXCEPTION 'Invalid employee salary advance transition' USING ERRCODE='55000'; END IF;
  IF OLD.status='pending_posting' AND NEW.status NOT IN ('pending_posting','approved','issued') THEN RAISE EXCEPTION 'Invalid employee salary advance transition' USING ERRCODE='55000'; END IF;
  IF OLD.status<>'draft' AND (NEW.company_id<>OLD.company_id OR NEW.employee_id<>OLD.employee_id OR NEW.amount<>OLD.amount OR NEW.currency_code<>OLD.currency_code OR NEW.issue_date<>OLD.issue_date OR NEW.description<>OLD.description OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'Approved employee salary advance facts are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='pending_posting' AND NEW.status='approved' THEN
    IF current_setting('eqfal.employee_salary_advance_cancel',true) IS DISTINCT FROM OLD.id::text
      OR NEW.bank_transaction_match_id IS NOT NULL OR NEW.journal_entry_id IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM journal_entries j WHERE j.company_id=OLD.company_id AND j.source_type='employee_advance_funding' AND j.source_id=OLD.bank_transaction_match_id AND j.status='voided') THEN
      RAISE EXCEPTION 'Pending employee advance can return to approved only through controlled cancellation' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.status='pending_posting' AND (NEW.bank_transaction_match_id IS DISTINCT FROM OLD.bank_transaction_match_id OR (NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id AND NEW.status<>'issued')) THEN
    RAISE EXCEPTION 'Pending employee salary advance funding is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.status='issued' AND (NEW.journal_entry_id IS NULL OR NEW.bank_transaction_match_id IS NULL) THEN RAISE EXCEPTION 'Issued employee salary advance requires posted journal evidence' USING ERRCODE='23514'; END IF;
  IF NEW.status='issued' AND NOT EXISTS(SELECT 1 FROM journal_entries WHERE id=NEW.journal_entry_id AND company_id=NEW.company_id AND status='posted' AND source_type='employee_advance_funding') THEN
    RAISE EXCEPTION 'Employee salary advance can be issued only with a posted funding journal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION check_employee_salary_advance_pending_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bank_id UUID; journal_status TEXT;
BEGIN
  IF OLD.status='pending_posting' AND NEW.status='approved' THEN
    IF current_setting('eqfal.employee_salary_advance_cancel',true) IS DISTINCT FROM OLD.id::text
      OR OLD.bank_transaction_match_id IS NULL
      OR EXISTS(SELECT 1 FROM bank_transaction_matches WHERE id=OLD.bank_transaction_match_id AND company_id=OLD.company_id) THEN
      RAISE EXCEPTION 'pending advance cancellation must release its bank match' USING ERRCODE='23514';
    END IF;
    SELECT status INTO journal_status FROM journal_entries WHERE company_id=OLD.company_id AND source_type='employee_advance_funding' AND source_id=OLD.bank_transaction_match_id;
    IF journal_status IS DISTINCT FROM 'voided' THEN RAISE EXCEPTION 'pending advance cancellation must void its draft journal' USING ERRCODE='23514'; END IF;
    SELECT (before_data->>'bank_transaction_id')::uuid INTO bank_id FROM audit_log
      WHERE company_id=OLD.company_id AND entity_type='employee_salary_advance' AND entity_id=OLD.id
        AND action='employee_salary_advance.pending_cancel'
        AND before_data->>'bank_transaction_match_id'=OLD.bank_transaction_match_id::text
      ORDER BY created_at DESC LIMIT 1;
    IF bank_id IS NULL OR NOT EXISTS(SELECT 1 FROM bank_transactions WHERE id=bank_id AND company_id=OLD.company_id AND reconciliation_status='unmatched')
      OR EXISTS(SELECT 1 FROM bank_transaction_matches WHERE bank_transaction_id=bank_id AND company_id=OLD.company_id) THEN
      RAISE EXCEPTION 'pending advance cancellation must atomically audit and release its bank transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER employee_salary_advance_pending_cancel_consistency
  AFTER UPDATE ON employee_salary_advances DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status='pending_posting' AND NEW.status='approved')
  EXECUTE FUNCTION check_employee_salary_advance_pending_cancel();
