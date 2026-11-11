import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';

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
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
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

  async preview(companyId: string, draftId: string) {
    const draft = (await this.db.query<{ id: string; period_month: string; currency_code: string; status: string }>(
      'SELECT id,period_month::text,currency_code,status FROM payroll_drafts WHERE id=$1 AND company_id=$2', [draftId, companyId])).rows[0];
    if (!draft) throw new PayrollAccountingError('PAYROLL_NOT_FOUND', 404);
    const blockers: Array<{ code: string; count?: number; details?: unknown[] }> = [];
    if (draft.status !== 'approved') blockers.push({ code: 'payroll_not_approved' });

    const lines = (await this.db.query<{ employee_id: string; salary: string; allowances: string; bonus: string; overtime: string; deductions: string; employer_contributions: string }>(
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

    const configured = (await this.db.query<{ mapping_key: PayrollMappingKey; account_id: string; code: string; name: string; name_ar: string | null; account_type: string; is_active: boolean }>(
      `SELECT m.mapping_key,m.account_id,a.code,a.name,a.name_ar,a.account_type,a.is_active
       FROM payroll_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id WHERE m.company_id=$1`, [companyId])).rows;
    const byKey = new Map(configured.map(x => [x.mapping_key, x]));
    for (const required of PAYROLL_ACCOUNT_MAPPINGS) {
      const row = byKey.get(required.key);
      if (!row) blockers.push({ code: 'mapping_missing', details: [{ mapping_key: required.key }] });
      else if (!row.is_active) blockers.push({ code: 'mapping_account_inactive', details: [{ mapping_key: required.key }] });
      else if (row.account_type !== required.type) blockers.push({ code: 'mapping_account_type_invalid', details: [{ mapping_key: required.key }] });
    }

    const overlaps = (await this.db.query<{ employee_id: string; employee_number: string; display_name: string; category: string; amount: string }>(
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

    const manual = (await this.db.query<{ count: string }>(
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
      can_preview: draft.status === 'approved' && lines.length > 0 && earnings + employer > 0n && complete && overlaps.length === 0 && manualJournalCount === 0,
      authority: 'informational_only',
      posting_revalidation_required: true,
      posting_revalidation: 'A future posting operation must transactionally reload and revalidate payroll lines, mappings, account status and types, ECC overlaps, manual-journal review conditions, and all other blockers before creating a journal.',
      side_effects: false,
    };
  }
}
