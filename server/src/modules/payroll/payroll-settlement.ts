import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable, AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { postJournalInTransaction, FiscalYearClosedError, JournalPostingValidationError, JournalPostingConflictError, LedgerSourceAuthorityBlockedError } from '../accounting/journal-posting';
import { resolveBankLedgerAccount } from '../accounting/personal-payment-posting';

export class PayrollSettlementError extends Error {
  constructor(readonly code:string, readonly status=409) { super(code); }
}
const conflict=(code:string)=>new PayrollSettlementError(code);
export class PayrollSettlementService {
  private audit=new AuditLogRepository();
  constructor(private db:Pool) {}
  async liabilities(company:string) {
    return (await this.db.query(`SELECT l.id liability_line_id,j.id payroll_journal_id,j.source_id payroll_draft_id,d.period_month::text,
      l.memo category,l.account_id,l.credit::text original_amount,COALESCE(sum(p.amount),0)::text settled_amount,
      (l.credit-COALESCE(sum(p.amount),0))::text remaining_amount
      FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
      JOIN payroll_drafts d ON d.id=j.source_id AND d.company_id=j.company_id
      LEFT JOIN payroll_settlement_allocations p ON p.company_id=l.company_id AND p.liability_line_id=l.id
      WHERE l.company_id=$1 AND j.source_type='payroll' AND j.status='posted' AND d.status='approved'
        AND l.debit=0 AND l.credit>0 AND l.memo IN ('net_payroll_liability','employee_deduction_liability','employer_contribution_liability')
      GROUP BY l.id,j.id,d.id ORDER BY d.period_month,l.sequence`,[company])).rows;
  }
  async history(company:string) {
    return (await this.db.query(`SELECT p.id,p.bank_transaction_id,p.liability_line_id,p.journal_entry_id,p.amount::text,p.created_at::text,
      l.memo category,j.source_id payroll_draft_id,t.transaction_date::text
      FROM payroll_settlement_allocations p JOIN journal_lines l ON l.id=p.liability_line_id AND l.company_id=p.company_id
      JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
      JOIN bank_transactions t ON t.id=p.bank_transaction_id AND t.company_id=p.company_id
      WHERE p.company_id=$1 ORDER BY p.created_at DESC,p.id`,[company])).rows;
  }
  async banks(company:string) {
    return (await this.db.query(`SELECT t.id,t.transaction_date::text,t.amount::text,t.bank_account_id,
      COALESCE((SELECT SUM(p.amount) FROM payroll_settlement_allocations p WHERE p.company_id=t.company_id AND p.bank_transaction_id=t.id),0)::text allocated_amount,
      (ABS(t.amount)-COALESCE((SELECT SUM(p.amount) FROM payroll_settlement_allocations p WHERE p.company_id=t.company_id AND p.bank_transaction_id=t.id),0))::text remaining_amount
      FROM bank_transactions t WHERE t.company_id=$1 AND t.amount<0 AND t.currency_code='SAR' AND t.reconciliation_status<>'reconciled'
      AND (t.source_kind<>'manual' OR t.manual_category IN ('supplier_payment','government_payment','other'))
      AND EXISTS(SELECT 1 FROM bank_account_ledger_links b JOIN accounts a ON a.id=b.account_id AND a.company_id=b.company_id
        WHERE b.company_id=t.company_id AND b.bank_account_id=t.bank_account_id AND b.valid_from<=t.transaction_date AND (b.valid_to IS NULL OR b.valid_to>=t.transaction_date) AND a.is_active)
      AND NOT EXISTS(SELECT 1 FROM bank_transaction_matches m WHERE m.company_id=t.company_id AND m.bank_transaction_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM document_settlements s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM obligation_settlements s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM employee_cost_payment_allocations s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM personal_payment_reimbursements s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM partner_transactions s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
      ORDER BY t.transaction_date DESC,t.id`,[company])).rows;
  }
  async create(company:string, actor:string, input:{bankTransactionId:string;liabilityLineId:string;amount:string;idempotencyKey:string}) {
    const c=await this.db.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`payroll-settlement:${company}:${input.idempotencyKey}`]);
      const existing=(await c.query<{id:string;bank_transaction_id:string;liability_line_id:string;amount:string;journal_entry_id:string}>(
        'SELECT id,bank_transaction_id,liability_line_id,amount::text,journal_entry_id FROM payroll_settlement_allocations WHERE company_id=$1 AND idempotency_key=$2',[company,input.idempotencyKey])).rows[0];
      if(existing) {
        const same=(await c.query<{same:boolean}>('SELECT $1::numeric=$2::numeric same',[existing.amount,input.amount])).rows[0]!.same;
        if(!same||existing.bank_transaction_id!==input.bankTransactionId||existing.liability_line_id!==input.liabilityLineId) throw conflict('PAYROLL_SETTLEMENT_IDEMPOTENCY_CONFLICT');
        await c.query('COMMIT');return {allocation:existing,existing:true};
      }
      const bank=(await c.query<{id:string;bank_account_id:string;amount:string;transaction_date:string;currency_code:string;reconciliation_status:string;source_kind:string;manual_category:string|null}>(
        'SELECT id,bank_account_id,amount::text,transaction_date::text,currency_code,reconciliation_status,source_kind,manual_category FROM bank_transactions WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,input.bankTransactionId])).rows[0];
      if(!bank) throw new PayrollSettlementError('PAYROLL_SETTLEMENT_NOT_FOUND',404);
      if(!bank.amount.startsWith('-')||bank.reconciliation_status==='reconciled'||bank.currency_code.trim()!=='SAR'||(bank.source_kind==='manual'&&!['supplier_payment','government_payment','other'].includes(bank.manual_category??''))) throw conflict('PAYROLL_SETTLEMENT_BANK_INELIGIBLE');
      const liability=(await c.query<{account_id:string;period_month:string;currency_code:string}>(`SELECT l.account_id,d.period_month::text,d.currency_code FROM journal_lines l
        JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id JOIN payroll_drafts d ON d.id=j.source_id AND d.company_id=j.company_id
        WHERE l.company_id=$1 AND l.id=$2 AND j.source_type='payroll' AND j.status='posted' AND d.status='approved' AND l.debit=0 AND l.credit>0
          AND l.memo IN ('net_payroll_liability','employee_deduction_liability','employer_contribution_liability') FOR UPDATE OF l`,[company,input.liabilityLineId])).rows[0];
      if(!liability) throw new PayrollSettlementError('PAYROLL_SETTLEMENT_NOT_FOUND',404);
      if(bank.transaction_date<liability.period_month||bank.currency_code.trim()!==liability.currency_code.trim()) throw conflict('PAYROLL_SETTLEMENT_BANK_INELIGIBLE');
      const year=(await c.query<{id:string}>("SELECT id FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date AND status='open' FOR SHARE",[company,bank.transaction_date])).rows;
      if(year.length!==1) throw conflict('PAYROLL_SETTLEMENT_PERIOD_INELIGIBLE');
      await assertAccountingDateWritable(company,bank.transaction_date,c);
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
      ) yes`,[company,bank.id])).rows[0]!.yes;
      if(claimed) throw conflict('PAYROLL_SETTLEMENT_BANK_CLAIMED');
      const id=randomUUID(), journal=randomUUID();
      await c.query(`INSERT INTO journal_entries(id,company_id,fiscal_year_id,accounting_date,description,source_type,source_id,created_by)
        VALUES($1,$2,$3,$4,'Payroll liability settlement','payroll_settlement',$5,$6)`,[journal,company,year[0]!.id,bank.transaction_date,id,actor]);
      await c.query(`INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence)
        VALUES($1,$2,$3,$5,0,1),($1,$2,$4,0,$5,2)`,[company,journal,liability.account_id,account,input.amount]);
      const allocation=(await c.query(`INSERT INTO payroll_settlement_allocations(id,company_id,bank_transaction_id,liability_line_id,journal_entry_id,amount,idempotency_key,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,bank_transaction_id,liability_line_id,journal_entry_id,amount::text`,[id,company,bank.id,input.liabilityLineId,journal,input.amount,input.idempotencyKey,actor])).rows[0];
      await postJournalInTransaction(c,company,actor,journal,{payrollSettlementId:id});
      await this.audit.logEvent({company_id:company,actor_user_id:actor,action:'payroll.settlement.create',entity_type:'payroll_settlement',entity_id:id,after_data:allocation},c);
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
