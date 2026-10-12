import { describe, expect, it } from 'vitest';
import { computeLine, computeTotals, InvoiceMathError, parseRecoverablePercent, recoverablePortion } from '../src/modules/invoices/invoice-math';

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

describe('purchase VAT recoverability (V2.1): explicit percent and exact split', () => {
  it('accepts only an explicit percent strictly between 0 and 100 with up to 2 decimals, normalized to scale 2', () => {
    expect(parseRecoverablePercent('0.01')).toBe(1n);
    expect(parseRecoverablePercent('99.99')).toBe(9999n);
    expect(parseRecoverablePercent('50')).toBe(5000n);
    expect(parseRecoverablePercent(' 12.5 ')).toBe(1250n);
    for (const bad of ['0', '0.00', '100', '100.00', '100.01', '-1', '1.234', '', 'abc', '1e2', 50, null, undefined]) {
      expect(() => parseRecoverablePercent(bad), String(bad)).toThrow(InvoiceMathError);
    }
  });

  it('splits VAT with ROUND_HALF_UP on the recoverable part, so recoverable + non-recoverable always equals the VAT', () => {
    expect(recoverablePortion(15000n, 4000n)).toBe(6000n); // 150.00 @ 40% = 60.00
    expect(recoverablePortion(15n, 5000n)).toBe(8n); // 0.15 @ 50% = 0.075 -> 0.08 (half rounds up)
    expect(recoverablePortion(50n, 3333n)).toBe(17n); // 0.50 @ 33.33% = 0.16665 -> 0.17
    expect(recoverablePortion(15n, 1n)).toBe(0n); // 0.15 @ 0.01% -> 0.00
    expect(recoverablePortion(15n, 9999n)).toBe(15n); // 0.15 @ 99.99% -> 0.15
    for (const vat of [0n, 1n, 7n, 15n, 99n, 12345n]) for (const pct of [1n, 1250n, 3333n, 5000n, 9999n]) {
      const rec = recoverablePortion(vat, pct);
      expect(rec >= 0n && rec <= vat).toBe(true);
    }
  });
});
