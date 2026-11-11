import { PoolClient } from 'pg';

/** Serializes payroll posting with ECC approvals for each company/month. Acquire after fiscal-year locks. */
export async function lockPayrollEccMonths(client: PoolClient, companyId: string, months: string[]): Promise<void> {
  for (const month of [...new Set(months.map(m => m.slice(0, 7)))].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payroll-ecc:${companyId}:${month}`]);
  }
}
