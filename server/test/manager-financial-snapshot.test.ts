import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { ManagerFinancialSnapshotService, SnapshotPeriodNotFoundError } from '../src/modules/manager-financial-snapshot/manager-financial-snapshot.router';

const poolWithRows = (...results: unknown[][]) => {
  const query = vi.fn();
  for (const rows of results) query.mockResolvedValueOnce({ rows });
  return { pool: { query } as unknown as Pool, query };
};

describe('ManagerFinancialSnapshotService', () => {
  it('scopes every authorized query to the active company and does not query hidden modules', async () => {
    const { pool, query } = poolWithRows([{ direction: 'receivable', amount: '12.34' }]);
    const result = await new ManagerFinancialSnapshotService(pool).get('company-a', ['obligation.view']);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual(['company-a']);
    expect(result.metrics.bank_balances).toEqual({ state: 'hidden' });
    expect(result.metrics.current_month_sales).toEqual({ state: 'hidden' });
    expect(result.metrics.amounts_to_collect).toEqual({ state: 'available', amount: '12.34' });
    expect(result.metrics.amounts_to_pay).toEqual({ state: 'available', amount: '0' });
  });

  it('uses only the latest available running balance and marks an account without one unavailable', async () => {
    const { pool, query } = poolWithRows([
      { id: 'bank-1', display_name: 'Operating', currency_code: 'SAR', running_balance: '900719925474099.99' },
      { id: 'bank-2', display_name: 'Reserve', currency_code: 'SAR', running_balance: null },
    ]);
    const result = await new ManagerFinancialSnapshotService(pool).get('company-a', ['bank.view']);

    expect(query.mock.calls[0]?.[0]).toMatch(/running_balance IS NOT NULL[\s\S]*ORDER BY t\.transaction_date DESC,t\.source_row_number DESC/);
    expect(query.mock.calls[0]?.[0]).toContain('WHERE a.company_id=$1');
    expect(result.metrics.bank_balances).toEqual({ state: 'available', accounts: [
      { id: 'bank-1', display_name: 'Operating', currency_code: 'SAR', balance: { state: 'available', amount: '900719925474099.99' } },
      { id: 'bank-2', display_name: 'Reserve', currency_code: 'SAR', balance: { state: 'unavailable' } },
    ] });
  });

  it('subtracts both settlement sources, excludes cancelled/unconfirmed obligations, and floors remaining at zero in exact SQL', async () => {
    const { pool, query } = poolWithRows([
      { direction: 'receivable', amount: '0.01' },
      { direction: 'payable', amount: '1234567890123456.78' },
    ]);
    const result = await new ManagerFinancialSnapshotService(pool).get('company-a', ['obligation.view']);
    const sql = String(query.mock.calls[0]?.[0]);

    expect(sql).toContain("o.source_type='document'");
    expect(sql).toContain('document_settlements');
    expect(sql).toContain('obligation_settlements');
    expect(sql).toMatch(/GREATEST\(o\.original_amount-COALESCE/);
    expect(sql).toContain('NOT o.is_cancelled');
    expect(sql).toContain("o.verification_status='confirmed'");
    expect(result.metrics.amounts_to_collect).toEqual({ state: 'available', amount: '0.01' });
    expect(result.metrics.amounts_to_pay).toEqual({ state: 'available', amount: '1234567890123456.78' });
  });

  it('totals only approved in-month sales, purchases, and expenses with PostgreSQL numeric arithmetic', async () => {
    const { pool, query } = poolWithRows([], [{ sales: '0.30', purchases_expenses: '999999999999999.99' }]);
    const result = await new ManagerFinancialSnapshotService(pool).get('company-a', ['document.view', 'obligation.view']);
    const [sql, parameters] = query.mock.calls[1] as [string, string[]];

    expect(sql).toContain("status='approved'");
    expect(sql).toContain("document_type='sale'");
    expect(sql).toContain("document_type IN ('purchase','expense')");
    expect(sql).toContain('SUM(total_amount)');
    expect(parameters[0]).toBe('company-a');
    expect(parameters[1]).toMatch(/^\d{4}-\d{2}-01$/);
    expect(parameters[2]).toMatch(/^\d{4}-\d{2}-01$/);
    expect(result.metrics.current_month_sales).toEqual({ state: 'available', amount: '0.30' });
    expect(result.metrics.current_month_purchases_expenses).toEqual({ state: 'available', amount: '999999999999999.99' });
  });

  it('derives the range from the company-scoped period and uses it for in-period totals', async () => {
    const { pool, query } = poolWithRows([{ start: '2026-03-01', next: '2026-04-01' }], [], [{ sales: '5', purchases_expenses: '2' }]);
    const result = await new ManagerFinancialSnapshotService(pool).get('company-a', ['document.view', 'obligation.view'], { periodId: 'p-1' });

    expect(query.mock.calls[0]?.[0]).toContain('company_id=$1 AND id=$2');
    expect(query.mock.calls[0]?.[1]).toEqual(['company-a', 'p-1']);
    expect(query.mock.calls[2]?.[1]).toEqual(['company-a', '2026-03-01', '2026-04-01']);
    expect(result.month).toEqual({ start: '2026-03-01', end_exclusive: '2026-04-01' });
  });

  it('rejects a period that does not belong to the active company', async () => {
    const { pool } = poolWithRows([]);
    await expect(new ManagerFinancialSnapshotService(pool).get('company-b', ['document.view'], { periodId: 'p-of-company-a' }))
      .rejects.toBeInstanceOf(SnapshotPeriodNotFoundError);
  });

  it('spans the whole fiscal year in all-periods mode', async () => {
    const { pool, query } = poolWithRows([{ start: '2026-01-01', next: '2027-01-01' }]);
    const result = await new ManagerFinancialSnapshotService(pool).get('company-a', [], { fiscalYearId: 'fy-1' });
    expect(query.mock.calls[0]?.[1]).toEqual(['company-a', 'fy-1']);
    expect(result.month.end_exclusive).toBe('2027-01-01');
  });

  it('derives whole-year bounds from the fiscal year itself, not from the monthly-close records that happen to exist', async () => {
    const { pool, query } = poolWithRows([{ start: '2026-01-01', next: '2027-01-01' }]);
    await new ManagerFinancialSnapshotService(pool).get('company-a', [], { fiscalYearId: 'fy-1' });
    expect(query.mock.calls[0]?.[0]).toContain('FROM fiscal_years WHERE company_id=$1 AND id=$2');
    expect(query.mock.calls[0]?.[0]).not.toContain('monthly_close_periods');
  });

  it('scopes one calendar month of the company fiscal year when no monthly-close record exists', async () => {
    const { pool, query } = poolWithRows([{ start: '2026-04-01', next: '2026-05-01' }], [], [{ sales: '7', purchases_expenses: '3' }]);
    const result = await new ManagerFinancialSnapshotService(pool).get('company-a', ['document.view', 'obligation.view'], { fiscalYearId: 'fy-1', month: '2026-04' });
    expect(query.mock.calls[0]?.[0]).toContain('FROM fiscal_years WHERE company_id=$1 AND id=$2');
    expect(query.mock.calls[0]?.[1]).toEqual(['company-a', 'fy-1', '2026-04-01']);
    expect(query.mock.calls[2]?.[1]).toEqual(['company-a', '2026-04-01', '2026-05-01']);
    expect(result.month).toEqual({ start: '2026-04-01', end_exclusive: '2026-05-01' });
  });

  it('rejects a month outside the company fiscal year', async () => {
    const { pool } = poolWithRows([]);
    await expect(new ManagerFinancialSnapshotService(pool).get('company-a', [], { fiscalYearId: 'fy-1', month: '2031-04' }))
      .rejects.toBeInstanceOf(SnapshotPeriodNotFoundError);
  });
});
