import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  AccountingFiscalYearClosedError,
  AccountingPeriodClosedError,
  assertAccountingDateWritable,
  assertAccountingRangeWritable,
  lockAccountingRange,
} from '../src/modules/monthly-close/accounting-period.guard';

type Years = Record<string, unknown>[];

function clientWithClosedResult(rowCount = 0, years: Years = []) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('closed-year-guard')) return { rows: years, rowCount: years.length };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM monthly_close_periods')) return { rows: rowCount ? [{ one: 1 }] : [], rowCount };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { client: { query } as unknown as PoolClient, query };
}

describe('accounting period guard date normalization', () => {
  it('accepts PostgreSQL DATE values returned as Date objects', async () => {
    const { client, query } = clientWithClosedResult();

    await expect(
      assertAccountingDateWritable('company-1', new Date('2026-02-15T00:00:00.000Z'), client),
    ).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM monthly_close_periods'),
      ['company-1', '2026-02-15'],
    );
  });

  it('normalizes Date objects when locking an accounting range', async () => {
    const { client, query } = clientWithClosedResult();

    await lockAccountingRange(
      'company-1',
      new Date('2026-01-31T00:00:00.000Z'),
      new Date('2026-03-01T00:00:00.000Z'),
      client,
    );

    const lockKeys = query.mock.calls
      .filter(([sql]) => String(sql).includes('pg_advisory_xact_lock'))
      .map(([, params]) => (params as string[])[0]);
    expect(lockKeys).toEqual([
      'accounting-period:company-1:2026-01',
      'accounting-period:company-1:2026-02',
      'accounting-period:company-1:2026-03',
    ]);
  });

  it('still rejects writes inside a closed period after normalization', async () => {
    const { client } = clientWithClosedResult(1);

    await expect(
      assertAccountingDateWritable('company-1', new Date('2026-02-15T00:00:00.000Z'), client),
    ).rejects.toBeInstanceOf(AccountingPeriodClosedError);
  });
});

describe('independent closed-fiscal-year guard', () => {
  const open = [{ status: 'open' }];
  const closed = [{ status: 'closed' }];

  it('rejects a date in a closed fiscal year even when the month is open', async () => {
    const { client } = clientWithClosedResult(0, closed);
    const failure = await assertAccountingDateWritable('company-1', '2026-02-15', client).catch(e => e);
    expect(failure).toBeInstanceOf(AccountingFiscalYearClosedError);
    expect(failure).toBeInstanceOf(AccountingPeriodClosedError);
    expect(failure.code).toBe('FISCAL_YEAR_CLOSED');
  });

  it('rejects a date in a closed fiscal year when the month is also closed', async () => {
    const { client } = clientWithClosedResult(1, closed);
    await expect(assertAccountingDateWritable('company-1', '2026-02-15', client)).rejects.toBeInstanceOf(AccountingFiscalYearClosedError);
  });

  it('keeps the existing behaviour in an open year with an open month', async () => {
    const { client } = clientWithClosedResult(0, open);
    await expect(assertAccountingDateWritable('company-1', '2026-02-15', client)).resolves.toBeUndefined();
  });

  it('keeps the monthly rejection in an open year with a closed month', async () => {
    const { client } = clientWithClosedResult(1, open);
    const failure = await assertAccountingDateWritable('company-1', '2026-02-15', client).catch(e => e);
    expect(failure).toBeInstanceOf(AccountingPeriodClosedError);
    expect(failure).not.toBeInstanceOf(AccountingFiscalYearClosedError);
    expect(failure.code).toBe('ACCOUNTING_PERIOD_CLOSED');
  });

  it('allows a date that is outside every fiscal year (no year row)', async () => {
    const { client } = clientWithClosedResult(0, []);
    await expect(assertAccountingDateWritable('company-1', '2030-01-01', client)).resolves.toBeUndefined();
  });

  it('rejects a range that crosses from an open year into a closed one', async () => {
    const { client } = clientWithClosedResult(0, [{ status: 'open' }, { status: 'closed' }]);
    await expect(assertAccountingRangeWritable('company-1', '2026-12-15', '2027-01-15', client)).rejects.toBeInstanceOf(AccountingFiscalYearClosedError);
  });

  it('scopes the year lookup to the company, checks it before the month locks, and takes the year FOR SHARE', async () => {
    const { client, query } = clientWithClosedResult(0, open);
    await assertAccountingRangeWritable('company-1', '2026-12-15', '2027-01-15', client);
    const [first, ...rest] = query.mock.calls;
    expect(String(first![0])).toContain('closed-year-guard');
    expect(String(first![0])).toContain('FOR SHARE');
    expect(first![1]).toEqual(['company-1', '2026-12-15', '2027-01-15']);
    expect(String(rest[0]![0])).toContain('pg_advisory_xact_lock');
  });

  it('does not touch another company: only the requested company id is ever passed', async () => {
    const { client, query } = clientWithClosedResult(0, open);
    await assertAccountingDateWritable('company-A', '2026-02-15', client);
    for (const [sql, params] of query.mock.calls) {
      if (String(sql).includes('pg_advisory_xact_lock')) expect(String((params as string[])[0])).toContain('company-A');
      else expect((params as string[])[0]).toBe('company-A');
    }
  });
});
