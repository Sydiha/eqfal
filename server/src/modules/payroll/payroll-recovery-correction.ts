import { hasPrivilegedFinancialAuthority } from '../memberships/privileged-financial-authority';
import { Pool,PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable,AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { postJournalInTransaction,FiscalYearClosedError,JournalPostingValidationError,JournalPostingConflictError,LedgerSourceAuthorityBlockedError } from '../accounting/journal-posting';

export class PayrollRecoveryCorrectionError extends Error {constructor(readonly code:string,readonly status=409){super(code);}}
const conflict=(code:string,status=409)=>new PayrollRecoveryCorrectionError(code,status);
const cents=(v:string)=>{const [w,f='']=v.split('.');return BigInt(w!)*100n+BigInt((f+'00').slice(0,2));};

export class PayrollRecoveryCorrectionService {
 private audit=new AuditLogRepository();
 constructor(private db:Pool){}
 async list(company:string,actor:string){
  return (await this.db.query(`SELECT c.id,c.recovery_id,c.amount::text,c.reason,c.status,c.requested_by,c.approved_by,c.posted_by,
    c.accounting_date::text,c.journal_entry_id,c.journal_line_id,c.created_at::text,c.approved_at::text,c.approval_expires_at::text,c.posted_at::text,
    c.ended_at::text,c.end_reason,(c.status='approved' AND c.approval_expires_at<=clock_timestamp()) approval_expired,
    has_privileged_financial_authority($1,$2) privileged_financial_authority_current_user,
    c.requested_by=$2 requested_by_current_user,c.approved_by=$2 approved_by_current_user,
    EXISTS(SELECT 1 FROM payroll_draft_contributors pc WHERE pc.company_id=d.company_id AND pc.draft_id=d.id AND pc.user_id=$2)
      OR d.created_by=$2 OR d.approved_by=$2 OR EXISTS(SELECT 1 FROM journal_entries pj WHERE pj.company_id=d.company_id AND pj.source_type='payroll' AND pj.source_id=d.id AND pj.status='posted' AND pj.posted_by=$2) payroll_participant_current_user,
    r.employee_id,e.display_name employee_name,e.employee_number,r.advance_id,a.amount::text advance_amount,d.id payroll_draft_id,d.period_month::text,j.reference journal_reference
    FROM payroll_recovery_corrections c JOIN payroll_employee_advance_recoveries r ON r.id=c.recovery_id AND r.company_id=c.company_id
    JOIN employees e ON e.id=r.employee_id AND e.company_id=r.company_id JOIN employee_salary_advances a ON a.id=r.advance_id AND a.company_id=r.company_id
    JOIN payroll_drafts d ON d.id=r.draft_id AND d.company_id=r.company_id LEFT JOIN journal_entries j ON j.id=c.journal_entry_id AND j.company_id=c.company_id
    WHERE c.company_id=$1 ORDER BY c.created_at DESC,c.id`,[company,actor])).rows;
 }
 async recoveries(company:string){
  return (await this.db.query(`SELECT r.id recovery_id,r.amount::text recovery_amount,r.employee_id,e.employee_number,e.display_name,
    r.advance_id,a.amount::text advance_amount,a.issue_date::text,a.currency_code,d.period_month::text payroll_period,
    j.reference payroll_journal_reference,
    COALESCE((SELECT sum(c.amount) FROM payroll_recovery_corrections c WHERE c.company_id=r.company_id AND c.recovery_id=r.id AND c.status='posted'),0)::text reversed_amount,
    (r.amount-COALESCE((SELECT sum(c.amount) FROM payroll_recovery_corrections c WHERE c.company_id=r.company_id AND c.recovery_id=r.id AND c.status='posted'),0))::text remaining_reversible_amount
    FROM payroll_employee_advance_recoveries r JOIN employees e ON e.id=r.employee_id AND e.company_id=r.company_id
    JOIN employee_salary_advances a ON a.id=r.advance_id AND a.company_id=r.company_id
    JOIN payroll_drafts d ON d.id=r.draft_id AND d.company_id=r.company_id JOIN journal_entries j ON j.id=r.journal_entry_id AND j.company_id=r.company_id
    WHERE r.company_id=$1 AND r.status='posted' AND r.amount>COALESCE((SELECT sum(c.amount) FROM payroll_recovery_corrections c WHERE c.company_id=r.company_id AND c.recovery_id=r.id AND c.status='posted'),0)
    ORDER BY d.period_month DESC,e.employee_number,r.created_at`,[company])).rows;
 }
 async settings(company:string){
  return (await this.db.query(`SELECT COALESCE((SELECT lease_days FROM payroll_recovery_settings WHERE company_id=$1),30) lease_days,
    COALESCE((SELECT correction_approval_days FROM payroll_recovery_settings WHERE company_id=$1),30) correction_approval_days`,[company])).rows[0];
 }
 async setSettings(company:string,actor:string,input:{leaseDays:number;correctionApprovalDays:number}){
  const c=await this.db.connect();try{await c.query('BEGIN');const before=await this.settings(company);
   const after=(await c.query(`INSERT INTO payroll_recovery_settings(company_id,lease_days,correction_approval_days,updated_by)
     VALUES($1,$2,$3,$4) ON CONFLICT(company_id) DO UPDATE SET lease_days=EXCLUDED.lease_days,correction_approval_days=EXCLUDED.correction_approval_days,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
     RETURNING lease_days,correction_approval_days`,[company,input.leaseDays,input.correctionApprovalDays,actor])).rows[0];
   await this.audit.logEvent({company_id:company,actor_user_id:actor,action:'payroll.advance_recovery.settings.update',entity_type:'payroll_recovery_settings',entity_id:company,before_data:before,after_data:after},c);
   await c.query('COMMIT');return after;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 private async participants(c:PoolClient,company:string,draftId:string){
  const d=(await c.query<{created_by:string;approved_by:string|null;posted_by:string|null}>(`SELECT d.created_by,d.approved_by,j.posted_by FROM payroll_drafts d JOIN journal_entries j
    ON j.company_id=d.company_id AND j.source_type='payroll' AND j.source_id=d.id AND j.status='posted'
    WHERE d.company_id=$1 AND d.id=$2`,[company,draftId])).rows[0];
  if(!d?.approved_by||!d.posted_by)throw conflict('PAYROLL_RECOVERY_CORRECTION_SOURCE_INVALID');
  const contributors=(await c.query<{user_id:string}>('SELECT user_id FROM payroll_draft_contributors WHERE company_id=$1 AND draft_id=$2',[company,draftId])).rows.map(x=>x.user_id);
  return new Set([d.created_by,d.approved_by,d.posted_by,...contributors]);
 }
 async request(company:string,actor:string,input:{recoveryId:string;amount:string;reason:string;accountingDate:string;idempotencyKey:string}){
  const c=await this.db.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`payroll-recovery-correction:${company}:${actor}:${input.idempotencyKey}`]);
   const prior=(await c.query<{id:string;recovery_id:string;amount:string;reason:string;accounting_date:string;status:string}>('SELECT id,recovery_id,amount::text,reason,accounting_date::text,status FROM payroll_recovery_corrections WHERE company_id=$1 AND requested_by=$2 AND idempotency_key=$3',[company,actor,input.idempotencyKey])).rows[0];
   if(prior){if(prior.recovery_id!==input.recoveryId||cents(prior.amount)!==cents(input.amount)||prior.reason!==input.reason.trim()||prior.accounting_date!==input.accountingDate)throw conflict('PAYROLL_RECOVERY_CORRECTION_IDEMPOTENCY_CONFLICT');await c.query('COMMIT');return{...prior,existing:true};}
   const row=(await c.query<{id:string;company_id:string;amount:string;status:string;draft_id:string}>('SELECT r.id,r.company_id,r.amount::text,r.status,r.draft_id FROM payroll_employee_advance_recoveries r WHERE r.id=$1 AND r.company_id=$2 FOR UPDATE',[input.recoveryId,company])).rows[0];
   if(!row||row.status!=='posted')throw conflict('PAYROLL_RECOVERY_NOT_FOUND',404);
   if(!/^\d{4}-\d{2}-\d{2}$/.test(input.accountingDate))throw conflict('PAYROLL_RECOVERY_CORRECTION_INVALID',400);
   const source=(await c.query<{period_month:string}>('SELECT period_month::text FROM payroll_drafts WHERE id=$1 AND company_id=$2',[row.draft_id,company])).rows[0];if(!source||input.accountingDate<source.period_month)throw conflict('PAYROLL_RECOVERY_CORRECTION_DATE_INVALID',400);
   const reversed=(await c.query<{amount:string}>("SELECT COALESCE(sum(amount),0)::text amount FROM payroll_recovery_corrections WHERE company_id=$1 AND recovery_id=$2 AND status='posted'",[company,row.id])).rows[0]!.amount;
   if(cents(reversed)+cents(input.amount)>cents(row.amount))throw conflict('PAYROLL_RECOVERY_CORRECTION_EXCEEDS_UNREVERSED',409);
   const correction=(await c.query(`INSERT INTO payroll_recovery_corrections(company_id,recovery_id,amount,reason,requested_by,accounting_date,idempotency_key)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status,amount::text,accounting_date::text`,[company,row.id,input.amount,input.reason.trim(),actor,input.accountingDate,input.idempotencyKey])).rows[0]!;
   await this.audit.logEvent({company_id:company,actor_user_id:actor,action:'payroll.advance_recovery.correction.request',entity_type:'payroll_recovery_correction',entity_id:correction.id,after_data:{recovery_id:row.id,amount:input.amount,accounting_date:input.accountingDate,reason:input.reason.trim()}},c);
   await c.query('COMMIT');return{...correction,existing:false};
  }catch(e){await c.query('ROLLBACK');if(e instanceof PayrollRecoveryCorrectionError)throw e;if((e as{code?:string}).code==='23514')throw conflict('PAYROLL_RECOVERY_CORRECTION_EXCEEDS_UNREVERSED');throw e;}finally{c.release();}
 }
 async decide(company:string,actor:string,id:string,decision:'approve'|'reject',reason:string){
  const c=await this.db.connect();try{await c.query('BEGIN');const row=(await c.query<{id:string;recovery_id:string;requested_by:string;status:string;amount:string}>('SELECT id,recovery_id,requested_by,status,amount::text FROM payroll_recovery_corrections WHERE id=$1 AND company_id=$2 FOR UPDATE',[id,company])).rows[0];if(!row)throw conflict('PAYROLL_RECOVERY_CORRECTION_NOT_FOUND',404);if(row.status!=='pending')throw conflict('PAYROLL_RECOVERY_CORRECTION_CONFLICT');if(row.requested_by===actor&&!await hasPrivilegedFinancialAuthority(c,company,actor))throw conflict('PAYROLL_RECOVERY_CORRECTION_SELF_APPROVAL',403);
   const recovery=(await c.query<{amount:string;status:string;draft_id:string}>('SELECT amount::text,status,draft_id FROM payroll_employee_advance_recoveries WHERE id=$1 AND company_id=$2 FOR UPDATE',[row.recovery_id,company])).rows[0];if(!recovery||recovery.status!=='posted')throw conflict('PAYROLL_RECOVERY_NOT_FOUND',404);
   const people=await this.participants(c,company,recovery.draft_id);if(people.has(actor)&&!await hasPrivilegedFinancialAuthority(c,company,actor))throw conflict('PAYROLL_RECOVERY_CORRECTION_CONFLICTED_APPROVER',403);
   let approvalDays=30;
   if(decision==='approve'){
    const setting=await this.settings(company);approvalDays=Number(setting?.correction_approval_days??30);
    const totals=(await c.query<{used:string}>(`SELECT (COALESCE(sum(amount) FILTER(WHERE status='posted'),0)+COALESCE(sum(amount) FILTER(WHERE status='approved' AND approval_expires_at>clock_timestamp()),0))::text used
      FROM payroll_recovery_corrections WHERE company_id=$1 AND recovery_id=$2`,[company,row.recovery_id])).rows[0]!.used;
    if(cents(totals)+cents(row.amount)>cents(recovery.amount))throw conflict('PAYROLL_RECOVERY_CORRECTION_EXCEEDS_UNREVERSED');
   }
   const updated=(await c.query(`UPDATE payroll_recovery_corrections SET status=$3,approved_by=CASE WHEN $3='approved' THEN $4::uuid ELSE NULL END,
     approved_at=CASE WHEN $3='approved' THEN clock_timestamp() ELSE NULL END,
     approval_expires_at=CASE WHEN $3='approved' THEN clock_timestamp()+($6::text||' days')::interval ELSE NULL END,
     decision_reason=$5 WHERE id=$1 AND company_id=$2 RETURNING id,status,approved_by,approved_at::text,approval_expires_at::text`,[id,company,decision==='approve'?'approved':'rejected',actor,reason.trim(),approvalDays])).rows[0]!;
   await this.audit.logEvent({company_id:company,actor_user_id:actor,action:`payroll.advance_recovery.correction.${decision}`,entity_type:'payroll_recovery_correction',entity_id:id,before_data:{status:'pending'},after_data:{status:updated.status,approved_by:updated.approved_by,approval_expires_at:updated.approval_expires_at,reason:reason.trim()}},c);
   await c.query('COMMIT');return updated;
  }catch(e){await c.query('ROLLBACK');if(e instanceof PayrollRecoveryCorrectionError)throw e;if((e as{code?:string}).code==='23514')throw conflict('PAYROLL_RECOVERY_CORRECTION_EXCEEDS_UNREVERSED');throw e;}finally{c.release();}
 }
 async withdraw(company:string,actor:string,id:string,reason:string){
  const c=await this.db.connect();try{await c.query('BEGIN');const row=(await c.query<{status:string;requested_by:string;recovery_id:string}>('SELECT status,requested_by,recovery_id FROM payroll_recovery_corrections WHERE id=$1 AND company_id=$2 FOR UPDATE',[id,company])).rows[0];
   if(!row)throw conflict('PAYROLL_RECOVERY_CORRECTION_NOT_FOUND',404);if(row.requested_by!==actor)throw conflict('PAYROLL_RECOVERY_CORRECTION_WITHDRAW_FORBIDDEN',403);
   if(!['pending','approved'].includes(row.status))throw conflict('PAYROLL_RECOVERY_CORRECTION_NOT_WITHDRAWABLE');
   const result=(await c.query(`UPDATE payroll_recovery_corrections SET status='withdrawn',ended_by=$3,ended_at=clock_timestamp(),end_reason=$4
     WHERE id=$1 AND company_id=$2 RETURNING id,status,ended_at::text`,[id,company,actor,reason.trim()])).rows[0]!;
   await this.audit.logEvent({company_id:company,actor_user_id:actor,action:'payroll.advance_recovery.correction.withdraw',entity_type:'payroll_recovery_correction',entity_id:id,before_data:{status:row.status},after_data:{status:'withdrawn',recovery_id:row.recovery_id,reason:reason.trim()}},c);
   await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK');if(e instanceof PayrollRecoveryCorrectionError)throw e;if((e as{code?:string}).code==='23514')throw conflict('PAYROLL_RECOVERY_CORRECTION_NOT_WITHDRAWABLE');throw e;}finally{c.release();}
 }
 async expire(company:string,actor:string,id:string){
  const c=await this.db.connect();try{await c.query('BEGIN');const row=(await c.query<{status:string;approval_expires_at:string|null;expired:boolean;recovery_id:string;requested_by:string;approved_by:string;draft_id:string}>('SELECT c.status,c.approval_expires_at::text,(c.approval_expires_at<=clock_timestamp()) expired,c.recovery_id,c.requested_by,c.approved_by,r.draft_id FROM payroll_recovery_corrections c JOIN payroll_employee_advance_recoveries r ON r.id=c.recovery_id AND r.company_id=c.company_id WHERE c.id=$1 AND c.company_id=$2 FOR UPDATE OF c,r',[id,company])).rows[0];
   if(!row)throw conflict('PAYROLL_RECOVERY_CORRECTION_NOT_FOUND',404);if(row.status!=='approved'||!row.approval_expires_at||!row.expired)throw conflict('PAYROLL_RECOVERY_CORRECTION_NOT_EXPIRED');
   const people=await this.participants(c,company,row.draft_id);if((actor===row.requested_by||actor===row.approved_by||people.has(actor))&&!await hasPrivilegedFinancialAuthority(c,company,actor))throw conflict('PAYROLL_RECOVERY_CORRECTION_SEPARATION_OF_DUTIES',403);
   const result=(await c.query(`UPDATE payroll_recovery_corrections SET status='expired',ended_by=$3,ended_at=clock_timestamp(),end_reason='Approval expired before posting; submit a new request for fresh authorization'
     WHERE id=$1 AND company_id=$2 RETURNING id,status,approval_expires_at::text,ended_at::text,end_reason`,[id,company,actor])).rows[0]!;
   await this.audit.logEvent({company_id:company,actor_user_id:actor,action:'payroll.advance_recovery.correction.expire',entity_type:'payroll_recovery_correction',entity_id:id,before_data:{status:'approved',approval_expires_at:row.approval_expires_at},after_data:{status:'expired',recovery_id:row.recovery_id,reason:result.end_reason}},c);
   await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK');if(e instanceof PayrollRecoveryCorrectionError)throw e;if((e as{code?:string}).code==='23514')throw conflict('PAYROLL_RECOVERY_CORRECTION_NOT_EXPIRED');throw e;}finally{c.release();}
 }
 async post(company:string,actor:string,id:string){
   const c=await this.db.connect();try{await c.query('BEGIN');const corr=(await c.query<{id:string;recovery_id:string;amount:string;status:string;requested_by:string;approved_by:string|null;approval_expires_at:string|null;accounting_date:string;draft_id:string;employee_id:string;advance_id:string;period_month:string}>('SELECT c.id,c.recovery_id,c.amount::text,c.status,c.requested_by,c.approved_by,c.approval_expires_at::text,c.accounting_date::text,r.draft_id,r.employee_id,r.advance_id,d.period_month::text FROM payroll_recovery_corrections c JOIN payroll_employee_advance_recoveries r ON r.id=c.recovery_id AND r.company_id=c.company_id JOIN payroll_drafts d ON d.id=r.draft_id AND d.company_id=r.company_id WHERE c.id=$1 AND c.company_id=$2 FOR UPDATE OF c,r',[id,company])).rows[0];if(!corr)throw conflict('PAYROLL_RECOVERY_CORRECTION_NOT_FOUND',404);if(corr.status==='posted'){const journal=(await c.query<{id:string;reference:string}>('SELECT id,reference FROM journal_entries WHERE company_id=$1 AND source_type=\'payroll_recovery_correction\' AND source_id=$2',[company,id])).rows[0];if(!journal)throw conflict('PAYROLL_RECOVERY_CORRECTION_JOURNAL_MISSING');await c.query('COMMIT');return{journal,existing:true};}if(corr.status!=='approved'||!corr.approved_by)throw conflict('PAYROLL_RECOVERY_CORRECTION_NOT_APPROVED');
   const leaseState=(await c.query<{expired:boolean}>('SELECT $1::timestamptz<=clock_timestamp() expired',[corr.approval_expires_at])).rows[0]!;
   if(!corr.approval_expires_at||leaseState.expired){
    const participants=await this.participants(c,company,corr.draft_id);if((participants.has(actor)||actor===corr.requested_by||actor===corr.approved_by)&&!await hasPrivilegedFinancialAuthority(c,company,actor))throw conflict('PAYROLL_RECOVERY_CORRECTION_SEPARATION_OF_DUTIES',403);
    const ended=await c.query(`UPDATE payroll_recovery_corrections SET status='expired',ended_by=$3,ended_at=clock_timestamp(),end_reason='Approval expired before posting; submit a new request for fresh authorization' WHERE id=$1 AND company_id=$2 AND status='approved' RETURNING approval_expires_at::text`,[id,company,actor]);
    await this.audit.logEvent({company_id:company,actor_user_id:actor,action:'payroll.advance_recovery.correction.expire',entity_type:'payroll_recovery_correction',entity_id:id,before_data:{status:'approved',approval_expires_at:corr.approval_expires_at},after_data:{status:'expired',recovery_id:corr.recovery_id,reason:'Approval expired before posting; submit a new request for fresh authorization'}},c);
    await c.query('COMMIT');return{journal:null,existing:false,expired:true};
   }
   const participants=await this.participants(c,company,corr.draft_id);if((participants.has(actor)||actor===corr.requested_by||actor===corr.approved_by)&&!await hasPrivilegedFinancialAuthority(c,company,actor))throw conflict('PAYROLL_RECOVERY_CORRECTION_SEPARATION_OF_DUTIES',403);
   await c.query('SELECT id FROM employee_salary_advances WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,corr.advance_id]);
   const reversed=(await c.query<{amount:string}>('SELECT COALESCE(sum(amount),0)::text amount FROM payroll_recovery_corrections WHERE company_id=$1 AND recovery_id=$2 AND status=\'posted\'', [company,corr.recovery_id])).rows[0]!.amount;
   const original=(await c.query<{amount:string;status:string}>('SELECT amount::text,status FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,corr.recovery_id])).rows[0];if(!original||original.status!=='posted'||cents(reversed)+cents(corr.amount)>cents(original.amount))throw conflict('PAYROLL_RECOVERY_CORRECTION_EXCEEDS_UNREVERSED');
   const year=(await c.query<{id:string;status:string}>('SELECT id,status FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date ORDER BY start_date FOR SHARE',[company,corr.accounting_date])).rows;if(year.length!==1||year[0]!.status!=='open')throw conflict('PAYROLL_RECOVERY_CORRECTION_PERIOD_INELIGIBLE');await assertAccountingDateWritable(company,corr.accounting_date,c);
   const maps=(await c.query<{receivable:string;payable:string}>(`SELECT am.account_id receivable,pm.account_id payable FROM employee_salary_advance_account_mappings am JOIN accounts aa ON aa.id=am.account_id AND aa.company_id=am.company_id
     JOIN payroll_account_mappings pm ON pm.company_id=am.company_id AND pm.mapping_key='net_payroll_liability' JOIN accounts pa ON pa.id=pm.account_id AND pa.company_id=pm.company_id
     WHERE am.company_id=$1 AND aa.is_active AND aa.account_type='asset' AND aa.statement_category='current_asset' AND pa.is_active AND pa.account_type='liability'
       AND NOT EXISTS(SELECT 1 FROM bank_account_ledger_links b WHERE b.company_id=am.company_id AND b.account_id=am.account_id) FOR SHARE OF am,aa,pm,pa`,[company])).rows[0];if(!maps)throw conflict('PAYROLL_RECOVERY_CORRECTION_MAPPING_INVALID');
   const journal=(await c.query<{id:string;reference:string}>(`INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,reference,source_type,source_id,entry_type,created_by)
    VALUES($1,$2,$3,'Employee salary advance recovery correction',$4,'payroll_recovery_correction',$5,'standard',$6) RETURNING id,reference`,[company,year[0]!.id,corr.accounting_date,`PAYROLL RECOVERY REVERSAL ${id.slice(0,8)}`,id,actor])).rows[0]!;
   const debit=(await c.query<{id:string}>(`INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,$4,0,'employee_salary_advance_recovery_reversal',1) RETURNING id`,[company,journal.id,maps.receivable,corr.amount])).rows[0]!;
   await c.query(`INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,0,$4,'employee_salary_advance_payroll_liability_reversal',2)`,[company,journal.id,maps.payable,corr.amount]);
   await postJournalInTransaction(c,company,actor,journal.id,{payrollRecoveryCorrectionId:id});
   await c.query("UPDATE payroll_recovery_corrections SET status='posted',journal_entry_id=$3,journal_line_id=$4,posted_by=$5,posted_at=clock_timestamp() WHERE id=$1 AND company_id=$2 AND status='approved'",[id,company,journal.id,debit.id,actor]);
   await this.audit.logEvent({company_id:company,actor_user_id:actor,action:'payroll.advance_recovery.correction.post',entity_type:'payroll_recovery_correction',entity_id:id,after_data:{recovery_id:corr.recovery_id,amount:corr.amount,journal_entry_id:journal.id,journal_line_id:debit.id,accounting_date:corr.accounting_date}},c);
   await c.query('COMMIT');return{journal,existing:false};
  }catch(e){await c.query('ROLLBACK');if(e instanceof PayrollRecoveryCorrectionError)throw e;if(e instanceof AccountingPeriodClosedError||e instanceof FiscalYearClosedError||e instanceof LedgerSourceAuthorityBlockedError)throw conflict('PAYROLL_RECOVERY_CORRECTION_PERIOD_INELIGIBLE');if(e instanceof JournalPostingValidationError||e instanceof JournalPostingConflictError)throw conflict('PAYROLL_RECOVERY_CORRECTION_JOURNAL_INVALID');if(['23503','23505','23514'].includes((e as{code?:string}).code??''))throw conflict('PAYROLL_RECOVERY_CORRECTION_CONFLICT');throw e;}finally{c.release();}
 }
}
