import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

const calls: string[] = [];
vi.mock('../src/modules/vat/vat.router', () => ({
  lockVatPeriodScope: vi.fn(async (_c: string, start: string, end: string) => { calls.push(`vat:${start}:${end}`); }),
}));
vi.mock('../src/modules/monthly-close/accounting-period.guard', () => ({
  lockAccountingRange: vi.fn(async (_c: string, start: string, end: string) => { calls.push(`accounting:${start}:${end}`); }),
}));

import { lockFiscalYearCloseScope } from '../src/modules/fiscal-years/fiscal-year-close-readiness';

describe('lockFiscalYearCloseScope', () => {
  it('takes VAT scope locks before accounting-range locks, both over the fiscal-year bounds', async () => {
    calls.length = 0;
    await lockFiscalYearCloseScope({} as PoolClient, 'company', { id: 'fy', start_date: '2026-01-01', end_date: '2026-12-31' });
    expect(calls).toEqual(['vat:2026-01-01:2026-12-31', 'accounting:2026-01-01:2026-12-31']);
  });
});
