import { describe, expect, it } from 'vitest';
import { withZakatWorksheet } from '../src/modules/annual-closing/annual-closing.service';
import { calculationGate, scopeProblems, suggestClass } from '../src/modules/zakat-worksheets/zakat.constants';

const ready = { ready: true, blocker_count: 0, status: 'ready' as const, summary: { calculation_performed: false, blockers: '' } };

describe('Zakat worksheet readiness helpers', () => {
  it('leaves companies without a worksheet untouched', () => {
    expect(withZakatWorksheet(ready, null)).toBe(ready);
  });
  it('downgrades a ready section to needs_review (never blocked) while worksheet blockers remain, and exposes the approved fingerprint', () => {
    const out = withZakatWorksheet(ready, { blockers: ['zakat_worksheet_not_approved'], summary: { zakat_worksheet_fingerprint: 'abc', zakat_calculation_status: 'blocked' } });
    expect(out).toMatchObject({ ready: false, status: 'needs_review', blocker_count: 0 });
    expect(out.summary).toMatchObject({ blockers: 'zakat_worksheet_not_approved', zakat_worksheet_fingerprint: 'abc' });
  });
  it('keeps a ready section ready when the worksheet is approved and current, and never relaxes a blocked one', () => {
    expect(withZakatWorksheet(ready, { blockers: [], summary: { zakat_worksheet_fingerprint: 'abc' } }).status).toBe('ready');
    const blocked = { ...ready, ready: false, blocker_count: 1, status: 'blocked' as const };
    expect(withZakatWorksheet(blocked, { blockers: [], summary: {} }).status).toBe('blocked');
  });
});

describe('Zakat calculation safety gate', () => {
  it('is always blocked, has no payable amount and lists the unverified regulatory gates', () => {
    const gate = calculationGate();
    expect(gate.status).toBe('blocked');
    expect(gate.payable_amount).toBeNull();
    expect(gate.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['B0', 'B3', 'B4', 'B7']));
    expect(gate.blockers.every((b) => b.status === 'unverified')).toBe(true);
  });
  it('supports only standard 12-month years starting in 2024 or later', () => {
    expect(scopeProblems('2024-01-01', '2024-12-31')).toEqual([]);
    expect(scopeProblems('2025-07-01', '2026-06-30')).toEqual([]);
    expect(scopeProblems('2023-01-01', '2023-12-31')).toContain('fiscal_year_before_2024');
    expect(scopeProblems('2026-01-01', '2026-06-30')).toContain('fiscal_year_not_12_months');
    expect(scopeProblems('2026-01-01', '2027-06-30')).toContain('fiscal_year_not_12_months');
  });
  it('only suggests classifications; balance-sheet categories only', () => {
    expect(suggestClass('equity')?.zakat_class).toBe('addition_equity');
    expect(suggestClass('revenue')).toBeNull();
  });
});
