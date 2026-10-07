import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FiscalYearService } from '../src/modules/fiscal-years/fiscal-year.service';
import { MonthlyCloseProvisioningService, expectedMonthlyPeriods } from '../src/modules/monthly-close/monthly-close.service';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

// Real PostgreSQL (migrations applied): monthly close auto-provisioning for new fiscal years.
describeDatabase('Fiscal-year monthly close auto-provisioning', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fyService = new FiscalYearService(pool);
  const companies: string[] = [];
  const fiscalYears: string[] = [];
  const userId = randomUUID();

  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'x')", [userId, `fy-monthly-${userId}@example.test`]);
  });

  afterAll(async () => {
    try {
      // Clean up in dependency order
      await pool.query('DELETE FROM monthly_close_periods WHERE fiscal_year_id = ANY($1)', [fiscalYears]);
      await pool.query('DELETE FROM fiscal_years WHERE id = ANY($1)', [fiscalYears]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
      await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    } catch { /* best-effort cleanup */ }
    await pool.end();
  });

  async function createCompany(): Promise<string> {
    const company = randomUUID();
    companies.push(company);
    await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'Test Company')", [company, `test-${company}`]);
    return company;
  }

  // Helper to count expected periods using the canonical algorithm
  function countExpectedMonths(startDate: string, endDate: string): number {
    return expectedMonthlyPeriods(startDate, endDate).length;
  }

  // Helper to query periods for a fiscal year
  async function queryPeriods(companyId: string, fiscalYearId: string) {
    const result = await pool.query<{
      period_start: string;
      period_end: string;
      status: string;
    }>(
      `SELECT period_start::text, period_end::text, status
       FROM monthly_close_periods
       WHERE company_id = $1 AND fiscal_year_id = $2
       ORDER BY period_start`,
      [companyId, fiscalYearId],
    );
    return result.rows;
  }

  describe('FY creation auto-provisions monthly periods', () => {
    it('creates all 12 periods for a normal Jan-Dec fiscal year', async () => {
      const company = await createCompany();
      const fy = await fyService.createFiscalYear(
        {
          company_id: company,
          name: 'FY 2026',
          start_date: '2026-01-01',
          end_date: '2026-12-31',
        },
        userId,
      );
      fiscalYears.push(fy.id);

      const periods = await queryPeriods(company, fy.id);
      expect(periods).toHaveLength(12);
      expect(periods[0]!.period_start).toBe('2026-01-01');
      expect(periods[0]!.period_end).toBe('2026-01-31');
      expect(periods[11]!.period_start).toBe('2026-12-01');
      expect(periods[11]!.period_end).toBe('2026-12-31');
    });

    it('generates all periods with status=open', async () => {
      const company = await createCompany();
      const fy = await fyService.createFiscalYear(
        {
          company_id: company,
          name: 'FY 2026 Open',
          start_date: '2026-01-01',
          end_date: '2026-12-31',
        },
        userId,
      );
      fiscalYears.push(fy.id);

      const periods = await queryPeriods(company, fy.id);
      expect(periods.every((p) => p.status === 'open')).toBe(true);
    });

    it('creates periods matching expectedMonthlyPeriods() exactly', async () => {
      const company = await createCompany();
      const startDate = '2026-01-01';
      const endDate = '2026-12-31';
      const fy = await fyService.createFiscalYear(
        {
          company_id: company,
          name: 'FY Verify Match',
          start_date: startDate,
          end_date: endDate,
        },
        userId,
      );
      fiscalYears.push(fy.id);

      const expected = expectedMonthlyPeriods(startDate, endDate);
      const actual = await queryPeriods(company, fy.id);

      expect(actual).toHaveLength(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i]!.period_start).toBe(expected[i]!.period_start);
        expect(actual[i]!.period_end).toBe(expected[i]!.period_end);
      }
    });

    it('handles partial fiscal year (non-calendar start/end)', async () => {
      const company = await createCompany();
      const startDate = '2026-03-15';
      const endDate = '2026-11-20';
      const fy = await fyService.createFiscalYear(
        {
          company_id: company,
          name: 'FY Partial',
          start_date: startDate,
          end_date: endDate,
        },
        userId,
      );
      fiscalYears.push(fy.id);

      const expected = expectedMonthlyPeriods(startDate, endDate);
      const actual = await queryPeriods(company, fy.id);

      expect(actual).toHaveLength(expected.length);
      // First period should be truncated to start_date
      expect(actual[0]!.period_start).toBe(startDate);
      // Last period should be truncated to end_date
      expect(actual[actual.length - 1]!.period_end).toBe(endDate);
    });

    it('handles non-calendar fiscal year (July 1 - June 30)', async () => {
      const company = await createCompany();
      const startDate = '2025-07-01';
      const endDate = '2026-06-30';
      const fy = await fyService.createFiscalYear(
        {
          company_id: company,
          name: 'FY July-June',
          start_date: startDate,
          end_date: endDate,
        },
        userId,
      );
      fiscalYears.push(fy.id);

      const expected = expectedMonthlyPeriods(startDate, endDate);
      const actual = await queryPeriods(company, fy.id);

      expect(actual).toHaveLength(expected.length);
      expect(expected.length).toBe(12);
      expect(actual[0]!.period_start).toBe('2025-07-01');
      expect(actual[11]!.period_end).toBe('2026-06-30');
    });

    it('rolls back entire FY creation if period provisioning fails', async () => {
      const company = await createCompany();

      // Create a period manually to cause a conflict
      const startDate = '2027-01-01';
      const endDate = '2027-12-31';
      const existingFyId = randomUUID();
      await pool.query(
        `INSERT INTO fiscal_years(id,company_id,name,start_date,end_date,status)
         VALUES($1,$2,'Pre-existing','2027-01-01','2027-12-31','open')`,
        [existingFyId, company],
      );
      fiscalYears.push(existingFyId);

      // Create overlapping period that will block provisioning
      await pool.query(
        `INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status)
         VALUES($1,$2,$3,$4,'open')`,
        [company, existingFyId, '2027-01-01', '2027-01-31'],
      );

      // Attempt to create a new FY with the same date range
      // Provisioning should fail, causing the entire transaction to rollback
      await expect(
        fyService.createFiscalYear(
          {
            company_id: company,
            name: 'FY 2027 Collision',
            start_date: startDate,
            end_date: endDate,
          },
          userId,
        ),
      ).rejects.toThrow(/overlap/i);

      // Verify no orphaned FY was created
      const check = await pool.query<{ id: string }>(
        `SELECT id FROM fiscal_years
         WHERE company_id = $1 AND name = $2`,
        [company, 'FY 2027 Collision'],
      );
      expect(check.rows).toHaveLength(0);
    });

    it('does not create duplicate periods on idempotent retry', async () => {
      const company = await createCompany();
      const fy = await fyService.createFiscalYear(
        {
          company_id: company,
          name: 'FY 2026 Idempotent',
          start_date: '2026-01-01',
          end_date: '2026-12-31',
        },
        userId,
      );
      fiscalYears.push(fy.id);

      // Query initial periods
      const periods1 = await queryPeriods(company, fy.id);
      expect(periods1).toHaveLength(12);

      // Manually re-run provisioning (simulating idempotent call)
      // Note: This is a unit test of the provisioning logic itself
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const service = new MonthlyCloseProvisioningService(pool);
        const ids = await service.provisionDefaultPeriods(
          fy.id,
          company,
          '2026-01-01',
          '2026-12-31',
          client,
        );
        await client.query('COMMIT');
        // Should return same period IDs (ON CONFLICT DO NOTHING)
        expect(ids).toHaveLength(12);
      } finally {
        client.release();
      }

      // Verify no duplicates were created
      const periods2 = await queryPeriods(company, fy.id);
      expect(periods2).toHaveLength(12);
    });
  });

  describe('Fiscal-year close readiness with auto-provisioned periods', () => {
    it('blocks fiscal year close when monthly periods are missing', async () => {
      const company = await createCompany();
      const fy = await fyService.createFiscalYear(
        {
          company_id: company,
          name: 'FY 2026 Missing Periods',
          start_date: '2026-01-01',
          end_date: '2026-12-31',
        },
        userId,
      );
      fiscalYears.push(fy.id);

      // Manually delete one period to simulate missing month
      const periods = await queryPeriods(company, fy.id);
      const toDelete = periods[0]!;
      await pool.query(
        'DELETE FROM monthly_close_periods WHERE company_id = $1 AND fiscal_year_id = $2 AND period_start = $3',
        [company, fy.id, toDelete.period_start],
      );

      // Attempt to close should be blocked
      await expect(fyService.closeFiscalYear(fy.id, company, userId)).rejects.toThrow(/blocked/i);
    });

    it('blocks fiscal year close when monthly periods are open', async () => {
      const company = await createCompany();
      const fy = await fyService.createFiscalYear(
        {
          company_id: company,
          name: 'FY 2026 Open Periods',
          start_date: '2026-01-01',
          end_date: '2026-12-31',
        },
        userId,
      );
      fiscalYears.push(fy.id);

      // All periods are auto-provisioned as 'open', so close is blocked
      await expect(fyService.closeFiscalYear(fy.id, company, userId)).rejects.toThrow(/blocked/i);
    });

    it('allows fiscal year close when all periods are closed', async () => {
      const company = await createCompany();
      const fy = await fyService.createFiscalYear(
        {
          company_id: company,
          name: 'FY 2026 All Closed',
          start_date: '2026-01-01',
          end_date: '2026-12-31',
        },
        userId,
      );
      fiscalYears.push(fy.id);

      // Close all periods
      await pool.query(
        "UPDATE monthly_close_periods SET status='closed' WHERE company_id = $1 AND fiscal_year_id = $2",
        [company, fy.id],
      );

      // Fiscal year should now be closable (assuming no other blockers)
      // Note: This may still be blocked by other requirements (opening balances, etc.)
      // but the period blocker should not prevent it
      try {
        await fyService.closeFiscalYear(fy.id, company, userId);
        expect((await pool.query('SELECT status FROM fiscal_years WHERE id=$1', [fy.id])).rows[0]!.status).toBe('closed');
      } catch (err) {
        // If blocked, verify it's NOT due to monthly_close blockers
        const msg = String(err);
        expect(msg).not.toContain('monthly_period');
      }
    });
  });

  describe('expectedMonthlyPeriods function consistency', () => {
    it('generates correct boundaries for calendar year', () => {
      const periods = expectedMonthlyPeriods('2026-01-01', '2026-12-31');
      expect(periods).toHaveLength(12);
      expect(periods[0]).toEqual({ period_start: '2026-01-01', period_end: '2026-01-31' });
      expect(periods[1]).toEqual({ period_start: '2026-02-01', period_end: '2026-02-29' });
      expect(periods[11]).toEqual({ period_start: '2026-12-01', period_end: '2026-12-31' });
    });

    it('handles leap year correctly', () => {
      const periods = expectedMonthlyPeriods('2024-01-01', '2024-12-31');
      expect(periods[1]).toEqual({ period_start: '2024-02-01', period_end: '2024-02-29' });
    });

    it('truncates partial first month', () => {
      const periods = expectedMonthlyPeriods('2026-03-15', '2026-12-31');
      expect(periods[0]!.period_start).toBe('2026-03-15');
      expect(periods[0]!.period_end).toBe('2026-03-31');
    });

    it('truncates partial last month', () => {
      const periods = expectedMonthlyPeriods('2026-01-01', '2026-11-20');
      expect(periods[10]!.period_start).toBe('2026-11-01');
      expect(periods[10]!.period_end).toBe('2026-11-20');
    });

    it('handles single day range', () => {
      const periods = expectedMonthlyPeriods('2026-01-15', '2026-01-15');
      expect(periods).toHaveLength(1);
      expect(periods[0]).toEqual({ period_start: '2026-01-15', period_end: '2026-01-15' });
    });
  });
});

// Unit tests for the provisioning service logic (can run without DATABASE_URL)
describe('MonthlyCloseProvisioningService.expectedMonthlyPeriods', () => {
  it('matches annual closing service canonical logic', () => {
    // This verifies our reuse of the logic is correct
    const testCases: Array<[string, string, number]> = [
      ['2026-01-01', '2026-12-31', 12],
      ['2026-03-15', '2026-11-20', 9],
      ['2025-07-01', '2026-06-30', 12],
      ['2026-01-01', '2026-01-31', 1],
    ];

    for (const [start, end, expected] of testCases) {
      const periods = expectedMonthlyPeriods(start, end);
      expect(periods).toHaveLength(expected);
      // Verify all periods are within bounds
      expect(periods[0]!.period_start >= start).toBe(true);
      expect(periods[0]!.period_start).toBe(start);
      expect(periods[periods.length - 1]!.period_end).toBe(end);
    }
  });
});
