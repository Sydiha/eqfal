import { describe, expect, it } from 'vitest';
import { formatDisplayDate, formatDisplayDateTime } from '../date-format';

describe('date display formatting', () => {
  it('formats ISO dates as Gregorian day/month/year values', () => {
    expect(formatDisplayDate('2026-01-01T00:00:00.000Z', 'en')).toBe('01/01/2026');
    expect(formatDisplayDate('2026-12-31', 'en')).toBe('31/12/2026');
  });

  it('keeps Arabic display dates on the Gregorian calendar', () => {
    const formatted = formatDisplayDate('2026-01-01T00:00:00.000Z', 'ar');
    expect(formatted).toContain('2026');
    expect(formatted).toContain('01');
  });

  it('falls back safely for missing or invalid values', () => {
    expect(formatDisplayDate(null, 'en')).toBe('—');
    expect(formatDisplayDateTime(undefined, 'en')).toBe('—');
    expect(formatDisplayDate('not-a-date', 'en')).toBe('not-a-date');
    expect(formatDisplayDateTime('not-a-date', 'en')).toBe('not-a-date');
  });
});
