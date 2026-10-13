import { describe, expect, it } from 'vitest';
import { addDays, anchorDayOf, firstOccurrenceOnOrAfter, nextOccurrence } from '../src/modules/invoices/recurrence';

const series = (start: string, frequency: 'monthly' | 'quarterly' | 'annual', count: number) => {
  const anchor = anchorDayOf(start);
  const out = [start];
  while (out.length < count) out.push(nextOccurrence(out[out.length - 1]!, frequency, anchor));
  return out;
};

describe('recurrence dates', () => {
  it('monthly: a 31st clamps to short months and returns to the 31st (no drift)', () => {
    expect(series('2031-01-31', 'monthly', 6)).toEqual(['2031-01-31', '2031-02-28', '2031-03-31', '2031-04-30', '2031-05-31', '2031-06-30']);
  });
  it('monthly: leap-year February uses the 29th', () => {
    expect(series('2031-12-31', 'monthly', 4)).toEqual(['2031-12-31', '2032-01-31', '2032-02-29', '2032-03-31']);
  });
  it('monthly: a 29th/30th clamps only in February', () => {
    expect(series('2031-01-30', 'monthly', 3)).toEqual(['2031-01-30', '2031-02-28', '2031-03-30']);
  });
  it('quarterly: steps three months, clamping to the target month length', () => {
    expect(series('2031-11-30', 'quarterly', 4)).toEqual(['2031-11-30', '2032-02-29', '2032-05-30', '2032-08-30']);
    expect(series('2031-01-31', 'quarterly', 4)).toEqual(['2031-01-31', '2031-04-30', '2031-07-31', '2031-10-31']);
  });
  it('annual: 29 February falls on 28 February in common years and returns on leap years', () => {
    expect(series('2032-02-29', 'annual', 5)).toEqual(['2032-02-29', '2033-02-28', '2034-02-28', '2035-02-28', '2036-02-29']);
  });
  it('annual: crosses the year boundary', () => {
    expect(series('2031-12-15', 'annual', 2)).toEqual(['2031-12-15', '2032-12-15']);
  });
  it('firstOccurrenceOnOrAfter lands on or after the date and never before the start', () => {
    expect(firstOccurrenceOnOrAfter('2031-01-31', '2031-03-01', 'monthly', 31)).toBe('2031-03-31');
    expect(firstOccurrenceOnOrAfter('2031-01-31', '2031-01-31', 'monthly', 31)).toBe('2031-01-31');
    expect(firstOccurrenceOnOrAfter('2031-01-31', '2030-12-01', 'monthly', 31)).toBe('2031-01-31');
  });
  it('addDays handles month and year ends', () => {
    expect(addDays('2031-12-31', 1)).toBe('2032-01-01');
    expect(addDays('2032-02-28', 1)).toBe('2032-02-29');
    expect(addDays('2031-10-01', 30)).toBe('2031-10-31');
  });
});
