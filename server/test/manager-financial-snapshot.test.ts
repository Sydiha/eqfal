import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { ManagerFinancialSnapshotService } from '../src/modules/manager-financial-snapshot/manager-financial-snapshot.router';

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
});
