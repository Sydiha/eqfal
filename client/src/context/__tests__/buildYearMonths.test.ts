import { describe, expect, it } from 'vitest';
import { buildYearMonths, isMonthOnlyPeriodId, type FiscalYear, type Period } from '../DateContext';

const year: FiscalYear = { id: 'fy', company_id: 'c', name: '2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' };
const real = (month: string, end: string): Period => ({ id: `real-${month}`, fiscal_year_id: 'fy', period_start: `2026-${month}-01`, period_end: end, status: 'open' });

describe('buildYearMonths', () => {
  it('exposes January-December even when only some monthly-close records exist', () => {
    const months = buildYearMonths(year, [real('03', '2026-03-31'), real('07', '2026-07-31')]);
    expect(months).toHaveLength(12);
    expect(months.map(m => m.period_start.slice(0, 7))).toEqual(
      ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map(m => `2026-${m}`),
    );
    expect(months[2].id).toBe('real-03');
    expect(months[0]).toMatchObject({ id: 'month:2026-01', period_start: '2026-01-01', period_end: '2026-01-31', fiscal_year_id: 'fy' });
    expect(isMonthOnlyPeriodId(months[0].id)).toBe(true);
    expect(isMonthOnlyPeriodId(months[2].id)).toBe(false);
  });

  it('never duplicates a month that already has a monthly-close record', () => {
    const months = buildYearMonths(year, [real('02', '2026-02-28')]);
    expect(months.filter(m => m.period_start.startsWith('2026-02'))).toHaveLength(1);
  });

  it('clips months to a fiscal year that does not start on the first of a month', () => {
    const odd = { ...year, start_date: '2026-04-15', end_date: '2027-04-14' };
    const months = buildYearMonths(odd, []);
    expect(months[0]).toMatchObject({ period_start: '2026-04-15', period_end: '2026-04-30' });
    expect(months[months.length - 1]).toMatchObject({ period_start: '2027-04-01', period_end: '2027-04-14' });
    expect(months).toHaveLength(13);
  });

  it('returns the real periods unchanged when the fiscal year is unknown', () => {
    const periods = [real('01', '2026-01-31')];
    expect(buildYearMonths(undefined, periods)).toBe(periods);
  });
});
