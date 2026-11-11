import { PoolClient } from 'pg';

/** Categories represented by payroll's financial journal, including employee withholding. */
export const PAYROLL_ECC_CATEGORIES = ['salary','allowances','bonus','overtime','employer_gosi','employee_deduction'] as const;

/** Called after locking every allocation month; matches the payroll posting overlap predicate. */
export async function hasPostedPayrollOverlap(client: PoolClient, companyId: string, costId: string): Promise<boolean> {
  const result = await client.query<{overlap:boolean}>(`
    SELECT EXISTS (
      SELECT 1 FROM employee_cost_records r
      JOIN employee_cost_allocations a ON a.company_id=r.company_id AND a.cost_record_id=r.id
      JOIN payroll_drafts d ON d.company_id=r.company_id AND d.period_month=a.allocation_month AND d.currency_code=r.currency_code
      JOIN payroll_draft_employees p ON p.company_id=d.company_id AND p.draft_id=d.id AND p.employee_id=r.employee_id
      JOIN journal_entries j ON j.company_id=d.company_id AND j.source_type='payroll' AND j.source_id=d.id AND j.status='posted'
      WHERE r.company_id=$1 AND r.id=$2 AND r.category=ANY($3::text[])
    ) AS overlap`, [companyId,costId,PAYROLL_ECC_CATEGORIES]);
  return result.rows[0]!.overlap;
}

/** Serializes payroll posting with ECC approvals for each company/month. Acquire after fiscal-year locks. */
export async function lockPayrollEccMonths(client: PoolClient, companyId: string, months: string[]): Promise<void> {
  for (const month of [...new Set(months.map(m => m.slice(0, 7)))].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payroll-ecc:${companyId}:${month}`]);
  }
}
