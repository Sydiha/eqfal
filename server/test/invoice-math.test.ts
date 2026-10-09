import { describe, expect, it } from 'vitest';
import { computeLine, computeTotals, InvoiceMathError } from '../src/modules/invoices/invoice-math';

const line = (quantity: string, unit_price: string, vat_rate: string, discount_amount?: string) =>
  computeLine({ quantity, unit_price, vat_rate, discount_amount });

describe('invoice arithmetic (A6: line-level ROUND_HALF_UP)', () => {
  it('computes a simple standard-rated line', () => {
    const l = line('1', '1000.00', '15');
    expect([l.net_amount, l.vat_amount, l.total_amount]).toEqual(['1000.00', '150.00', '1150.00']);
  });

  it('rounds the net at an exact half-halalah boundary upwards', () => {
    expect(line('0.5', '0.01', '0').net_amount).toBe('0.01'); // 0.005 -> 0.01
    expect(line('0.4999', '0.01', '0').net_amount).toBe('0.00'); // 0.004999 -> 0.00
    expect(line('1.5', '0.03', '0').net_amount).toBe('0.05'); // 0.045 -> 0.05
  });

  it('rounds VAT at an exact half-halalah boundary upwards, on the rounded net', () => {
    expect(line('1', '0.10', '15').vat_amount).toBe('0.02'); // 0.015 -> 0.02
    expect(line('1', '0.03', '15').vat_amount).toBe('0.00'); // 0.0045 -> 0.00
    expect(line('1', '0.70', '15').vat_amount).toBe('0.11'); // 0.105 -> 0.11
    // VAT is on the stored (rounded) net: 0.045 -> net 0.05 -> VAT 0.0075 -> 0.01
    expect(line('1.5', '0.03', '15').vat_amount).toBe('0.01');
  });

  it('applies the fixed discount before VAT', () => {
    const l = line('2', '100.00', '15', '20.00');
    expect([l.net_amount, l.vat_amount, l.total_amount, l.discount_amount]).toEqual(['180.00', '27.00', '207.00', '20.00']);
  });

  it('accepts a discount equal to the gross and rejects one above it', () => {
    expect(line('3', '10.00', '15', '30.00').total_amount).toBe('0.00');
    expect(() => line('3', '10.00', '15', '30.01')).toThrow(InvoiceMathError);
    // compared against the exact (unrounded) gross: 0.333 x 0.03 = 0.00999
    expect(() => line('0.333', '0.03', '0', '0.01')).toThrow(InvoiceMathError);
  });

  it('handles zero VAT and fractional rates', () => {
    expect(line('7', '13.33', '0').vat_amount).toBe('0.00');
    expect(line('1', '100.00', '2.5').vat_amount).toBe('2.50');
    expect(line('1', '0.01', '50').vat_amount).toBe('0.01'); // 0.005 -> 0.01
  });

  it('reconciles invoice totals to the sum of stored rounded lines across multiple lines', () => {
    const lines = [line('1', '0.10', '15'), line('1', '0.10', '15'), line('1', '0.10', '15')];
    // each line VAT 0.015 -> 0.02, so 0.06 (header-level rounding would give 0.045 -> 0.05)
    expect(computeTotals(lines)).toEqual({ subtotal_amount: '0.30', vat_amount: '0.06', total_amount: '0.36' });
    const mixed = [line('3', '33.33', '15', '0.99'), line('1.25', '8.40', '0'), line('2', '19.99', '5')];
    const t = computeTotals(mixed);
    const sum = (k: 'net' | 'vat' | 'total') => mixed.reduce((s, l) => s + l[k], 0n);
    expect(t).toEqual({ subtotal_amount: '149.48', vat_amount: '16.85', total_amount: '166.33' }); // 99.00 + 10.50 + 39.98; VAT 14.85 + 0 + 2.00 (1.999)
    expect(BigInt(t.subtotal_amount.replace('.', ''))).toBe(sum('net'));
    expect(BigInt(t.vat_amount.replace('.', ''))).toBe(sum('vat'));
    expect(BigInt(t.total_amount.replace('.', ''))).toBe(sum('total'));
    expect(BigInt(t.total_amount.replace('.', ''))).toBe(sum('net') + sum('vat'));
  });

  it('rejects non-string numbers, negatives, zero quantity, too many decimals and rates above 100', () => {
    const bad: Array<[unknown, unknown, unknown, unknown?]> = [
      [1, '1.00', '15'], ['1', 1.1, '15'], ['-1', '1.00', '15'], ['0', '1.00', '15'], ['1', '1.001', '15'],
      ['1.00001', '1.00', '15'], ['1', '1.00', '100.01'], ['1', '1.00', '15', '-1'], ['1e3', '1.00', '15'], ['1', '1.00', '15', 0.5],
    ];
    for (const [quantity, unit_price, vat_rate, discount_amount] of bad) {
      expect(() => computeLine({ quantity, unit_price, vat_rate, discount_amount })).toThrow(InvoiceMathError);
    }
  });

  it('is free of floating-point drift for classic float traps', () => {
    expect(line('3', '0.10', '0').net_amount).toBe('0.30'); // 0.1*3 = 0.30000000000000004 in float
    expect(line('1', '1.15', '100').vat_amount).toBe('1.15');
  });
});
