import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  AccountingPeriodClosedError,
  assertAccountingDateWritable,
  lockAccountingRange,
} from '../src/modules/monthly-close/accounting-period.guard';

function clientWithClosedResult(rowCount = 0) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
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
