import { PoolClient } from 'pg';
import { expectedMonthlyPeriods } from '../../shared/expected-monthly-periods';

/**
 * Monthly-close period provisioning.
 *
 * Called by FiscalYearService.createFiscalYear on the SAME transaction client,
 * so a provisioning failure rolls back the fiscal year too. Period boundaries
 * come from the shared expectedMonthlyPeriods(), identical to the logic the
 * fiscal-year close readiness uses.
 */
export class MonthlyCloseProvisioningService {
  /**
   * Insert every expected monthly period (status 'open') for a fiscal year.
   *
   * Conflict target is the real unique constraint
   * UNIQUE (company_id, period_start, period_end) from migration 019.
   * - Row already present for THIS fiscal year (full retry): skipped, not returned.
   * - Row present under a DIFFERENT fiscal year: throws (duplicate month).
   * No audit events are written: open periods are provisioned, not closed/reopened.
   *
   * @returns IDs of the periods newly created by this call.
   */
  async provisionDefaultPeriods(
    fiscalYearId: string,
    companyId: string,
    startDate: string,
    endDate: string,
    client: PoolClient,
  ): Promise<string[]> {
    const createdIds: string[] = [];
    for (const period of expectedMonthlyPeriods(startDate, endDate)) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO monthly_close_periods(company_id, fiscal_year_id, period_start, period_end, status)
         VALUES($1, $2, $3, $4, 'open')
         ON CONFLICT (company_id, period_start, period_end) DO NOTHING
         RETURNING id`,
        [companyId, fiscalYearId, period.period_start, period.period_end],
      );
      if (inserted.rows[0]) {
        createdIds.push(inserted.rows[0].id);
        continue;
      }
      const existing = await client.query<{ fiscal_year_id: string }>(
        `SELECT fiscal_year_id FROM monthly_close_periods
         WHERE company_id = $1 AND period_start = $2 AND period_end = $3`,
        [companyId, period.period_start, period.period_end],
      );
      const row = existing.rows[0];
      if (row && row.fiscal_year_id !== fiscalYearId) {
        throw new Error(
          `Monthly close period [${period.period_start}, ${period.period_end}] already exists under another fiscal year`,
        );
      }
    }
    return createdIds;
  }
}
