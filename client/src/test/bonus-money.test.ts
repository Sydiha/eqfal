import { describe, expect, it } from 'vitest';
import { sumMoney } from '../components/bonus-money';

describe('bonus sumMoney', () => {
  it('sums exactly without float error', () => expect(sumMoney(['0.10', '0.20'])).toBe('0.30'));
  it('formats negative results with a single sign and two decimals', () => {
    expect(sumMoney(['-0.50'])).toBe('-0.50');
    expect(sumMoney(['1.00', '-1.25'])).toBe('-0.25');
    expect(sumMoney(['-12.5', '2'])).toBe('-10.50');
  });
  it('returns 0.00 for empty input and exact zero', () => {
    expect(sumMoney([])).toBe('0.00');
    expect(sumMoney(['-1.00', '1.00'])).toBe('0.00');
  });
  it('handles large values exactly', () => expect(sumMoney(['9007199254740993.01', '0.99'])).toBe('9007199254740994.00'));
  it('returns null instead of dropping malformed values', () => {
    expect(sumMoney(['1.00', 'abc'])).toBeNull();
    expect(sumMoney(['1.001'])).toBeNull();
  });
});
