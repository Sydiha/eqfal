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
    expect(formatMoney('-0.00')).toBe('0.00');
  });
  it('is exact beyond float precision', () => {
    expect(formatMoney('12345678901234567.89')).toBe('12,345,678,901,234,567.89');
    expect(formatMoney('0.125')).toBe('0.125');
  });
  it('leaves non-decimals untouched and renders empty values', () => {
    expect(formatMoney('INV-2026')).toBe('INV-2026');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney('', '0.00')).toBe('0.00');
    expect(formatMoney(2500)).toBe('2,500.00');
  });
});

import { subtractMoney, sumMoney } from '../money-format';
describe('formatMoney never silently rounds or reinterprets (review fixes)', () => {
  it('keeps extra precision instead of rounding', () => {
    expect(formatMoney('0.125')).toBe('0.125');
    expect(formatMoney('1234.56789')).toBe('1,234.56789');
    expect(formatMoney('10.500')).toBe('10.50');
    expect(formatMoney('-0.001')).toBe('-0.001');
  });
  it('returns invalid or non-numeric input exactly as given', () => {
    for (const v of ['1e5', '1,000.00', 'abc', '12.3.4', '--1', 'NaN', 'Infinity']) expect(formatMoney(v)).toBe(v);
  });
  it('sums and subtracts exactly with no float drift', () => {
    expect(sumMoney(['0.1', '0.2'])).toBe('0.30');
    expect(sumMoney(['12345678901234567.89', '0.11'])).toBe('12345678901234568.00');
    expect(sumMoney(['-5', '2.5'])).toBe('-2.50');
    expect(sumMoney([])).toBe('0.00');
    expect(subtractMoney('10.00', '0.30')).toBe('9.70');
    expect(subtractMoney('1.00', '-0.50')).toBe('1.50');
  });
});

describe('formatMoney numeric inputs keep representable precision', () => {
  it('does not round numbers with 3+ decimals', () => {
    expect(formatMoney(0.125)).toBe('0.125');
    expect(formatMoney(1.005)).toBe('1.005');
    expect(formatMoney(1234.56789)).toBe('1,234.56789');
    expect(formatMoney(2.5)).toBe('2.50');
  });
  it('handles negatives and tiny values without exponent notation or negative zero', () => {
    expect(formatMoney(-1500.125)).toBe('-1,500.125');
    expect(formatMoney(-0.001)).toBe('-0.001');
    expect(formatMoney(1e-7)).toBe('0.0000001');
    expect(formatMoney(-0)).toBe('0.00');
  });
  it('formats large safe values and refuses to pretend unsafe numbers are exact', () => {
    expect(formatMoney(9007199254740991)).toBe('9,007,199,254,740,991.00');
    expect(formatMoney(1e21)).toBe('1e+21');
    expect(formatMoney(Number.NaN)).toBe('NaN');
    expect(formatMoney(Infinity)).toBe('Infinity');
  });
});
