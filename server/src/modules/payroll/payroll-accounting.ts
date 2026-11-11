import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable, AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { postJournalInTransaction, FiscalYearClosedError, LedgerSourceAuthorityBlockedError, JournalPostingConflictError, JournalPostingValidationError } from '../accounting/journal-posting';
import { lockPayrollEccMonths } from './payroll-ecc-lock';

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
    const result = await this.db.query<{journal_id:string|null;reference:string|null;journal_status:string|null;separated:boolean;eligible:boolean}>(`
      SELECT j.id journal_id,j.reference,j.status journal_status,
        (d.approved_by IS DISTINCT FROM $3::uuid AND NOT EXISTS (SELECT 1 FROM payroll_draft_contributors c WHERE c.company_id=d.company_id AND c.draft_id=d.id AND c.user_id=$3)) separated,
        (SELECT count(*)=1 AND bool_and(f.status='open') FROM fiscal_years f WHERE f.company_id=d.company_id AND d.period_month BETWEEN f.start_date AND f.end_date)
          AND NOT EXISTS(SELECT 1 FROM monthly_close_periods m WHERE m.company_id=d.company_id AND m.status='closed' AND d.period_month BETWEEN m.period_start AND m.period_end)
          AND NOT EXISTS(SELECT 1 FROM ledger_source_authority a WHERE a.company_id=d.company_id AND a.status='active' AND d.period_month BETWEEN a.from_date AND a.to_date) eligible
      FROM payroll_drafts d LEFT JOIN journal_entries j ON j.company_id=d.company_id AND j.source_type='payroll' AND j.source_id=d.id
      WHERE d.company_id=$1 AND d.id=$2`,[companyId,draftId,actor]);
    const row = result.rows[0]!;
    const blockers = [...plan.blockers, ...plan.warnings];
    if (!row.separated) blockers.push({code:'separation_of_duties'});
    if (!row.eligible) blockers.push({code:'period_ineligible'});
    if (row.journal_id && row.journal_status !== 'posted') blockers.push({code:'journal_invalid'});
    return {journal:row.journal_id && row.journal_status==='posted'?{id:row.journal_id,reference:row.reference}:null, blockers, eligible:!row.journal_id && plan.can_preview && row.separated && row.eligible};
  }

  async post(companyId: string, draftId: string, actor: string) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const draft = (await client.query<{period_month:string; status:string; approved_by:string}>(
        'SELECT period_month::text,status,approved_by FROM payroll_drafts WHERE id=$1 AND company_id=$2 FOR UPDATE', [draftId, companyId])).rows[0];
      if (!draft) throw new PayrollAccountingError('PAYROLL_NOT_FOUND', 404);
      const contributor = (await client.query<{yes:boolean}>('SELECT EXISTS(SELECT 1 FROM payroll_draft_contributors WHERE company_id=$1 AND draft_id=$2 AND user_id=$3) yes', [companyId,draftId,actor])).rows[0]!.yes;
      if (contributor || draft.approved_by === actor) throw new PayrollAccountingError('PAYROLL_POST_SEPARATION_OF_DUTIES', 403);
      const existing = (await client.query<{id:string; reference:string; status:string}>("SELECT id,reference,status FROM journal_entries WHERE company_id=$1 AND source_type='payroll' AND source_id=$2", [companyId,draftId])).rows[0];
      if (existing) {
        if (existing.status !== 'posted') throw new PayrollAccountingError('PAYROLL_JOURNAL_INVALID',409);
        await client.query('COMMIT'); return {journal:existing, existing:true};
      }
      if (draft.status !== 'approved') throw new PayrollAccountingError('PAYROLL_NOT_APPROVED', 409);
      const years = (await client.query<{id:string;status:string}>(
        'SELECT id,status FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date ORDER BY start_date FOR SHARE', [companyId,draft.period_month])).rows;
      if (years.length !== 1 || years[0]!.status !== 'open') throw new PayrollAccountingError('PAYROLL_PERIOD_INELIGIBLE', 409);
      // Fiscal year, accounting month, then ECC month: all paths take these in the same order.
      await assertAccountingDateWritable(companyId, draft.period_month, client);
      await lockPayrollEccMonths(client, companyId, [draft.period_month]);
      await client.query('SELECT m.id FROM payroll_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id WHERE m.company_id=$1 FOR SHARE OF m,a', [companyId]);
      const invalid = (await client.query<{n:string}>(`SELECT COUNT(*)::text n FROM payroll_draft_employees WHERE company_id=$1 AND draft_id=$2 AND
        (salary+allowances+bonus+overtime<deductions OR (legacy_allowances IS NOT NULL AND allowances<>legacy_allowances+housing_allowance+transportation_allowance+other_allowance)
         OR (legacy_allowances IS NULL AND (housing_allowance<>0 OR transportation_allowance<>0 OR other_allowance<>0)))`, [companyId,draftId])).rows[0]!.n;
      if (invalid !== '0') throw new PayrollAccountingError('PAYROLL_INVALID', 409);
      const plan = await this.calculateReadiness(companyId, draftId, client);
      if (!plan.can_preview || !plan.balanced) throw new PayrollAccountingError('PAYROLL_POST_BLOCKED', 409, [...plan.blockers, ...plan.warnings]);
      const journal = (await client.query<{id:string;reference:string}>(`INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,reference,source_type,source_id,entry_type,created_by)
        VALUES($1,$2,$3,$4,$5,'payroll',$6,'standard',$7) RETURNING id,reference`, [companyId,years[0]!.id,draft.period_month,`Payroll ${draft.period_month.slice(0,7)}`,`PAYROLL ${draft.period_month.slice(0,7)}`,draftId,actor])).rows[0]!;
      for (const [i,line] of plan.lines.entries()) await client.query('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,$4,$5,$6,$7)', [companyId,journal.id,line.account_id,line.debit,line.credit,line.mapping_key,i+1]);
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

  private async calculateReadiness(companyId: string, draftId: string, db: Pool | PoolClient) {
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
    if (!lines.length) blockers.push({ code: 'payroll_empty' });
    const net = earnings - deductions;
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
         AND r.category IN ('salary','allowances','bonus','overtime','employer_gosi','employee_deduction')
         AND EXISTS (SELECT 1 FROM payroll_draft_employees p WHERE p.company_id=r.company_id AND p.draft_id=$3 AND p.employee_id=r.employee_id)
         AND NOT EXISTS (SELECT 1 FROM employee_cost_records newer WHERE newer.company_id=r.company_id AND newer.supersedes_id=r.id AND newer.status='approved')
       GROUP BY r.employee_id,e.employee_number,e.display_name,r.category ORDER BY e.employee_number,r.category`, [companyId, draft.period_month, draftId, draft.currency_code])).rows;
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
    const proposedLines = complete ? [
      { mapping_key: 'earnings_expense', account_id: byKey.get('earnings_expense')!.account_id, debit: money(earnings), credit: '0.00' },
      { mapping_key: 'employer_contribution_expense', account_id: byKey.get('employer_contribution_expense')!.account_id, debit: money(employer), credit: '0.00' },
      { mapping_key: 'net_payroll_liability', account_id: byKey.get('net_payroll_liability')!.account_id, debit: '0.00', credit: money(net) },
      { mapping_key: 'employee_deduction_liability', account_id: byKey.get('employee_deduction_liability')!.account_id, debit: '0.00', credit: money(deductions) },
      { mapping_key: 'employer_contribution_liability', account_id: byKey.get('employer_contribution_liability')!.account_id, debit: '0.00', credit: money(employer) },
    ] : [];
    const journalLines = proposedLines.filter(line => cents(line.debit) > 0n || cents(line.credit) > 0n);
    return {
      draft: { id: draft.id, period_month: draft.period_month, status: draft.status, currency_code: draft.currency_code },
      totals: { earnings: money(earnings), employee_deductions: money(deductions), net_payable: money(net), employer_contributions: money(employer), debit_total: money(earnings + employer), credit_total: money(net + deductions + employer) },
      mappings: mappingDetails,
      lines: journalLines,
      blockers,
      warnings: manualJournalCount ? [{ code: 'manual_journal_review', count: manualJournalCount }] : [],
      balanced: earnings + employer === net + deductions + employer,
      can_preview: draft.status === 'approved' && lines.length > 0 && earnings + employer > 0n && complete && overlaps.length === 0 && manualJournalCount === 0 && blockers.length === 0,
      authority: 'informational_only',
      posting_revalidation_required: true,
      posting_revalidation: 'Posting reloads and revalidates payroll lines, mappings, account status and types, ECC overlaps, manual-journal review conditions, and other blockers inside its transaction.',
      side_effects: false,
    };
  }
}
