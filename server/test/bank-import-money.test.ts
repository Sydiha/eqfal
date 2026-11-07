import { describe, expect, it } from 'vitest';
import { normalizeBankImportMoney } from '../src/modules/banking/bank.router';

describe('bank statement monetary normalization', () => {
  it.each([
    ['1000', '1000.00'],
    ['1000.50', '1000.50'],
    ['1,000', '1000.00'],
    ['1,000.50', '1000.50'],
    ['1,234,567.89', '1234567.89'],
    ['1٬234٬567٫89', '1234567.89'],
    ['1 234.50', '1234.50'],
    ['(1,200.25)', '-1200.25'],
    ['-0.50', '-0.50'],
    ['0', '0.00'],
    ['1234567890123456.78', '1234567890123456.78'],
  ])('normalizes %s exactly', (input, expected) => {
    expect(normalizeBankImportMoney(input)).toBe(expected);
  });

  it.each(['1,00', '12,34,567', '1,000.999', '1,000 500', '1,,000', '1e3'])('rejects malformed amount %s', (input) => {
    expect(normalizeBankImportMoney(input)).toBeNull();
  });

  it('rejects XLSX numeric cells whose cents exceed safe integer precision', () => {
    expect(normalizeBankImportMoney(1_234_567.89)).toBe('1234567.89');
    expect(normalizeBankImportMoney(90_071_992_547_409.91)).toBeNull();
  });
});
