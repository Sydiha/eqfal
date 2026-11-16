CREATE FUNCTION has_privileged_financial_authority(company_id uuid, actor_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM users u JOIN companies scope ON scope.id=company_id AND scope.is_active=TRUE
 WHERE u.id=actor_id AND u.is_active=TRUE AND (u.is_system_admin=TRUE OR EXISTS (
 SELECT 1 FROM memberships m JOIN roles r ON r.id=m.role_id AND r.company_id=m.company_id
 WHERE m.user_id=u.id AND m.company_id=scope.id AND m.is_active=TRUE AND r.is_full_access=FALSE
 AND r.authorization_policy_key IN ('company_manager','finance_manager'))));
$$;

CREATE OR REPLACE FUNCTION guard_payroll_recovery_correction() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF OLD.status='pending' AND NEW.status='approved' AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL OR NEW.approval_expires_at IS NULL OR NEW.approval_expires_at<=NEW.approved_at OR NEW.decision_reason IS NULL OR char_length(btrim(NEW.decision_reason))<10 OR (NEW.approved_by=NEW.requested_by AND NOT has_privileged_financial_authority(NEW.company_id,NEW.approved_by))) THEN
   RAISE EXCEPTION 'independent correction approval evidence required' USING ERRCODE='23514'; END IF;
 IF OLD.status='pending' AND NEW.status='rejected' AND (NEW.decision_reason IS NULL OR char_length(btrim(NEW.decision_reason))<10) THEN
   RAISE EXCEPTION 'correction rejection reason required' USING ERRCODE='23514'; END IF;
 IF NEW.status='withdrawn' AND (NEW.ended_by IS NULL OR NEW.ended_at IS NULL OR NEW.end_reason IS NULL OR char_length(btrim(NEW.end_reason))<10) THEN
   RAISE EXCEPTION 'correction withdrawal evidence required' USING ERRCODE='23514'; END IF;
 IF OLD.status='approved' AND NEW.status='expired' AND (clock_timestamp()<OLD.approval_expires_at OR NEW.ended_by IS NULL OR NEW.ended_at IS NULL OR NEW.end_reason IS NULL OR char_length(btrim(NEW.end_reason))<10) THEN
   RAISE EXCEPTION 'correction approval has not expired or expiry evidence is missing' USING ERRCODE='23514'; END IF;
 IF OLD.status='approved' AND NEW.status='posted' AND (NEW.journal_entry_id IS NULL OR NEW.journal_line_id IS NULL OR NEW.posted_by IS NULL OR NEW.posted_at IS NULL OR (NEW.posted_by IN(NEW.requested_by,NEW.approved_by) AND NOT has_privileged_financial_authority(NEW.company_id,NEW.posted_by))) THEN
   RAISE EXCEPTION 'correction posting evidence required' USING ERRCODE='23514'; END IF;
 IF OLD.status='approved' AND NEW.status='posted' AND (OLD.approval_expires_at IS NULL OR OLD.approval_expires_at<=clock_timestamp()) THEN
   RAISE EXCEPTION 'expired recovery correction approval cannot post' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION verify_payroll_recovery_correction_posting() RETURNS trigger LANGUAGE plpgsql AS $$
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
     AND (NEW.posted_by NOT IN(NEW.requested_by,NEW.approved_by) OR has_privileged_financial_authority(NEW.company_id,NEW.posted_by)) AND j.posted_by=NEW.posted_by
     AND (NEW.approved_by<>NEW.posted_by OR has_privileged_financial_authority(NEW.company_id,NEW.posted_by)) AND d.approved_by IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM payroll_draft_contributors pc WHERE pc.company_id=d.company_id AND pc.draft_id=d.id AND ((pc.user_id=NEW.approved_by AND NOT has_privileged_financial_authority(NEW.company_id,NEW.approved_by)) OR (pc.user_id=NEW.posted_by AND NOT has_privileged_financial_authority(NEW.company_id,NEW.posted_by))))
     AND ((d.created_by<>NEW.approved_by OR has_privileged_financial_authority(NEW.company_id,NEW.approved_by)) AND (d.created_by<>NEW.posted_by OR has_privileged_financial_authority(NEW.company_id,NEW.posted_by))) AND ((d.approved_by<>NEW.approved_by OR has_privileged_financial_authority(NEW.company_id,NEW.approved_by)) AND (d.approved_by<>NEW.posted_by OR has_privileged_financial_authority(NEW.company_id,NEW.posted_by))) AND ((pj.posted_by<>NEW.approved_by OR has_privileged_financial_authority(NEW.company_id,NEW.approved_by)) AND (pj.posted_by<>NEW.posted_by OR has_privileged_financial_authority(NEW.company_id,NEW.posted_by)))
     AND NOT EXISTS(SELECT 1 FROM bank_account_ledger_links bl WHERE bl.company_id=aa.company_id AND bl.account_id=aa.id)
     AND (SELECT count(*) FROM journal_lines x WHERE x.company_id=NEW.company_id AND x.journal_entry_id=j.id)=2
     AND dr.memo='employee_salary_advance_recovery_reversal' AND dr.debit=NEW.amount AND dr.credit=0
     AND EXISTS(SELECT 1 FROM journal_lines cr WHERE cr.company_id=j.company_id AND cr.journal_entry_id=j.id AND cr.account_id=pm.account_id AND cr.memo='employee_salary_advance_payroll_liability_reversal' AND cr.credit=NEW.amount AND cr.debit=0)
     AND a.id=(SELECT advance_id FROM payroll_employee_advance_recoveries WHERE id=NEW.recovery_id)) INTO ok;
 IF NOT ok THEN RAISE EXCEPTION 'posted recovery correction does not match reversal journal evidence' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
