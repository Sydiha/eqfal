import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';

/**
 * Reuse the canonical month-boundary logic from annual closing service.
 * Ensures period generation and close readiness always agree on expected periods.
 */
export function expectedMonthlyPeriods(start: string, end: string) {
  const periods: Array<{ period_start: string; period_end: string }> = [];
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.toISOString().slice(0, 10) <= end) {
    const monthStart = cursor.toISOString().slice(0, 10);
    const next = new Date(cursor);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const monthEndDate = new Date(next);
    monthEndDate.setUTCDate(0);
    const monthEnd = monthEndDate.toISOString().slice(0, 10);
    periods.push({
      period_start: monthStart < start ? start : monthStart,
      period_end: monthEnd > end ? end : monthEnd,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return periods;
}

type MonthlyClosePeriod = {
  id: string;
  company_id: string;
  fiscal_year_id: string;
  period_start: string;
  period_end: string;
  status: 'open' | 'closed';
  created_at: Date;
  updated_at: Date;
};

/**
 * Service for monthly close period provisioning and lifecycle management.
 *
 * The `provisionDefaultPeriods` method is called during fiscal year creation
 * to atomically create all expected monthly periods within the same transaction.
 */
export class MonthlyCloseProvisioningService {
  private readonly audit = new AuditLogRepository();

  constructor(private readonly db: Pool) {}

  /**
   * Auto-provision all expected monthly periods for a fiscal year.
   *
   * Called during fiscal year creation in the same transaction. If provisioning
   * fails, the entire fiscal year creation rolls back.
   *
   * @param fiscalYearId - ID of the fiscal year
   * @param companyId - ID of the company
   * @param startDate - Start date of fiscal year (YYYY-MM-DD)
   * @param endDate - End date of fiscal year (YYYY-MM-DD)
   * @param client - PoolClient within the transaction
   * @returns Array of created period IDs
   * @throws Error if period provisioning fails (causes rollback)
   */
  async provisionDefaultPeriods(
    fiscalYearId: string,
    companyId: string,
    startDate: string,
    endDate: string,
    client: PoolClient,
  ): Promise<string[]> {
    // Generate canonical expected periods using same logic as close readiness
    const expectedPeriods = expectedMonthlyPeriods(startDate, endDate);

    // Create all periods in the same transaction
    // Use ON CONFLICT DO NOTHING to be idempotent.
    const createdIds: string[] = [];

    for (const period of expectedPeriods) {
      const result = await client.query<MonthlyClosePeriod>(
        `INSERT INTO monthly_close_periods(company_id, fiscal_year_id, period_start, period_end, status, created_at, updated_at)
         VALUES($1, $2, $3, $4, 'open', NOW(), NOW())
         ON CONFLICT (company_id, fiscal_year_id, period_start, period_end) DO NOTHING
         RETURNING id, company_id, fiscal_year_id, period_start::text, period_end::text, status, created_at, updated_at`,
        [companyId, fiscalYearId, period.period_start, period.period_end],
      );

      // If the insert returned a row, we created it; record the ID
      if (result.rowCount && result.rowCount > 0) {
        createdIds.push(result.rows[0]!.id);
      }
      // If rowCount is 0, either the period already exists (idempotent, no error)
      // or there's a conflict with a different period. In either case, we proceed
      // and let the fiscal year close readiness check deal with missing/conflicting periods.
    }

    return createdIds;
  }
}
