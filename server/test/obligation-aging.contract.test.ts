import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agingBucket } from '../src/modules/obligations/obligation-aging';

describe('obligation aging contract', () => {
  it('uses fixed bucket boundaries on days past due', () => {
    expect([-5, 0, 1, 30, 31, 60, 61, 90, 91].map(agingBucket)).toEqual([
      'current', 'current', 'days_1_30', 'days_1_30', 'days_31_60', 'days_31_60', 'days_61_90', 'days_61_90', 'days_over_90',
    ]);
  });

  it('is a read-only, company-scoped endpoint behind obligation.view with a server-side as-of date', () => {
    const source = readFileSync(new URL('../src/modules/obligations/obligation-aging.ts', import.meta.url), 'utf8');
    expect(source).toContain("obligationAgingRouter.get('/obligations/aging', requireAuth, requireActiveCompany, requireCapability('obligation.view')");
    expect(source).not.toMatch(/obligationAgingRouter\.(post|put|patch|delete)\(/);
    expect(source).toContain('WHERE o.company_id=$1');
    expect(source).toContain("raw ?? operationalDate()");
    expect(source).toContain('t.transaction_date<=$2::date');
  });
});
