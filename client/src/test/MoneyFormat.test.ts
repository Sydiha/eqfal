import { describe, expect, it } from 'vitest';
import { formatMoney } from '../money-format';

describe('formatMoney (UI-11)', () => {
  it('groups thousands and forces two decimals', () => {
    expect(formatMoney('110000')).toBe('110,000.00');
    expect(formatMoney('1234567.5')).toBe('1,234,567.50');
    expect(formatMoney('0')).toBe('0.00');
    expect(formatMoney('999.99')).toBe('999.99');
  });
  it('keeps negatives and never shows negative zero', () => {
    expect(formatMoney('-1500.1')).toBe('-1,500.10');
    expect(formatMoney('-0.001')).toBe('0.00');
  });
  it('is exact beyond float precision and rounds half away from zero on the digits', () => {
    expect(formatMoney('12345678901234567.89')).toBe('12,345,678,901,234,567.89');
    expect(formatMoney('0.125')).toBe('0.13');
    expect(formatMoney('-0.125')).toBe('-0.13');
    expect(formatMoney('0.994')).toBe('0.99');
  });
  it('leaves non-decimals untouched and renders empty values', () => {
    expect(formatMoney('INV-2026')).toBe('INV-2026');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney('', '0.00')).toBe('0.00');
    expect(formatMoney(2500)).toBe('2,500.00');
  });
});
