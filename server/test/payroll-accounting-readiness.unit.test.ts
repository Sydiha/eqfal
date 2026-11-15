import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PayrollAccountingService } from '../src/modules/payroll/payroll-accounting';

const mappingKeys = [
  ['earnings_expense', 'expense'],
  ['employer_contribution_expense', 'expense'],
  ['net_payroll_liability', 'liability'],
  ['employee_deduction_liability', 'liability'],
  ['employer_contribution_liability', 'liability'],
];

function serviceWithRows(overlaps: unknown[] = [], recoveryAmount='0.00') {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM payroll_employee_advance_recoveries')) return { rows: [{ amount: recoveryAmount }] };
    if (sql.includes('FROM employee_salary_advance_account_mappings')) return { rows: recoveryAmount==='0.00'?[]:[{account_id:'advance-receivable',is_active:true,account_type:'asset'}] };
    if (sql.includes('FROM payroll_drafts')) return { rows: [{ id: 'draft-1', period_month: '2026-11-01', currency_code: 'SAR', status: 'approved' }] };
    if (sql.includes('FROM employee_cost_records r')) return { rows: overlaps };
    if (sql.includes('FROM payroll_draft_employees')) return { rows: [{ employee_id: 'employee-1', salary: '100.00', allowances: '0.00', bonus: '0.00', overtime: '0.00', deductions: '0.00', employer_contributions: '0.00' }] };
    if (sql.includes('FROM payroll_account_mappings')) return { rows: mappingKeys.map(([mapping_key, account_type]) => ({ mapping_key, account_id: `account-${mapping_key}`, code: '5000', name: 'Payroll', name_ar: null, account_type, is_active: true })) };
    if (sql.includes('FROM journal_entries')) return { rows: [{ count: '1' }] };
    throw new Error(`Unexpected readiness query: ${sql}`);
  });
  return new PayrollAccountingService({ query } as unknown as Pool);
}

describe('payroll accounting readiness warning separation', () => {
  it('keeps unrelated source-less journals as warnings without blocking preview', async () => {
    const preview = await serviceWithRows().preview('company-1', 'draft-1');
    expect(preview.can_preview, JSON.stringify(preview)).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings).toEqual([{ code: 'manual_journal_review', count: 1 }]);
  });

  it('continues to block genuine approved employee-cost overlaps', async () => {
    const preview = await serviceWithRows([{ employee_id: 'employee-1', employee_number: 'E1', display_name: 'Employee', category: 'salary', amount: '10.00' }]).preview('company-1', 'draft-1');
    expect(preview.can_preview).toBe(false);
    expect(preview.blockers).toContainEqual(expect.objectContaining({ code: 'ecc_overlap', count: 1 }));
    expect(preview.warnings).toEqual([{ code: 'manual_journal_review', count: 1 }]);
  });

  it('credits recoveries directly to the employee advance receivable and reduces net pay', async()=>{
    const preview=await serviceWithRows([], '25.25').preview('company-1','draft-1');
    expect(preview.totals).toMatchObject({advance_recoveries:'25.25',net_payable:'74.75',employee_deductions:'0.00'});
    expect(preview.lines).toContainEqual({mapping_key:'employee_salary_advance_receivable',account_id:'advance-receivable',debit:'0.00',credit:'25.25'});
    expect(preview.balanced).toBe(true);
  });
});
