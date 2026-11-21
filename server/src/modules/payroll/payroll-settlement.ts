import { createHash, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable, AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { postJournalInTransaction, FiscalYearClosedError, JournalPostingValidationError, JournalPostingConflictError, LedgerSourceAuthorityBlockedError } from '../accounting/journal-posting';
import { resolveBankLedgerAccount } from '../accounting/personal-payment-posting';
import { PAYROLL_SETTLEMENT_EXCEPTION_APPROVER_CAPABILITY } from '../memberships/authorization-policy';
import { hasPrivilegedFinancialAuthority } from '../memberships/privileged-financial-authority';

export class PayrollSettlementError extends Error {
  constructor(readonly code:string, readonly status=409) { super(code); }
}
const conflict=(code:string)=>new PayrollSettlementError(code);
const SETTLEMENT_EXCEPTION_TTL_HOURS = 24;
export function approvedSodExceptionIsUnexpired(status:string,expiresAt:string|null,databaseNow:string):boolean{
  return status==='approved'&&expiresAt!==null&&new Date(expiresAt).getTime()>new Date(databaseNow).getTime();
}
type PayrollSodEvidence = {
  draftId:string; createdBy:string; approvedBy:string; draftVersion:number;
  journalId:string; postedBy:string; liabilityAmount:string; settledAmount:string;
  contributors:string[]; participants:string[]; fingerprint:string;
};
export class PayrollSettlementService {
  private audit=new AuditLogRepository();
  constructor(private db:Pool) {}
  async liabilities(company:string) {
    return (await this.db.query(`SELECT l.id liability_line_id,j.id payroll_journal_id,COALESCE(d.id,od.id) payroll_draft_id,COALESCE(d.period_month,od.period_month)::text period_month,
      l.memo category,l.account_id,l.credit::text original_amount,COALESCE(sum(p.amount),0)::text settled_amount,
      (l.credit-COALESCE(sum(p.amount),0))::text remaining_amount
      FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
      LEFT JOIN payroll_drafts d ON j.source_type='payroll' AND d.id=j.source_id AND d.company_id=j.company_id
      LEFT JOIN payroll_recovery_corrections c ON j.source_type='payroll_recovery_correction' AND c.journal_entry_id=j.id AND c.company_id=j.company_id AND c.status='posted'
      LEFT JOIN payroll_employee_advance_recoveries r ON r.id=c.recovery_id AND r.company_id=c.company_id
      LEFT JOIN payroll_drafts od ON od.id=r.draft_id AND od.company_id=r.company_id
      LEFT JOIN payroll_settlement_allocations p ON p.company_id=l.company_id AND p.liability_line_id=l.id
      WHERE l.company_id=$1 AND j.status='posted' AND (
        (j.source_type='payroll' AND d.status='approved' AND l.memo IN ('net_payroll_liability','employee_deduction_liability','employer_contribution_liability')) OR
        (j.source_type='payroll_recovery_correction' AND c.status='posted' AND od.status='approved' AND l.memo='employee_salary_advance_payroll_liability_reversal'))
        AND l.debit=0 AND l.credit>0
      GROUP BY l.id,j.id,d.id,od.id,l.sequence ORDER BY COALESCE(d.period_month,od.period_month),l.sequence`,[company])).rows;
  }
  async history(company:string) {
    return (await this.db.query(`SELECT p.id,p.bank_transaction_id,p.liability_line_id,p.journal_entry_id,p.amount::text,p.created_at::text,
      l.memo category,COALESCE(d.id,od.id) payroll_draft_id,t.transaction_date::text,t.bank_reference,
      t.reconciliation_status,t.amount::text bank_amount,
      (SELECT COALESCE(SUM(x.amount),0)::text FROM payroll_settlement_allocations x WHERE x.company_id=p.company_id AND x.bank_transaction_id=p.bank_transaction_id) bank_allocated_amount,
      settlement_journal.reference journal_reference
      FROM payroll_settlement_allocations p JOIN journal_lines l ON l.id=p.liability_line_id AND l.company_id=p.company_id
      JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
      LEFT JOIN payroll_drafts d ON j.source_type='payroll' AND d.id=j.source_id AND d.company_id=j.company_id
      LEFT JOIN payroll_recovery_corrections c ON j.source_type='payroll_recovery_correction' AND c.journal_entry_id=j.id AND c.company_id=j.company_id AND c.status='posted'
      LEFT JOIN payroll_employee_advance_recoveries r ON r.id=c.recovery_id AND r.company_id=c.company_id
      LEFT JOIN payroll_drafts od ON od.id=r.draft_id AND od.company_id=r.company_id
      JOIN bank_transactions t ON t.id=p.bank_transaction_id AND t.company_id=p.company_id
      JOIN journal_entries settlement_journal ON settlement_journal.id=p.journal_entry_id AND settlement_journal.company_id=p.company_id AND settlement_journal.status='posted'
      WHERE p.company_id=$1 ORDER BY p.created_at DESC,p.id`,[company])).rows;
  }
  async banks(company:string) {
    return (await this.db.query(`SELECT t.id,t.transaction_date::text,t.amount::text,t.bank_account_id,t.bank_reference,
      COALESCE((SELECT SUM(p.amount) FROM payroll_settlement_allocations p WHERE p.company_id=t.company_id AND p.bank_transaction_id=t.id),0)::text allocated_amount,
      (ABS(t.amount)-COALESCE((SELECT SUM(p.amount) FROM payroll_settlement_allocations p WHERE p.company_id=t.company_id AND p.bank_transaction_id=t.id),0))::text remaining_amount
      FROM bank_transactions t WHERE t.company_id=$1 AND t.amount<0 AND t.currency_code='SAR' AND t.reconciliation_status<>'reconciled'
      AND t.manual_journal_binding_protected
      AND (t.source_kind<>'manual' OR t.manual_category IN ('supplier_payment','government_payment','other'))
      AND EXISTS(SELECT 1 FROM bank_account_ledger_links b JOIN accounts a ON a.id=b.account_id AND a.company_id=b.company_id
        WHERE b.company_id=t.company_id AND b.bank_account_id=t.bank_account_id AND b.valid_from<=t.transaction_date AND (b.valid_to IS NULL OR b.valid_to>=t.transaction_date) AND a.is_active)
      AND NOT EXISTS(SELECT 1 FROM bank_account_ledger_links b
        JOIN journal_lines l ON l.company_id=b.company_id AND l.account_id=b.account_id
        JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
        LEFT JOIN manual_bank_journal_uncertainty_reviews r ON r.company_id=l.company_id AND r.journal_line_id=l.id AND r.bank_account_id=b.bank_account_id
        WHERE b.company_id=t.company_id AND b.bank_account_id=t.bank_account_id AND b.valid_from<=j.accounting_date
          AND (b.valid_to IS NULL OR b.valid_to>=j.accounting_date) AND l.bank_transaction_id IS NULL
          AND j.status='posted' AND j.entry_type='standard' AND j.source_type IS NULL AND j.reversal_of_journal_id IS NULL AND r.id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM bank_transaction_matches m WHERE m.company_id=t.company_id AND m.bank_transaction_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM document_settlements s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM obligation_settlements s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM employee_cost_payment_allocations s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM personal_payment_reimbursements s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM partner_transactions s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
      ORDER BY t.transaction_date DESC,t.id`,[company])).rows;
  }

  /** Lock and validate the persisted payroll chain before relying on it for SoD. */
  private async sodEvidence(c:import('pg').PoolClient,company:string,lineId:string):Promise<PayrollSodEvidence>{
    const draft=(await c.query<{id:string;created_by:string;approved_by:string|null;status:string;version:number;source_type:string;correction_id:string|null}>(`SELECT d.id,d.created_by,d.approved_by,d.status,d.version,j.source_type,c.id correction_id
      FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
      LEFT JOIN payroll_recovery_corrections c ON j.source_type='payroll_recovery_correction' AND c.journal_entry_id=j.id AND c.company_id=j.company_id AND c.status='posted'
      LEFT JOIN payroll_employee_advance_recoveries r ON r.id=c.recovery_id AND r.company_id=c.company_id
      JOIN payroll_drafts d ON d.company_id=j.company_id AND ((j.source_type='payroll' AND d.id=j.source_id) OR (j.source_type='payroll_recovery_correction' AND d.id=r.draft_id))
      WHERE d.company_id=$1 AND l.id=$2 FOR UPDATE OF d`,[company,lineId])).rows[0];
    const approvedBy=draft?.approved_by;
    if(!draft||draft.status!=='approved'||!approvedBy)throw conflict('PAYROLL_SETTLEMENT_SOD_EVIDENCE_INVALID');
    const journal=(await c.query<{id:string;status:string;posted_by:string|null}>(`SELECT j.id,j.status,j.posted_by FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id AND l.company_id=j.company_id
      WHERE j.company_id=$1 AND l.id=$2 AND ((j.source_type='payroll' AND j.source_id=$3) OR (j.source_type='payroll_recovery_correction' AND EXISTS(SELECT 1 FROM payroll_recovery_corrections c WHERE c.company_id=j.company_id AND c.journal_entry_id=j.id AND c.id=$4 AND c.status='posted'))) FOR UPDATE OF j`,[company,lineId,draft.id,draft.correction_id])).rows[0];
    if(!journal||journal.status!=='posted')throw conflict('PAYROLL_SETTLEMENT_SOD_EVIDENCE_INVALID');
    const postedBy=journal.posted_by;
    if(!postedBy)throw conflict('PAYROLL_SETTLEMENT_SOD_EVIDENCE_INVALID');
    const liability=(await c.query<{credit:string;debit:string;memo:string|null}>(`SELECT credit::text,debit::text,memo FROM journal_lines
      WHERE id=$1 AND company_id=$2 AND journal_entry_id=$3 FOR UPDATE`,[lineId,company,journal.id])).rows[0];
    if(!liability||liability.debit!=='0.00'||Number(liability.credit)<=0||!(['net_payroll_liability','employee_deduction_liability','employer_contribution_liability'].includes(liability.memo??'')||(draft.source_type==='payroll_recovery_correction'&&liability.memo==='employee_salary_advance_payroll_liability_reversal')))throw conflict('PAYROLL_SETTLEMENT_SOD_EVIDENCE_INVALID');
    const contributors=(await c.query<{user_id:string}>('SELECT user_id FROM payroll_draft_contributors WHERE company_id=$1 AND draft_id=$2 ORDER BY user_id FOR SHARE',[company,draft.id])).rows.map(row=>row.user_id);
    if(!contributors.length||!contributors.includes(draft.created_by))throw conflict('PAYROLL_SETTLEMENT_SOD_EVIDENCE_INVALID');
    const settled=(await c.query<{amount:string}>('SELECT COALESCE(SUM(amount),0)::numeric(18,2)::text amount FROM payroll_settlement_allocations WHERE company_id=$1 AND liability_line_id=$2',[company,lineId])).rows[0]!.amount;
    const correctionPeople=draft.correction_id?(await c.query<{requested_by:string;approved_by:string|null;posted_by:string|null}>(`SELECT requested_by,approved_by,posted_by FROM payroll_recovery_corrections WHERE id=$1 AND company_id=$2 AND status='posted'`,[draft.correction_id,company])).rows[0]:undefined;
    const participants=[...new Set([...contributors,approvedBy,postedBy,...(correctionPeople?[correctionPeople.requested_by,correctionPeople.approved_by,correctionPeople.posted_by].filter((x):x is string=>!!x):[])])].sort();
    const snapshot={company,draft:draft.id,draftVersion:draft.version,journal:journal.id,approvedBy,postedBy,sourceType:draft.source_type,correctionId:draft.correction_id,
      contributors:[...contributors].sort(),liabilityLine:lineId,liabilityAmount:liability.credit,settledAmount:settled};
    const fingerprint=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    return {draftId:draft.id,createdBy:draft.created_by,approvedBy,draftVersion:draft.version,journalId:journal.id,postedBy,
      liabilityAmount:liability.credit,settledAmount:settled,contributors,participants,fingerprint};
  }

  async requestSodException(company:string,actor:string,lineId:string,reason:string){
    const c=await this.db.connect();
    try{
      await c.query('BEGIN');
      if(await hasPrivilegedFinancialAuthority(c,company,actor))throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_NOT_REQUIRED');
      const evidence=await this.sodEvidence(c,company,lineId);
      if(!evidence.participants.includes(actor))throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_NOT_REQUIRED');
      const approved=(await c.query<{id:string;requested_at:string}>(`SELECT id,requested_at::text FROM payroll_settlement_sod_exceptions
        WHERE company_id=$1 AND liability_line_id=$2 AND intended_actor_id=$3 AND status='approved'
          AND approval_expires_at>clock_timestamp() AND participant_fingerprint=$4 AND payroll_journal_id=$5
          AND liability_amount=$6::numeric AND settled_amount=$7::numeric ORDER BY requested_at DESC LIMIT 1`,
        [company,lineId,actor,evidence.fingerprint,evidence.journalId,evidence.liabilityAmount,evidence.settledAmount])).rows[0];
      if(approved){await c.query('COMMIT');return {id:approved.id,status:'approved',requested_at:approved.requested_at,existing:true};}
      const exception=(await c.query<{id:string;requested_at:string}>(`INSERT INTO payroll_settlement_sod_exceptions
        (company_id,payroll_draft_id,liability_line_id,intended_actor_id,requested_by,request_reason,participant_fingerprint,payroll_journal_id,liability_amount,settled_amount)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9) RETURNING id,requested_at::text`,
        [company,evidence.draftId,lineId,actor,reason.trim(),evidence.fingerprint,evidence.journalId,evidence.liabilityAmount,evidence.settledAmount])).rows[0]!;
      await this.audit.logEvent({company_id:company,actor_user_id:actor,action:'payroll.settlement.sod_exception.request',entity_type:'payroll_settlement_sod_exception',entity_id:exception.id,
        after_data:{payroll_draft_id:evidence.draftId,liability_line_id:lineId,intended_actor_id:actor,requested_at:exception.requested_at},reason:reason.trim()},c);
      await c.query('COMMIT');return {id:exception.id,status:'pending',requested_at:exception.requested_at,existing:false};
    }catch(e){await c.query('ROLLBACK');if(e instanceof PayrollSettlementError)throw e;if((e as{code?:string}).code==='23505')throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_EXISTS');throw e;}finally{c.release();}
  }

  private async hasExplicitExceptionApproval(c:import('pg').PoolClient,company:string,actor:string):Promise<boolean>{
    if(await hasPrivilegedFinancialAuthority(c,company,actor))return true;
    return (await c.query<{allowed:boolean}>(`SELECT EXISTS(SELECT 1 FROM users u JOIN memberships m ON m.user_id=u.id AND m.company_id=$1 AND m.is_active
      JOIN roles r ON r.id=m.role_id AND r.company_id=m.company_id AND NOT r.is_full_access
      JOIN role_capabilities rc ON rc.role_id=r.id AND rc.capability_id=$3
      WHERE u.id=$2 AND u.is_active AND NOT u.is_system_admin) allowed`,[company,actor,PAYROLL_SETTLEMENT_EXCEPTION_APPROVER_CAPABILITY])).rows[0]!.allowed;
  }

  async decideSodException(company:string,actor:string,exceptionId:string,decision:'approve'|'reject',reason:string){
    const c=await this.db.connect();
    try{
      await c.query('BEGIN');
      const row=(await c.query<{id:string;payroll_draft_id:string;liability_line_id:string;intended_actor_id:string;status:string;participant_fingerprint:string}>(`SELECT id,payroll_draft_id,liability_line_id,intended_actor_id,status,participant_fingerprint
        FROM payroll_settlement_sod_exceptions WHERE id=$1 AND company_id=$2 FOR UPDATE`,[exceptionId,company])).rows[0];
      if(!row)throw new PayrollSettlementError('PAYROLL_SETTLEMENT_SOD_EXCEPTION_NOT_FOUND',404);
      if(!await this.hasExplicitExceptionApproval(c,company,actor))throw new PayrollSettlementError('PAYROLL_SETTLEMENT_SOD_EXCEPTION_FORBIDDEN',403);
      if(row.status!=='pending')throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_NOT_PENDING');
      const evidence=await this.sodEvidence(c,company,row.liability_line_id);
      if(evidence.draftId!==row.payroll_draft_id||evidence.fingerprint!==row.participant_fingerprint)throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_STALE');
      if(actor===row.intended_actor_id||evidence.participants.includes(actor))throw new PayrollSettlementError('PAYROLL_SETTLEMENT_SOD_EXCEPTION_CONFLICTED_APPROVER',403);
      const status=decision==='approve'?'approved':'rejected';
      const saved=(await c.query<{approval_expires_at:string|null}>(`WITH decision_time AS (SELECT clock_timestamp() AS approved_at)
        UPDATE payroll_settlement_sod_exceptions e SET status=$3,decided_by=$4,decided_at=decision_time.approved_at,decision_reason=$5,
          approval_expires_at=CASE WHEN $3='approved' THEN decision_time.approved_at+($6::text||' hours')::interval ELSE NULL END
        FROM decision_time WHERE e.id=$1 AND e.company_id=$2 RETURNING e.approval_expires_at::text`,[exceptionId,company,status,actor,reason.trim(),SETTLEMENT_EXCEPTION_TTL_HOURS])).rows[0]!;
      await this.audit.logEvent({company_id:company,actor_user_id:actor,action:`payroll.settlement.sod_exception.${decision}`,entity_type:'payroll_settlement_sod_exception',entity_id:exceptionId,
        after_data:{payroll_draft_id:evidence.draftId,liability_line_id:row.liability_line_id,intended_actor_id:row.intended_actor_id,approval_expires_at:saved.approval_expires_at},reason:reason.trim()},c);
      await c.query('COMMIT');return {id:exceptionId,status,approval_expires_at:saved.approval_expires_at};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }

  async listSodExceptions(company:string,actor:string){
    const c=await this.db.connect();
    try{
      const canApprove=await this.hasExplicitExceptionApproval(c,company,actor);
      return (await c.query(`SELECT id,payroll_draft_id,liability_line_id,intended_actor_id,request_reason,requested_at::text,status,approval_expires_at::text,
          (intended_actor_id=$2) AS intended_for_current_user
        FROM payroll_settlement_sod_exceptions WHERE company_id=$1 AND (requested_by=$2 OR ($3 AND status='pending')) ORDER BY requested_at,id`,[company,actor,canApprove])).rows;
    }finally{c.release();}
  }
  async create(company:string, actor:string, input:{bankTransactionId:string;liabilityLineId:string;amount:string;idempotencyKey:string;sodExceptionId?:string; canSettleBonus?:boolean}) {
    const c=await this.db.connect();
    try {
      await c.query('BEGIN');
      const bonus = (await c.query<{ verified_by: string; approved_by: string; created_by: string }>(`
        SELECT r.verified_by,e.approved_by,e.created_by FROM journal_lines l
        JOIN employee_bonus_recognitions r ON r.company_id=l.company_id AND r.journal_id=l.journal_entry_id
          AND r.liability_account_id=l.account_id
        JOIN employee_bonus_entitlements e ON e.company_id=r.company_id AND e.id=r.entitlement_id
        WHERE l.company_id=$1 AND l.id=$2 AND l.credit>0
      `, [company,input.liabilityLineId])).rows[0];
      if (bonus && !input.canSettleBonus) throw new PayrollSettlementError('FORBIDDEN',403);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`payroll-settlement:${company}:${input.idempotencyKey}`]);
      const existing=(await c.query<{id:string;bank_transaction_id:string;liability_line_id:string;amount:string;journal_entry_id:string;created_by:string;sod_exception_id:string|null}>(
        'SELECT id,bank_transaction_id,liability_line_id,amount::text,journal_entry_id,created_by,sod_exception_id FROM payroll_settlement_allocations WHERE company_id=$1 AND idempotency_key=$2',[company,input.idempotencyKey])).rows[0];
      if(existing) {
        const same=(await c.query<{same:boolean}>('SELECT $1::numeric=$2::numeric same',[existing.amount,input.amount])).rows[0]!.same;
        if(!same||existing.bank_transaction_id!==input.bankTransactionId||existing.liability_line_id!==input.liabilityLineId
          ||existing.created_by!==actor||existing.sod_exception_id!==(input.sodExceptionId??null)) throw conflict('PAYROLL_SETTLEMENT_IDEMPOTENCY_CONFLICT');
        await c.query('COMMIT');return {allocation:existing,existing:true};
      }
      // Read the bank date first so fiscal-year/month locks follow the canonical
      // journal order (year, accounting period, then bank row). Re-read and lock
      // the transaction after the period guard before making eligibility decisions.
      const bankDate=(await c.query<{transaction_date:string}>(
        'SELECT transaction_date::text FROM bank_transactions WHERE company_id=$1 AND id=$2',[company,input.bankTransactionId])).rows[0]?.transaction_date;
      if(!bankDate) throw new PayrollSettlementError('PAYROLL_SETTLEMENT_NOT_FOUND',404);
      const year=(await c.query<{id:string}>("SELECT id FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date AND status='open' FOR SHARE",[company,bankDate])).rows;
      if(year.length!==1) throw conflict('PAYROLL_SETTLEMENT_PERIOD_INELIGIBLE');
      await assertAccountingDateWritable(company,bankDate,c);
      const bank=(await c.query<{id:string;bank_account_id:string;amount:string;transaction_date:string;currency_code:string;reconciliation_status:string;source_kind:string;manual_category:string|null;manual_journal_binding_protected:boolean}>(
        'SELECT id,bank_account_id,amount::text,transaction_date::text,currency_code,reconciliation_status,source_kind,manual_category,manual_journal_binding_protected FROM bank_transactions WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,input.bankTransactionId])).rows[0];
      if(!bank) throw new PayrollSettlementError('PAYROLL_SETTLEMENT_NOT_FOUND',404);
      if(bank.transaction_date!==bankDate) throw conflict('PAYROLL_SETTLEMENT_BANK_INELIGIBLE');
      if(!bank.manual_journal_binding_protected||!bank.amount.startsWith('-')||bank.reconciliation_status==='reconciled'||bank.currency_code.trim()!=='SAR'||(bank.source_kind==='manual'&&!['supplier_payment','government_payment','other'].includes(bank.manual_category??''))) throw conflict('PAYROLL_SETTLEMENT_BANK_INELIGIBLE');
      await c.query('SELECT id FROM bank_accounts WHERE id=$1 AND company_id=$2 FOR UPDATE',[bank.bank_account_id,company]);
      const uncertain=(await c.query<{yes:boolean}>(`SELECT EXISTS(
        SELECT 1 FROM bank_account_ledger_links b
        JOIN journal_lines l ON l.company_id=b.company_id AND l.account_id=b.account_id
        JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
        LEFT JOIN manual_bank_journal_uncertainty_reviews r
          ON r.company_id=l.company_id AND r.journal_line_id=l.id AND r.bank_account_id=b.bank_account_id
        WHERE b.company_id=$1 AND b.bank_account_id=$2 AND b.valid_from<=j.accounting_date
          AND (b.valid_to IS NULL OR b.valid_to>=j.accounting_date) AND l.bank_transaction_id IS NULL
          AND j.status='posted' AND j.entry_type='standard' AND j.source_type IS NULL
          AND j.reversal_of_journal_id IS NULL AND r.id IS NULL
      ) yes`,[company,bank.bank_account_id])).rows[0]!.yes;
      if(uncertain) throw conflict('PAYROLL_SETTLEMENT_BANK_ACCOUNT_QUARANTINED');
      const privileged=await hasPrivilegedFinancialAuthority(c,company,actor);
      if(privileged&&input.sodExceptionId)throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_INVALID');
      let sodException:{id:string;intended_actor_id:string;status:string;participant_fingerprint:string;payroll_draft_id:string;liability_line_id:string;payroll_journal_id:string;liability_amount:string;settled_amount:string;decided_by:string|null;approval_expires_at:string|null;database_now:string}|undefined;
      if(input.sodExceptionId){
        sodException=(await c.query(`SELECT id,intended_actor_id,status,participant_fingerprint,payroll_draft_id,liability_line_id,payroll_journal_id,
          liability_amount::text,settled_amount::text,decided_by,approval_expires_at::text,clock_timestamp()::text AS database_now FROM payroll_settlement_sod_exceptions WHERE id=$1 AND company_id=$2 FOR UPDATE`,[input.sodExceptionId,company])).rows[0];
        if(!sodException)throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_INVALID');
      }
      if (bonus && input.sodExceptionId) throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_INVALID');
      const evidence=bonus ? null : await this.sodEvidence(c,company,input.liabilityLineId);
      const conflicted=bonus ? [bonus.verified_by,bonus.approved_by,bonus.created_by].includes(actor) : evidence!.participants.includes(actor);
      if(input.sodExceptionId){
        if(!evidence||!sodException||!conflicted||sodException.intended_actor_id!==actor||sodException.payroll_draft_id!==evidence.draftId||sodException.liability_line_id!==input.liabilityLineId)throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_INVALID');
        if(!approvedSodExceptionIsUnexpired(sodException.status,sodException.approval_expires_at,sodException.database_now))throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_EXPIRED');
        if(sodException.participant_fingerprint!==evidence.fingerprint||sodException.payroll_journal_id!==evidence.journalId||sodException.liability_amount!==evidence.liabilityAmount||sodException.settled_amount!==evidence.settledAmount)throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_STALE');
        if(!sodException.decided_by||sodException.decided_by===actor||evidence.participants.includes(sodException.decided_by))throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_CONFLICTED_APPROVER');
      }else if(conflicted&&!privileged)throw conflict('PAYROLL_SETTLEMENT_SOD_REQUIRED');
      const liability=(await c.query<{account_id:string;period_month:string;currency_code:string}>(`SELECT l.account_id,CASE WHEN d.id IS NOT NULL THEN j.accounting_date::text ELSE COALESCE(od.period_month,br.accounting_date)::text END period_month,COALESCE(d.currency_code,od.currency_code,'SAR') currency_code FROM journal_lines l
        JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
        LEFT JOIN payroll_drafts d ON j.source_type='payroll' AND d.id=j.source_id AND d.company_id=j.company_id
        LEFT JOIN payroll_recovery_corrections rc ON j.source_type='payroll_recovery_correction' AND rc.journal_entry_id=j.id AND rc.company_id=j.company_id AND rc.status='posted'
        LEFT JOIN payroll_employee_advance_recoveries r ON r.id=rc.recovery_id AND r.company_id=rc.company_id
        LEFT JOIN payroll_drafts od ON od.id=r.draft_id AND od.company_id=r.company_id
        LEFT JOIN employee_bonus_recognitions br ON br.company_id=l.company_id AND br.journal_id=j.id AND br.liability_account_id=l.account_id
        WHERE l.company_id=$1 AND l.id=$2 AND j.status='posted' AND l.debit=0 AND l.credit>0 AND (
          (j.source_type='employee_bonus_recognition' AND br.entitlement_id IS NOT NULL) OR
          (j.source_type='payroll' AND d.status='approved' AND l.memo IN ('net_payroll_liability','employee_deduction_liability','employer_contribution_liability')) OR
          (j.source_type='payroll_recovery_correction' AND rc.status='posted' AND od.status='approved' AND l.memo='employee_salary_advance_payroll_liability_reversal')) FOR UPDATE OF l`,[company,input.liabilityLineId])).rows[0];
      if(!liability) throw new PayrollSettlementError('PAYROLL_SETTLEMENT_NOT_FOUND',404);
      if(bank.transaction_date<liability.period_month||bank.currency_code.trim()!==liability.currency_code.trim()) throw conflict('PAYROLL_SETTLEMENT_BANK_INELIGIBLE');
      const account=await resolveBankLedgerAccount(c,company,bank.bank_account_id,bank.transaction_date,true);
      if(!account||account===liability.account_id) throw conflict('PAYROLL_SETTLEMENT_BANK_UNLINKED');
      // All recognized bank-linked sources must be absent, except our own
      // already-posted allocations whose amounts are bounded by migration 119.
      const claimed=(await c.query<{yes:boolean}>(`SELECT EXISTS(
        SELECT 1 FROM document_settlements WHERE company_id=$1 AND bank_transaction_id=$2
        UNION ALL SELECT 1 FROM obligation_settlements WHERE company_id=$1 AND bank_transaction_id=$2
        UNION ALL SELECT 1 FROM bank_transaction_matches WHERE company_id=$1 AND bank_transaction_id=$2
        UNION ALL SELECT 1 FROM employee_cost_payment_allocations WHERE company_id=$1 AND bank_transaction_id=$2
        UNION ALL SELECT 1 FROM personal_payment_reimbursements WHERE company_id=$1 AND bank_transaction_id=$2
        UNION ALL SELECT 1 FROM partner_transactions WHERE company_id=$1 AND bank_transaction_id=$2
        UNION ALL SELECT 1 FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
          WHERE l.company_id=$1 AND l.bank_transaction_id=$2 AND j.status='posted'
      ) yes`,[company,bank.id])).rows[0]!.yes;
      if(claimed) throw conflict('PAYROLL_SETTLEMENT_BANK_CLAIMED');
      const id=randomUUID(), journal=randomUUID();
      await c.query(`INSERT INTO journal_entries(id,company_id,fiscal_year_id,accounting_date,description,source_type,source_id,created_by)
        VALUES($1,$2,$3,$4,'Payroll liability settlement','payroll_settlement',$5,$6)`,[journal,company,year[0]!.id,bank.transaction_date,id,actor]);
      await c.query(`INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence)
        VALUES($1,$2,$3,$5,0,1),($1,$2,$4,0,$5,2)`,[company,journal,liability.account_id,account,input.amount]);
      const allocation=(await c.query(`INSERT INTO payroll_settlement_allocations(id,company_id,bank_transaction_id,liability_line_id,journal_entry_id,amount,idempotency_key,created_by,sod_exception_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,bank_transaction_id,liability_line_id,journal_entry_id,amount::text,sod_exception_id`,[id,company,bank.id,input.liabilityLineId,journal,input.amount,input.idempotencyKey,actor,sodException?.id??null])).rows[0];
      if(sodException){
        const consumed=await c.query("UPDATE payroll_settlement_sod_exceptions SET status='consumed',consumed_at=clock_timestamp(),settlement_id=$3 WHERE id=$1 AND company_id=$2 AND status='approved' AND approval_expires_at>clock_timestamp()",[sodException.id,company,id]);
        if(consumed.rowCount!==1)throw conflict('PAYROLL_SETTLEMENT_SOD_EXCEPTION_EXPIRED');
      }
      await postJournalInTransaction(c,company,actor,journal,{payrollSettlementId:id});
      if(bank.reconciliation_status==='unmatched') await c.query("UPDATE bank_transactions SET reconciliation_status='matched',reconciled_by_user_id=NULL,reconciled_at=NULL WHERE id=$1 AND company_id=$2",[bank.id,company]);
      await this.audit.logEvent({company_id:company,actor_user_id:actor,action:'payroll.settlement.create',entity_type:'payroll_settlement',entity_id:id,after_data:{...allocation,sod_exception_id:sodException?.id??null}},c);
      await c.query('COMMIT');return {allocation,existing:false};
    } catch(e) {
      await c.query('ROLLBACK');
      if(e instanceof PayrollSettlementError) throw e;
      if(e instanceof AccountingPeriodClosedError||e instanceof FiscalYearClosedError||e instanceof JournalPostingValidationError||e instanceof JournalPostingConflictError||e instanceof LedgerSourceAuthorityBlockedError) throw conflict('PAYROLL_SETTLEMENT_POST_BLOCKED');
      if(['23503','23505','23514'].includes((e as {code?:string}).code??'')) throw conflict('PAYROLL_SETTLEMENT_CONFLICT');
      throw e;
    } finally {c.release();}
  }
}
