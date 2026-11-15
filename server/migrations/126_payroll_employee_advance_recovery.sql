INSERT INTO capabilities(id,implicit_full_access) VALUES
 ('payroll.employee_advance_recovery.view',FALSE),('payroll.employee_advance_recovery.select',FALSE),('payroll.employee_advance_recovery.configure',FALSE),
 ('payroll.employee_advance_recovery.correct',FALSE),('payroll.employee_advance_recovery.correct.approve',FALSE)
ON CONFLICT(id) DO UPDATE SET implicit_full_access=FALSE;
ALTER TABLE payroll_drafts DROP CONSTRAINT payroll_drafts_status_check;
ALTER TABLE payroll_drafts ADD CONSTRAINT payroll_drafts_status_check CHECK(status IN('draft','approved','cancelled','invalidated'));
ALTER TABLE payroll_drafts ADD COLUMN lifecycle_reason TEXT;
ALTER TABLE payroll_drafts DROP CONSTRAINT payroll_approval_fields_check;
ALTER TABLE payroll_drafts ADD CONSTRAINT payroll_approval_fields_check CHECK(
 (status='draft' AND approved_by IS NULL AND approved_at IS NULL) OR
 (status='approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR
 (status IN('cancelled','invalidated') AND lifecycle_reason IS NOT NULL));

CREATE TABLE payroll_recovery_settings(company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
 lease_days INTEGER NOT NULL DEFAULT 30 CHECK(lease_days BETWEEN 1 AND 90), correction_approval_days INTEGER NOT NULL DEFAULT 30 CHECK(correction_approval_days BETWEEN 1 AND 90),
 updated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE payroll_employee_advance_recoveries(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),company_id UUID NOT NULL,draft_id UUID NOT NULL,employee_id UUID NOT NULL,advance_id UUID NOT NULL,
 amount NUMERIC(18,2) NOT NULL CHECK(amount>0),status TEXT NOT NULL CHECK(status IN('selected','reserved','posted','released','expired')),
 expires_at TIMESTAMPTZ,reserved_at TIMESTAMPTZ,ended_at TIMESTAMPTZ,end_reason TEXT,
 journal_entry_id UUID,journal_line_id UUID,created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(id,company_id),FOREIGN KEY(draft_id,company_id) REFERENCES payroll_drafts(id,company_id) ON DELETE RESTRICT,
 FOREIGN KEY(employee_id,company_id) REFERENCES employees(id,company_id) ON DELETE RESTRICT,
 FOREIGN KEY(advance_id,company_id) REFERENCES employee_salary_advances(id,company_id) ON DELETE RESTRICT,
 FOREIGN KEY(journal_entry_id,company_id) REFERENCES journal_entries(id,company_id) ON DELETE RESTRICT,
 FOREIGN KEY(journal_line_id,company_id) REFERENCES journal_lines(id,company_id) ON DELETE RESTRICT,
 CHECK((status='selected' AND expires_at IS NULL AND journal_entry_id IS NULL) OR
 (status='reserved' AND expires_at>reserved_at AND reserved_at IS NOT NULL AND journal_entry_id IS NULL AND ended_at IS NULL) OR
 (status='posted' AND expires_at IS NULL AND journal_entry_id IS NOT NULL AND journal_line_id IS NOT NULL AND ended_at IS NULL) OR
 (status IN('released','expired') AND ended_at IS NOT NULL AND journal_entry_id IS NULL)));
CREATE INDEX payroll_recovery_advance_idx ON payroll_employee_advance_recoveries(company_id,advance_id,status,expires_at);
CREATE UNIQUE INDEX payroll_recovery_active_uidx ON payroll_employee_advance_recoveries(company_id,draft_id,employee_id,advance_id) WHERE status IN('selected','reserved');

CREATE TABLE payroll_recovery_corrections(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),company_id UUID NOT NULL,recovery_id UUID NOT NULL,amount NUMERIC(18,2) NOT NULL CHECK(amount>0),
 reason TEXT NOT NULL CHECK(char_length(btrim(reason)) BETWEEN 10 AND 1000),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','posted','rejected','withdrawn','expired')),
 idempotency_key UUID NOT NULL DEFAULT gen_random_uuid(),
 requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
 posted_by UUID REFERENCES users(id) ON DELETE RESTRICT, decision_reason TEXT,
 accounting_date DATE,journal_entry_id UUID,journal_line_id UUID,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),approved_at TIMESTAMPTZ,approval_expires_at TIMESTAMPTZ,posted_at TIMESTAMPTZ,
 ended_by UUID REFERENCES users(id) ON DELETE RESTRICT,ended_at TIMESTAMPTZ,end_reason TEXT,
 UNIQUE(company_id,requested_by,idempotency_key),
 FOREIGN KEY(recovery_id,company_id) REFERENCES payroll_employee_advance_recoveries(id,company_id) ON DELETE RESTRICT,
 FOREIGN KEY(journal_entry_id,company_id) REFERENCES journal_entries(id,company_id) ON DELETE RESTRICT,
 FOREIGN KEY(journal_line_id,company_id) REFERENCES journal_lines(id,company_id) ON DELETE RESTRICT,
 CHECK((status='pending' AND approved_by IS NULL AND approved_at IS NULL AND approval_expires_at IS NULL AND decision_reason IS NULL AND posted_by IS NULL AND posted_at IS NULL AND journal_entry_id IS NULL AND journal_line_id IS NULL AND ended_by IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (status='approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_expires_at>approved_at AND posted_by IS NULL AND posted_at IS NULL AND journal_entry_id IS NULL AND journal_line_id IS NULL AND ended_by IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (status='posted' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_expires_at IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL AND journal_entry_id IS NOT NULL AND journal_line_id IS NOT NULL AND ended_by IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (status='rejected' AND approved_by IS NULL AND approved_at IS NULL AND approval_expires_at IS NULL AND decision_reason IS NOT NULL AND posted_by IS NULL AND posted_at IS NULL AND journal_entry_id IS NULL AND journal_line_id IS NULL AND ended_by IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (status='withdrawn' AND ((approved_by IS NULL AND approved_at IS NULL AND approval_expires_at IS NULL AND decision_reason IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_expires_at IS NOT NULL)) AND posted_by IS NULL AND posted_at IS NULL AND journal_entry_id IS NULL AND journal_line_id IS NULL AND ended_by IS NOT NULL AND ended_at IS NOT NULL AND char_length(btrim(end_reason))>=10)
    OR (status='expired' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_expires_at IS NOT NULL AND decision_reason IS NOT NULL AND posted_by IS NULL AND posted_at IS NULL AND journal_entry_id IS NULL AND journal_line_id IS NULL AND ended_by IS NOT NULL AND ended_at IS NOT NULL AND char_length(btrim(end_reason))>=10)));

CREATE FUNCTION guard_payroll_recovery_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN IF NEW.status='posted' THEN RAISE EXCEPTION 'payroll recovery can only post from an approved reservation' USING ERRCODE='23514'; END IF; RETURN NEW; END IF;
 IF TG_OP='DELETE' OR OLD.status IN('posted','released','expired') THEN RAISE EXCEPTION 'payroll recovery history is immutable' USING ERRCODE='55000'; END IF;
 IF (NEW.id,NEW.company_id,NEW.draft_id,NEW.employee_id,NEW.advance_id,NEW.amount,NEW.created_by,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.company_id,OLD.draft_id,OLD.employee_id,OLD.advance_id,OLD.amount,OLD.created_by,OLD.created_at)
 OR NOT ((OLD.status='selected' AND NEW.status IN('reserved','released')) OR (OLD.status='reserved' AND NEW.status IN('posted','released','expired'))) THEN
   RAISE EXCEPTION 'invalid or immutable payroll recovery transition' USING ERRCODE='55000'; END IF;
 IF OLD.status='reserved' AND NEW.status='posted' AND (OLD.expires_at IS NULL OR OLD.expires_at<=clock_timestamp()) THEN
   RAISE EXCEPTION 'expired payroll recovery reservation cannot post' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_recovery_history BEFORE INSERT OR UPDATE OR DELETE ON payroll_employee_advance_recoveries FOR EACH ROW EXECUTE FUNCTION guard_payroll_recovery_history();

-- The advance row is the serialization point for every reservation, including
-- reservations created by different payroll periods in concurrent transactions.
CREATE FUNCTION enforce_payroll_recovery_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE principal NUMERIC; used NUMERIC; employee UUID; draft_status TEXT;
BEGIN
 IF NEW.status NOT IN('reserved','selected') THEN RETURN NEW; END IF;
 SELECT status INTO draft_status FROM payroll_drafts WHERE id=NEW.draft_id AND company_id=NEW.company_id FOR UPDATE;
 SELECT amount,employee_id INTO principal,employee FROM employee_salary_advances WHERE id=NEW.advance_id AND company_id=NEW.company_id AND status='issued' FOR UPDATE;
 IF principal IS NULL OR employee<>NEW.employee_id OR (NEW.status='reserved' AND draft_status<>'approved') OR (NEW.status='selected' AND draft_status<>'draft')
   OR NOT EXISTS(SELECT 1 FROM payroll_draft_employees p WHERE p.company_id=NEW.company_id AND p.draft_id=NEW.draft_id AND p.employee_id=NEW.employee_id) THEN
   RAISE EXCEPTION 'payroll recovery ownership or lifecycle invalid' USING ERRCODE='23514'; END IF;
 IF NEW.status='reserved' THEN
   IF NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'payroll recovery reservation must expire in the future' USING ERRCODE='23514'; END IF;
   SELECT COALESCE(sum(amount) FILTER(WHERE status='posted'),0)
     -COALESCE((SELECT sum(c.amount) FROM payroll_recovery_corrections c JOIN payroll_employee_advance_recoveries x ON x.id=c.recovery_id AND x.company_id=c.company_id
       WHERE c.company_id=NEW.company_id AND x.advance_id=NEW.advance_id AND c.status='posted'),0)
     +COALESCE(sum(amount) FILTER(WHERE status='reserved' AND expires_at>clock_timestamp()),0)
     INTO used FROM payroll_employee_advance_recoveries
     WHERE company_id=NEW.company_id AND advance_id=NEW.advance_id AND id IS DISTINCT FROM NEW.id;
   IF used+NEW.amount>principal THEN RAISE EXCEPTION 'employee advance recovery balance exceeded' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_recovery_reservation_guard BEFORE INSERT OR UPDATE OF status,amount,advance_id,employee_id,draft_id ON payroll_employee_advance_recoveries
 FOR EACH ROW EXECUTE FUNCTION enforce_payroll_recovery_reservation();

CREATE FUNCTION verify_payroll_recovery_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok BOOLEAN; rec NUMERIC;
BEGIN
 IF NEW.status<>'posted' THEN RETURN NULL; END IF;
 SELECT COALESCE(sum(amount),0) INTO rec FROM payroll_employee_advance_recoveries
   WHERE company_id=NEW.company_id AND draft_id=NEW.draft_id AND status='posted';
 SELECT EXISTS(SELECT 1 FROM payroll_drafts d JOIN payroll_draft_employees p ON p.company_id=d.company_id AND p.draft_id=d.id
   JOIN employee_salary_advances a ON a.company_id=d.company_id AND a.id=NEW.advance_id AND a.employee_id=p.employee_id AND a.status='issued'
   JOIN journal_entries j ON j.company_id=d.company_id AND j.source_type='payroll' AND j.source_id=d.id AND j.status='posted'
   JOIN journal_lines l ON l.company_id=j.company_id AND l.journal_entry_id=j.id AND l.id=NEW.journal_line_id
   JOIN employee_salary_advance_account_mappings m ON m.company_id=d.company_id AND m.account_id=l.account_id
   JOIN accounts ac ON ac.company_id=m.company_id AND ac.id=m.account_id AND ac.is_active AND ac.account_type='asset' AND ac.statement_category='current_asset'
   WHERE d.company_id=NEW.company_id AND d.id=NEW.draft_id AND d.status='approved' AND p.employee_id=NEW.employee_id
     AND j.id=NEW.journal_entry_id AND j.accounting_date=d.period_month AND l.memo='employee_salary_advance_receivable' AND l.debit=0 AND l.credit=rec
     AND NOT EXISTS(SELECT 1 FROM payroll_employee_advance_recoveries x WHERE x.company_id=d.company_id AND x.draft_id=d.id AND x.status='reserved')) INTO ok;
 IF NOT ok THEN RAISE EXCEPTION 'posted payroll recovery does not match immutable journal evidence' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_recovery_posted_evidence AFTER INSERT OR UPDATE ON payroll_employee_advance_recoveries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status='posted') EXECUTE FUNCTION verify_payroll_recovery_posting();
CREATE FUNCTION guard_payroll_recovery_correction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'recovery correction history is immutable' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.status<>'pending' OR NEW.accounting_date IS NULL OR NEW.approved_by IS NOT NULL OR NEW.approval_expires_at IS NOT NULL OR NEW.posted_by IS NOT NULL OR NEW.journal_entry_id IS NOT NULL OR NEW.journal_line_id IS NOT NULL THEN
     RAISE EXCEPTION 'corrections must be created pending without journal evidence' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF OLD.status IN('posted','rejected','withdrawn','expired') THEN RAISE EXCEPTION 'recovery correction history is immutable' USING ERRCODE='55000'; END IF;
 IF (NEW.id,NEW.company_id,NEW.recovery_id,NEW.amount,NEW.reason,NEW.requested_by,NEW.accounting_date,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.company_id,OLD.recovery_id,OLD.amount,OLD.reason,OLD.requested_by,OLD.accounting_date,OLD.created_at)
 OR NOT ((OLD.status='pending' AND NEW.status IN('pending','approved','rejected','withdrawn')) OR (OLD.status='approved' AND NEW.status IN('approved','posted','withdrawn','expired'))) THEN
   RAISE EXCEPTION 'correction facts are immutable or transition invalid' USING ERRCODE='55000'; END IF;
 IF OLD.status='approved' AND (NEW.approved_by,NEW.approved_at,NEW.approval_expires_at,NEW.decision_reason,NEW.accounting_date) IS DISTINCT FROM
    (OLD.approved_by,OLD.approved_at,OLD.approval_expires_at,OLD.decision_reason,OLD.accounting_date) THEN
   RAISE EXCEPTION 'approved correction evidence is immutable' USING ERRCODE='55000'; END IF;
 IF OLD.status='pending' AND NEW.status='approved' AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL OR NEW.approval_expires_at IS NULL OR NEW.approval_expires_at<=NEW.approved_at OR NEW.decision_reason IS NULL OR char_length(btrim(NEW.decision_reason))<10 OR NEW.approved_by=NEW.requested_by) THEN
   RAISE EXCEPTION 'independent correction approval evidence required' USING ERRCODE='23514'; END IF;
 IF OLD.status='pending' AND NEW.status='rejected' AND (NEW.decision_reason IS NULL OR char_length(btrim(NEW.decision_reason))<10) THEN
   RAISE EXCEPTION 'correction rejection reason required' USING ERRCODE='23514'; END IF;
 IF NEW.status='withdrawn' AND (NEW.ended_by IS NULL OR NEW.ended_at IS NULL OR NEW.end_reason IS NULL OR char_length(btrim(NEW.end_reason))<10) THEN
   RAISE EXCEPTION 'correction withdrawal evidence required' USING ERRCODE='23514'; END IF;
 IF OLD.status='approved' AND NEW.status='expired' AND (clock_timestamp()<OLD.approval_expires_at OR NEW.ended_by IS NULL OR NEW.ended_at IS NULL OR NEW.end_reason IS NULL OR char_length(btrim(NEW.end_reason))<10) THEN
   RAISE EXCEPTION 'correction approval has not expired or expiry evidence is missing' USING ERRCODE='23514'; END IF;
 IF OLD.status='approved' AND NEW.status='posted' AND (NEW.journal_entry_id IS NULL OR NEW.journal_line_id IS NULL OR NEW.posted_by IS NULL OR NEW.posted_at IS NULL OR NEW.posted_by IN(NEW.requested_by,NEW.approved_by)) THEN
   RAISE EXCEPTION 'correction posting evidence required' USING ERRCODE='23514'; END IF;
 IF OLD.status='approved' AND NEW.status='posted' AND (OLD.approval_expires_at IS NULL OR OLD.approval_expires_at<=clock_timestamp()) THEN
   RAISE EXCEPTION 'expired recovery correction approval cannot post' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_recovery_correction BEFORE INSERT OR UPDATE OR DELETE ON payroll_recovery_corrections FOR EACH ROW EXECUTE FUNCTION guard_payroll_recovery_correction();

CREATE FUNCTION verify_payroll_recovery_correction_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok BOOLEAN; reversed NUMERIC;
BEGIN
 IF NEW.status<>'posted' THEN RETURN NULL; END IF;
 SELECT COALESCE(sum(amount),0) INTO reversed FROM payroll_recovery_corrections WHERE company_id=NEW.company_id AND recovery_id=NEW.recovery_id AND status='posted';
 SELECT EXISTS(SELECT 1 FROM payroll_employee_advance_recoveries r
   JOIN employee_salary_advances a ON a.id=r.advance_id AND a.company_id=r.company_id AND a.employee_id=r.employee_id AND a.status='issued'
   JOIN payroll_drafts d ON d.id=r.draft_id AND d.company_id=r.company_id
   JOIN journal_entries j ON j.id=NEW.journal_entry_id AND j.company_id=NEW.company_id AND j.source_type='payroll_recovery_correction' AND j.source_id=NEW.id AND j.status='posted'
   JOIN journal_lines dr ON dr.id=NEW.journal_line_id AND dr.company_id=NEW.company_id AND dr.journal_entry_id=j.id
   JOIN employee_salary_advance_account_mappings am ON am.company_id=NEW.company_id AND am.account_id=dr.account_id
   JOIN accounts aa ON aa.company_id=am.company_id AND aa.id=am.account_id AND aa.is_active AND aa.account_type='asset' AND aa.statement_category='current_asset'
   JOIN payroll_account_mappings pm ON pm.company_id=NEW.company_id AND pm.mapping_key='net_payroll_liability'
   JOIN accounts pa ON pa.company_id=pm.company_id AND pa.id=pm.account_id AND pa.is_active AND pa.account_type='liability'
   JOIN journal_entries pj ON pj.company_id=d.company_id AND pj.source_type='payroll' AND pj.source_id=d.id AND pj.status='posted'
   WHERE r.id=NEW.recovery_id AND r.company_id=NEW.company_id AND r.status='posted' AND d.status='approved'
     AND NEW.amount>0 AND reversed<=r.amount AND j.accounting_date=NEW.accounting_date AND j.accounting_date>=d.period_month
     AND NEW.posted_by NOT IN(NEW.requested_by,NEW.approved_by) AND j.posted_by=NEW.posted_by
     AND NEW.approved_by<>NEW.posted_by AND d.approved_by IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM payroll_draft_contributors pc WHERE pc.company_id=d.company_id AND pc.draft_id=d.id AND pc.user_id IN(NEW.approved_by,NEW.posted_by))
     AND d.created_by NOT IN(NEW.approved_by,NEW.posted_by) AND d.approved_by NOT IN(NEW.approved_by,NEW.posted_by) AND pj.posted_by NOT IN(NEW.approved_by,NEW.posted_by)
     AND NOT EXISTS(SELECT 1 FROM bank_account_ledger_links bl WHERE bl.company_id=aa.company_id AND bl.account_id=aa.id)
     AND (SELECT count(*) FROM journal_lines x WHERE x.company_id=NEW.company_id AND x.journal_entry_id=j.id)=2
     AND dr.memo='employee_salary_advance_recovery_reversal' AND dr.debit=NEW.amount AND dr.credit=0
     AND EXISTS(SELECT 1 FROM journal_lines cr WHERE cr.company_id=j.company_id AND cr.journal_entry_id=j.id AND cr.account_id=pm.account_id AND cr.memo='employee_salary_advance_payroll_liability_reversal' AND cr.credit=NEW.amount AND cr.debit=0)
     AND a.id=(SELECT advance_id FROM payroll_employee_advance_recoveries WHERE id=NEW.recovery_id)) INTO ok;
 IF NOT ok THEN RAISE EXCEPTION 'posted recovery correction does not match reversal journal evidence' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_recovery_correction_evidence AFTER INSERT OR UPDATE ON payroll_recovery_corrections
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status='posted') EXECUTE FUNCTION verify_payroll_recovery_correction_posting();

CREATE FUNCTION guard_payroll_recovery_correction_amount() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original NUMERIC; reversed NUMERIC;
BEGIN
 IF NEW.status NOT IN('approved','posted') THEN RETURN NEW; END IF;
 SELECT amount INTO original FROM payroll_employee_advance_recoveries WHERE id=NEW.recovery_id AND company_id=NEW.company_id AND status='posted' FOR UPDATE;
 IF original IS NULL THEN RAISE EXCEPTION 'only posted recoveries can be corrected' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(amount) FILTER(WHERE status='posted'),0)+COALESCE(sum(amount) FILTER(WHERE status='approved' AND approval_expires_at>clock_timestamp()),0)
   INTO reversed FROM payroll_recovery_corrections WHERE company_id=NEW.company_id AND recovery_id=NEW.recovery_id AND id IS DISTINCT FROM NEW.id;
 IF reversed+NEW.amount>original THEN RAISE EXCEPTION 'recovery correction exceeds unreversed amount' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_recovery_correction_amount BEFORE INSERT OR UPDATE OF status,amount,recovery_id ON payroll_recovery_corrections
 FOR EACH ROW EXECUTE FUNCTION guard_payroll_recovery_correction_amount();

-- Correction-generated payroll liabilities are independently settleable, but
-- retain the same bank ownership, amount caps, and immutable allocation rules.
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
  SELECT l.credit INTO liability_value FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
    LEFT JOIN payroll_drafts d ON j.source_type='payroll' AND d.id=j.source_id AND d.company_id=j.company_id
    LEFT JOIN payroll_recovery_corrections rc ON j.source_type='payroll_recovery_correction' AND rc.journal_entry_id=j.id AND rc.company_id=j.company_id AND rc.status='posted'
    LEFT JOIN payroll_employee_advance_recoveries r ON r.id=rc.recovery_id AND r.company_id=rc.company_id
    LEFT JOIN payroll_drafts od ON od.id=r.draft_id AND od.company_id=r.company_id
    WHERE l.id=NEW.liability_line_id AND l.company_id=NEW.company_id AND j.status='posted' AND l.debit=0 AND l.credit>0 AND
      ((j.source_type='payroll' AND d.status='approved' AND l.memo IN('net_payroll_liability','employee_deduction_liability','employer_contribution_liability')) OR
       (j.source_type='payroll_recovery_correction' AND rc.status='posted' AND od.status='approved' AND l.memo='employee_salary_advance_payroll_liability_reversal')) FOR UPDATE OF l;
  IF NOT FOUND THEN RAISE EXCEPTION 'posted payroll liability not found' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO allocated FROM payroll_settlement_allocations WHERE company_id=NEW.company_id AND liability_line_id=NEW.liability_line_id;
  IF allocated+NEW.amount>liability_value THEN RAISE EXCEPTION 'payroll liability exceeded' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO allocated FROM payroll_settlement_allocations WHERE company_id=NEW.company_id AND bank_transaction_id=NEW.bank_transaction_id;
  IF allocated+NEW.amount>ABS(bank_value) THEN RAISE EXCEPTION 'bank amount exceeded' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
