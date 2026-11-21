import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable, AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { postJournalInTransaction, FiscalYearClosedError, LedgerSourceAuthorityBlockedError, JournalPostingConflictError, JournalPostingValidationError } from '../accounting/journal-posting';
import { assertLedgerSourceAuthority } from '../accounting/ledger-source-authority';
import { lockPayrollEccMonths, PAYROLL_ECC_CATEGORIES } from './payroll-ecc-lock';
import { hasPrivilegedFinancialAuthority } from '../memberships/privileged-financial-authority';

export const PAYROLL_ACCOUNT_MAPPINGS = [
  { key: 'earnings_expense', type: 'expense', label: 'Earnings expense' },
  { key: 'employer_contribution_expense', type: 'expense', label: 'Employer contribution expense' },
  { key: 'net_payroll_liability', type: 'liability', label: 'Net payroll liability' },
  { key: 'employee_deduction_liability', type: 'liability', label: 'Employee deduction liability' },
  { key: 'employer_contribution_liability', type: 'liability', label: 'Employer contribution liability' },
] as const;
export type PayrollMappingKey = typeof PAYROLL_ACCOUNT_MAPPINGS[number]['key'];
const mappingByKey = new Map(PAYROLL_ACCOUNT_MAPPINGS.map(x => [x.key, x]));
const cents = (v: string) => { const [whole, fraction = ''] = v.split('.'); return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')); };
const money = (v: bigint) => `${v / 100n}.${String(v % 100n).padStart(2, '0')}`;

export class PayrollAccountingError extends Error {
  constructor(public readonly code: string, public readonly status = 400, public readonly details?: unknown) { super(code); }
}

export class PayrollAccountingService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  async mappings(companyId: string) {
    const [accounts, mappings] = await Promise.all([
      this.db.query<{ id: string; code: string; name: string; name_ar: string | null; account_type: string; is_active: boolean }>(
        'SELECT id,code,name,name_ar,account_type,is_active FROM accounts WHERE company_id=$1 ORDER BY code,id', [companyId]),
      this.db.query<{ mapping_key: PayrollMappingKey; account_id: string; account_code: string; account_name: string; account_name_ar: string | null; account_type: string; account_active: boolean }>(
        `SELECT m.mapping_key,m.account_id,a.code account_code,a.name account_name,a.name_ar account_name_ar,a.account_type,a.is_active account_active
         FROM payroll_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id
         WHERE m.company_id=$1 ORDER BY m.mapping_key`, [companyId]),
    ]);
    return { mappings: mappings.rows, accounts: accounts.rows, requirements: PAYROLL_ACCOUNT_MAPPINGS };
  }

  async setMapping(companyId: string, actor: string, key: PayrollMappingKey, accountId: string) {
    const required = mappingByKey.get(key);
    if (!required) throw new PayrollAccountingError('PAYROLL_MAPPING_INVALID');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const account = (await client.query<{ account_type: string; is_active: boolean }>(
        'SELECT account_type,is_active FROM accounts WHERE id=$1 AND company_id=$2 FOR SHARE', [accountId, companyId])).rows[0];
      if (!account) throw new PayrollAccountingError('PAYROLL_MAPPING_ACCOUNT_NOT_FOUND', 404);
      if (!account.is_active) throw new PayrollAccountingError('PAYROLL_MAPPING_ACCOUNT_INACTIVE', 409);
      if (account.account_type !== required.type) throw new PayrollAccountingError('PAYROLL_MAPPING_ACCOUNT_TYPE', 400);
      const before = (await client.query('SELECT mapping_key,account_id FROM payroll_account_mappings WHERE company_id=$1 AND mapping_key=$2 FOR UPDATE', [companyId, key])).rows[0] ?? null;
      const after = (await client.query(
        `INSERT INTO payroll_account_mappings(company_id,mapping_key,account_id,created_by,updated_by)
         VALUES($1,$2,$3,$4,$4) ON CONFLICT(company_id,mapping_key) DO UPDATE SET account_id=EXCLUDED.account_id,updated_by=EXCLUDED.updated_by,updated_at=NOW()
         RETURNING mapping_key,account_id`, [companyId, key, accountId, actor])).rows[0];
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'payroll.account_mapping.update', entity_type: 'payroll_account_mapping', entity_id: accountId, before_data: before, after_data: after }, client);
      await client.query('COMMIT');
      return after;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }


  async postingStatus(companyId: string, draftId: string, actor: string) {
    const plan = await this.preview(companyId, draftId);
    const privileged = await hasPrivilegedFinancialAuthority(this.db, companyId, actor);
    const result = await this.db.query<{journal_id:string|null;reference:string|null;journal_status:string|null;separated:boolean;eligible:boolean}>(`
      SELECT j.id journal_id,j.reference,j.status journal_status,
        (d.approved_by IS DISTINCT FROM $3::uuid AND NOT EXISTS (SELECT 1 FROM payroll_draft_contributors c WHERE c.company_id=d.company_id AND c.draft_id=d.id AND c.user_id=$3)) separated,
        (SELECT count(*)=1 AND bool_and(f.status='open') FROM fiscal_years f WHERE f.company_id=d.company_id AND d.period_month BETWEEN f.start_date AND f.end_date)
          AND NOT EXISTS(SELECT 1 FROM monthly_close_periods m WHERE m.company_id=d.company_id AND m.status='closed' AND d.period_month BETWEEN m.period_start AND m.period_end)
          AND NOT EXISTS(SELECT 1 FROM ledger_source_authority a WHERE a.company_id=d.company_id AND a.status='active' AND d.period_month BETWEEN a.from_date AND a.to_date) eligible
      FROM payroll_drafts d LEFT JOIN journal_entries j ON j.company_id=d.company_id AND j.source_type='payroll' AND j.source_id=d.id
      WHERE d.company_id=$1 AND d.id=$2`,[companyId,draftId,actor]);
    const row = result.rows[0]!;
    const blockers = [...plan.blockers];
    if (!row.separated && !privileged) blockers.push({code:'separation_of_duties'});
    if (!row.eligible) blockers.push({code:'period_ineligible'});
    if (row.journal_id && row.journal_status !== 'posted') blockers.push({code:'journal_invalid'});
    return {journal:row.journal_id && row.journal_status==='posted'?{id:row.journal_id,reference:row.reference}:null, blockers, warnings:plan.warnings, eligible:!row.journal_id && plan.can_preview && (row.separated || privileged) && row.eligible};
  }

  async post(companyId: string, draftId: string, actor: string, bonuses: { entitlement_id: string; amount: string }[] = []) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`bonus-payroll-recognition:${companyId}`]);
      const draft = (await client.query<{period_month:string; status:string; approved_by:string}>(
        'SELECT period_month::text,status,approved_by FROM payroll_drafts WHERE id=$1 AND company_id=$2 FOR UPDATE', [draftId, companyId])).rows[0];
      if (!draft) throw new PayrollAccountingError('PAYROLL_NOT_FOUND', 404);
      const privileged = await hasPrivilegedFinancialAuthority(client, companyId, actor);
      const contributor = (await client.query<{yes:boolean}>('SELECT EXISTS(SELECT 1 FROM payroll_draft_contributors WHERE company_id=$1 AND draft_id=$2 AND user_id=$3) yes', [companyId,draftId,actor])).rows[0]!.yes;
      if ((contributor || draft.approved_by === actor) && !privileged) throw new PayrollAccountingError('PAYROLL_POST_SEPARATION_OF_DUTIES', 403);
      const existing = (await client.query<{id:string; reference:string; status:string}>("SELECT id,reference,status FROM journal_entries WHERE company_id=$1 AND source_type='payroll' AND source_id=$2", [companyId,draftId])).rows[0];
      if (existing) {
        if (existing.status !== 'posted') throw new PayrollAccountingError('PAYROLL_JOURNAL_INVALID',409);
        const saved = (await client.query<{entitlement_id:string; amount:string}>(`
          SELECT entitlement_id,amount::text FROM employee_bonus_balance_entries
          WHERE company_id=$1 AND journal_id=$2 AND kind='payroll'
        `,[companyId,existing.id])).rows;
        if (saved.length !== bonuses.length || saved.some(row => !bonuses.some(b =>
          b.entitlement_id === row.entitlement_id && cents(b.amount) === cents(row.amount)))) {
          throw new PayrollAccountingError('PAYROLL_BONUS_CONFLICT',409);
        }
        await client.query('COMMIT'); return {journal:existing, existing:true};
      }
      if (draft.status !== 'approved') throw new PayrollAccountingError('PAYROLL_NOT_APPROVED', 409);
      const reservations=(await client.query<{advance_id:string;amount:string;employee_id:string;active:boolean}>(`SELECT advance_id,amount::text,employee_id,(expires_at>clock_timestamp()) active FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND draft_id=$2 AND status='reserved' ORDER BY advance_id FOR UPDATE`,[companyId,draftId])).rows;
      for(const r of reservations){await client.query('SELECT id FROM employee_salary_advances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,r.advance_id]);if(!r.active)throw new PayrollAccountingError('PAYROLL_ADVANCE_RESERVATION_EXPIRED',409);const balance=(await client.query<{ok:boolean}>(`SELECT a.employee_id=$3 AND a.status='issued' AND a.amount >=
        COALESCE((SELECT sum(x.amount) FROM payroll_employee_advance_recoveries x WHERE x.company_id=$1 AND x.advance_id=$2 AND x.status='posted'),0)
        -COALESCE((SELECT sum(c.amount) FROM payroll_recovery_corrections c JOIN payroll_employee_advance_recoveries x ON x.id=c.recovery_id WHERE x.company_id=$1 AND x.advance_id=$2 AND c.status='posted'),0)
        +COALESCE((SELECT sum(x.amount) FROM payroll_employee_advance_recoveries x WHERE x.company_id=$1 AND x.advance_id=$2 AND x.status='reserved' AND x.expires_at>clock_timestamp()),0) ok
        FROM employee_salary_advances a WHERE a.company_id=$1 AND a.id=$2 FOR UPDATE`,[companyId,r.advance_id,r.employee_id])).rows[0]?.ok;if(!balance)throw new PayrollAccountingError('PAYROLL_ADVANCE_RESERVATION_INVALID',409);}
      // A payroll reclassification cannot predate any liability it consumes.
      const dates = (await client.query<{accounting_date:string; next_month:string}>(`
        SELECT GREATEST($2::date,max(r.accounting_date))::text accounting_date,
          ($2::date+interval '1 month')::date::text next_month
        FROM employee_bonus_recognitions r
        WHERE r.company_id=$1 AND r.entitlement_id=ANY($3::uuid[])
      `,[companyId,draft.period_month,bonuses.map(b=>b.entitlement_id)])).rows[0]!;
      if (dates.accounting_date>=dates.next_month) throw new PayrollAccountingError('PAYROLL_BONUS_CONFLICT',409);
      const years = (await client.query<{id:string;status:string}>(
        'SELECT id,status FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date ORDER BY start_date FOR SHARE', [companyId,dates.accounting_date])).rows;
      if (years.length !== 1 || years[0]!.status !== 'open') throw new PayrollAccountingError('PAYROLL_PERIOD_INELIGIBLE', 409);
      // Fiscal year, accounting month, then ECC month: all paths take these in the same order.
      await assertAccountingDateWritable(companyId, draft.period_month, client);
      if (dates.accounting_date!==draft.period_month) {
        await assertLedgerSourceAuthority(client,companyId,draft.period_month);
        await assertAccountingDateWritable(companyId,dates.accounting_date,client);
      }
      await lockPayrollEccMonths(client, companyId, [draft.period_month]);
      await client.query('SELECT m.id FROM payroll_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id WHERE m.company_id=$1 FOR SHARE OF m,a', [companyId]);
      await client.query('SELECT m.company_id FROM employee_salary_advance_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id WHERE m.company_id=$1 FOR SHARE OF m,a',[companyId]);
      const invalid = (await client.query<{n:string}>(`SELECT COUNT(*)::text n FROM payroll_draft_employees WHERE company_id=$1 AND draft_id=$2 AND
        (salary+allowances+bonus+overtime<deductions OR (legacy_allowances IS NOT NULL AND allowances<>legacy_allowances+housing_allowance+transportation_allowance+other_allowance)
         OR (legacy_allowances IS NULL AND (housing_allowance<>0 OR transportation_allowance<>0 OR other_allowance<>0)))`, [companyId,draftId])).rows[0]!.n;
      if (invalid !== '0') throw new PayrollAccountingError('PAYROLL_INVALID', 409);
      const bonusLines = [];
      const used = new Map<string,bigint>();
      for (const bonus of [...bonuses].sort((a,b)=>a.entitlement_id.localeCompare(b.entitlement_id))) {
        const row = (await client.query<{employee_id:string; liability_account_id:string; bonus:string}>(`
          SELECT e.employee_id,r.liability_account_id,p.bonus::text
          FROM employee_bonus_recognitions r
          JOIN employee_bonus_entitlements e ON e.company_id=r.company_id AND e.id=r.entitlement_id
          JOIN payroll_draft_employees p ON p.company_id=e.company_id AND p.employee_id=e.employee_id AND p.draft_id=$3
          WHERE r.company_id=$1 AND r.entitlement_id=$2 AND r.accounting_date<=$4
        `,[companyId,bonus.entitlement_id,draftId,dates.accounting_date])).rows[0];
        if (!row) throw new PayrollAccountingError('PAYROLL_BONUS_CONFLICT',409);
        const sum = (used.get(row.employee_id) ?? 0n) + cents(bonus.amount);
        if (sum > cents(row.bonus)) throw new PayrollAccountingError('PAYROLL_BONUS_CONFLICT',409);
        used.set(row.employee_id,sum);
        bonusLines.push({ ...bonus, account_id: row.liability_account_id });
      }
      // Discover recognized obligations through the entire payroll month, even
      // when the request omitted allocations and would otherwise post on day one.
      const required = (await client.query<{employee_id:string; amount:string}>(`
        SELECT p.employee_id,LEAST(p.bonus,COALESCE(sum(GREATEST(available.amount,0)),0))::text amount
        FROM payroll_draft_employees p
        JOIN employee_bonus_entitlements e ON e.company_id=p.company_id AND e.employee_id=p.employee_id
        JOIN employee_bonus_recognitions r ON r.company_id=e.company_id AND r.entitlement_id=e.id
        CROSS JOIN LATERAL (
          SELECT e.amount+COALESCE(sum(CASE WHEN b.kind IN ('increase','reversal') THEN b.amount ELSE -b.amount END),0) amount
          FROM employee_bonus_balance_entries b WHERE b.company_id=e.company_id AND b.entitlement_id=e.id
        ) available
        WHERE p.company_id=$1 AND p.draft_id=$2 AND p.bonus>0 AND r.accounting_date<$3::date
        GROUP BY p.employee_id,p.bonus
      `,[companyId,draftId,dates.next_month])).rows;
      if (required.some(row => (used.get(row.employee_id) ?? 0n) < cents(row.amount))) {
        throw new PayrollAccountingError('PAYROLL_BONUS_ALLOCATION_REQUIRED',409);
      }
      const plan = await this.calculateReadiness(companyId, draftId, client, bonusLines);
      if (!plan.can_preview || !plan.balanced) throw new PayrollAccountingError('PAYROLL_POST_BLOCKED', 409, plan.blockers);
      const journal = (await client.query<{id:string;reference:string}>(`INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,reference,source_type,source_id,entry_type,created_by)
        VALUES($1,$2,$3,$4,$5,'payroll',$6,'standard',$7) RETURNING id,reference`, [companyId,years[0]!.id,dates.accounting_date,`Payroll ${draft.period_month.slice(0,7)}`,`PAYROLL ${draft.period_month.slice(0,7)}`,draftId,actor])).rows[0]!;
      for (const [i,line] of plan.lines.entries()) await client.query('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,$4,$5,$6,$7)', [companyId,journal.id,line.account_id,line.debit,line.credit,line.mapping_key,i+1]);
      for (const bonus of bonusLines) {
        try {
          await client.query(`
            INSERT INTO employee_bonus_balance_entries(company_id,entitlement_id,journal_id,idempotency_key,kind,amount,created_by)
            VALUES($1,$2,$3,$4,'payroll',$5,$6)
          `,[companyId,bonus.entitlement_id,journal.id,randomUUID(),bonus.amount,actor]);
        } catch (error) {
          if (['23505','23514'].includes((error as {code?:string}).code ?? '')) {
            throw new PayrollAccountingError('PAYROLL_BONUS_CONFLICT',409);
          }
          throw error;
        }
      }
      const recoveryLine=(await client.query<{id:string}>('SELECT id FROM journal_lines WHERE company_id=$1 AND journal_entry_id=$2 AND memo=\'employee_salary_advance_receivable\' AND credit>0',[companyId,journal.id])).rows[0];
      if(reservations.length){if(!recoveryLine)throw new PayrollAccountingError('PAYROLL_ADVANCE_JOURNAL_INVALID',409);const changed=await client.query("UPDATE payroll_employee_advance_recoveries SET status='posted',expires_at=NULL,journal_entry_id=$3,journal_line_id=$4 WHERE company_id=$1 AND draft_id=$2 AND status='reserved' AND expires_at>clock_timestamp()",[companyId,draftId,journal.id,recoveryLine.id]);if(changed.rowCount!==reservations.length)throw new PayrollAccountingError('PAYROLL_ADVANCE_RESERVATION_EXPIRED',409);}
      await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'journal.create',entity_type:'journal_entry',entity_id:journal.id,after_data:{source_type:'payroll',source_id:draftId,lines:plan.lines}},client);
      const posted = await postJournalInTransaction(client,companyId,actor,journal.id,{payrollDraftId:draftId});
      await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'payroll.accounting.post',entity_type:'payroll_draft',entity_id:draftId,after_data:{journal_entry_id:journal.id,totals:plan.totals}},client);
      await client.query('COMMIT');
      return {journal:posted,existing:false};
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof AccountingPeriodClosedError || error instanceof FiscalYearClosedError || error instanceof LedgerSourceAuthorityBlockedError) throw new PayrollAccountingError('PAYROLL_PERIOD_INELIGIBLE',409);
      if (error instanceof JournalPostingConflictError || error instanceof JournalPostingValidationError) throw new PayrollAccountingError('PAYROLL_JOURNAL_INVALID',409);
      throw error;
    } finally { client.release(); }
  }

  async preview(companyId: string, draftId: string) {
    return this.calculateReadiness(companyId, draftId, this.db);
  }

  private async calculateReadiness(companyId: string, draftId: string, db: Pool | PoolClient, bonusLines: { account_id: string; amount: string }[] = []) {
    const draft = (await db.query<{ id: string; period_month: string; currency_code: string; status: string }>(
      'SELECT id,period_month::text,currency_code,status FROM payroll_drafts WHERE id=$1 AND company_id=$2', [draftId, companyId])).rows[0];
    if (!draft) throw new PayrollAccountingError('PAYROLL_NOT_FOUND', 404);
    const blockers: Array<{ code: string; count?: number; details?: unknown[] }> = [];
    if (draft.status !== 'approved') blockers.push({ code: 'payroll_not_approved' });

    const lines = (await db.query<{ employee_id: string; salary: string; allowances: string; bonus: string; overtime: string; deductions: string; employer_contributions: string }>(
      `SELECT employee_id,salary::text,allowances::text,bonus::text,overtime::text,deductions::text,employer_contributions::text
       FROM payroll_draft_employees WHERE company_id=$1 AND draft_id=$2 ORDER BY employee_id`, [companyId, draftId])).rows;
    let earnings = 0n, deductions = 0n, employer = 0n;
    for (const line of lines) {
      earnings += cents(line.salary) + cents(line.allowances) + cents(line.bonus) + cents(line.overtime);
      deductions += cents(line.deductions);
      employer += cents(line.employer_contributions);
    }
    const recoveryRows=(await db.query<{amount:string}>(`SELECT COALESCE(sum(amount),0)::text amount FROM payroll_employee_advance_recoveries
      WHERE company_id=$1 AND draft_id=$2 AND status IN('reserved','posted') AND (status='posted' OR expires_at>clock_timestamp())`,[companyId,draftId])).rows[0]!;
    const recoveries=cents(recoveryRows.amount);
    if (!lines.length) blockers.push({ code: 'payroll_empty' });
    const net = earnings - deductions - recoveries;
    if (lines.length && earnings + employer === 0n) blockers.push({ code: 'payroll_no_postable_amount' });
    if ([earnings, deductions, employer, net].some(x => x < 0n || x > 999999999999999999n)) blockers.push({ code: 'payroll_amount_out_of_range' });

    const configured = (await db.query<{ mapping_key: PayrollMappingKey; account_id: string; code: string; name: string; name_ar: string | null; account_type: string; is_active: boolean }>(
      `SELECT m.mapping_key,m.account_id,a.code,a.name,a.name_ar,a.account_type,a.is_active
       FROM payroll_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id WHERE m.company_id=$1`, [companyId])).rows;
    const byKey = new Map(configured.map(x => [x.mapping_key, x]));
    for (const required of PAYROLL_ACCOUNT_MAPPINGS) {
      const row = byKey.get(required.key);
      if (!row) blockers.push({ code: 'mapping_missing', details: [{ mapping_key: required.key }] });
      else if (!row.is_active) blockers.push({ code: 'mapping_account_inactive', details: [{ mapping_key: required.key }] });
      else if (row.account_type !== required.type) blockers.push({ code: 'mapping_account_type_invalid', details: [{ mapping_key: required.key }] });
    }

    const overlaps = (await db.query<{ employee_id: string; employee_number: string; display_name: string; category: string; amount: string }>(
      `SELECT r.employee_id,e.employee_number,e.display_name,r.category,SUM(a.amount)::text amount
       FROM employee_cost_records r
       JOIN employees e ON e.id=r.employee_id AND e.company_id=r.company_id
       JOIN employee_cost_allocations a ON a.cost_record_id=r.id AND a.company_id=r.company_id
       WHERE r.company_id=$1 AND r.status='approved' AND r.currency_code=$4 AND a.allocation_month=$2::date
         AND r.category = ANY($5::text[])
         AND EXISTS (SELECT 1 FROM payroll_draft_employees p WHERE p.company_id=r.company_id AND p.draft_id=$3 AND p.employee_id=r.employee_id)
         AND NOT EXISTS (SELECT 1 FROM employee_cost_records newer WHERE newer.company_id=r.company_id AND newer.supersedes_id=r.id AND newer.status='approved')
       GROUP BY r.employee_id,e.employee_number,e.display_name,r.category ORDER BY e.employee_number,r.category`, [companyId, draft.period_month, draftId, draft.currency_code, PAYROLL_ECC_CATEGORIES])).rows;
    const deductionOverlaps = overlaps.filter(row => row.category === 'employee_deduction');
    const expenseOverlaps = overlaps.filter(row => row.category !== 'employee_deduction');
    if (expenseOverlaps.length) blockers.push({ code: 'ecc_overlap', count: expenseOverlaps.length, details: expenseOverlaps });
    // Treat ECC employee deductions as a blocker: the current records do not establish whether a deduction
    // was already included in payroll withholding, so posting readiness cannot safely assume they are separate.
    if (deductionOverlaps.length) blockers.push({ code: 'ecc_employee_deduction_overlap', count: deductionOverlaps.length, details: deductionOverlaps });

    const manual = (await db.query<{ count: string }>(
      `SELECT COUNT(*)::text count FROM journal_entries WHERE company_id=$1 AND source_type IS NULL
       AND status IN ('draft','posted') AND accounting_date >= $2::date AND accounting_date < ($2::date + INTERVAL '1 month')`, [companyId, draft.period_month])).rows[0]!;
    const manualJournalCount = Number(manual.count);
    const mappingDetails = PAYROLL_ACCOUNT_MAPPINGS.map(required => {
      const row = byKey.get(required.key);
      return { mapping_key: required.key, account_id: row?.account_id ?? null, code: row?.code ?? null, name: row?.name ?? null, name_ar: row?.name_ar ?? null, account_type: row?.account_type ?? null, is_active: row?.is_active ?? null };
    });
    const complete = PAYROLL_ACCOUNT_MAPPINGS.every(x => byKey.get(x.key)?.is_active && byKey.get(x.key)?.account_type === x.type);
    const recoveryAccount=(await db.query<{account_id:string;is_active:boolean;account_type:string}>(`SELECT a.id account_id,a.is_active,a.account_type FROM employee_salary_advance_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id WHERE m.company_id=$1`,[companyId])).rows[0];
    if(recoveries>0n&&(!recoveryAccount?.is_active||recoveryAccount.account_type!=='asset'))blockers.push({code:'advance_mapping_invalid'});
    const priorExpense = bonusLines.reduce((total,line)=>total+cents(line.amount),0n);
    const proposedLines = complete ? [
      { mapping_key: 'earnings_expense', account_id: byKey.get('earnings_expense')!.account_id, debit: money(earnings - priorExpense), credit: '0.00' },
      ...bonusLines.map(line=>({mapping_key:'recognized_bonus_liability', account_id:line.account_id, debit:line.amount, credit:'0.00'})),
      { mapping_key: 'employer_contribution_expense', account_id: byKey.get('employer_contribution_expense')!.account_id, debit: money(employer), credit: '0.00' },
      { mapping_key: 'net_payroll_liability', account_id: byKey.get('net_payroll_liability')!.account_id, debit: '0.00', credit: money(net) },
      { mapping_key: 'employee_deduction_liability', account_id: byKey.get('employee_deduction_liability')!.account_id, debit: '0.00', credit: money(deductions) },
      ...(recoveries>0n&&recoveryAccount?[{mapping_key:'employee_salary_advance_receivable',account_id:recoveryAccount.account_id,debit:'0.00',credit:money(recoveries)}]:[]),
      { mapping_key: 'employer_contribution_liability', account_id: byKey.get('employer_contribution_liability')!.account_id, debit: '0.00', credit: money(employer) },
    ] : [];
    const journalLines = proposedLines.filter(line => cents(line.debit) > 0n || cents(line.credit) > 0n);
    return {
      draft: { id: draft.id, period_month: draft.period_month, status: draft.status, currency_code: draft.currency_code },
      totals: { earnings: money(earnings), employee_deductions: money(deductions), advance_recoveries:money(recoveries), net_payable: money(net), employer_contributions: money(employer), debit_total: money(earnings + employer), credit_total: money(net + deductions + recoveries + employer) },
      mappings: mappingDetails,
      lines: journalLines,
      blockers,
      warnings: manualJournalCount ? [{ code: 'manual_journal_review', count: manualJournalCount }] : [],
      balanced: earnings + employer === net + deductions + recoveries + employer,
      can_preview: draft.status === 'approved' && lines.length > 0 && earnings + employer > 0n && complete && overlaps.length === 0 && blockers.length === 0,
      authority: 'informational_only',
      posting_revalidation_required: true,
      posting_revalidation: 'Posting reloads and revalidates payroll lines, mappings, account status and types, ECC overlaps, manual-journal review conditions, and other blockers inside its transaction.',
      side_effects: false,
    };
  }
}
