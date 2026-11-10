import { describe, expect, it } from 'vitest';
import { formatPercentage } from '../percentage-format';

describe('percentage display formatting', () => {
  it('preserves the exact decimal text without parsing or rounding', () => {
    expect(formatPercentage('15.00')).toBe('15.00%');
    expect(formatPercentage('0.12500000000000000001')).toBe('0.12500000000000000001%');
    expect(formatPercentage('999999999999999999999.999')).toBe('999999999999999999999.999%');
  });
});
