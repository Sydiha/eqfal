import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { FiscalYearRepository } from '../src/modules/fiscal-years/fiscal-year.repository';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';

describe('FiscalYearRepository', () => {
  it('formats company fiscal-year dates deterministically and orders by the date column', async () => {
    const fiscalYear = {
      id: '00000000-0000-4000-8000-000000000002',
      company_id: COMPANY_ID,
      name: 'FY 2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      status: 'open',
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
    };
    const query = vi.fn().mockResolvedValue({ rows: [fiscalYear], rowCount: 1 });
    const repository = new FiscalYearRepository({ query } as unknown as Pool);

    const result = await repository.findByCompany(COMPANY_ID);

    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    // PostgreSQL's date-to-text cast follows the connection DateStyle (for
    // example, SQL, DMY would produce 01/01/2026). An explicit to_char mask
    // makes the API contract independent of that setting.
    expect(sql).toMatch(
      /to_char\(start_date,\s*'YYYY-MM-DD'\)\s+AS\s+start_date/i,
    );
    expect(sql).toMatch(
      /to_char\(end_date,\s*'YYYY-MM-DD'\)\s+AS\s+end_date/i,
    );
    expect(sql).not.toMatch(/(?:start_date|end_date)::text/i);
    expect(sql).toMatch(/ORDER\s+BY\s+fiscal_years\.start_date/i);
    expect(parameters).toEqual([COMPANY_ID]);
    expect(result).toEqual([expect.objectContaining({
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    })]);
    expect(result[0]?.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result[0]?.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
