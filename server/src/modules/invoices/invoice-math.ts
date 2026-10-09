/**
 * Deterministic invoice arithmetic (owner decision A6, 2026-10-09): line-level rounding.
 *
 * Every value is an exact BigInt in a fixed scale; no floating point is used anywhere.
 *  - quantity:    up to 4 decimals  (scale 10^4)
 *  - unit_price:  up to 2 decimals  (halalas, scale 10^2)
 *  - discount:    up to 2 decimals  (fixed amount per line, applied BEFORE VAT)
 *  - vat_rate:    percent, up to 2 decimals (scale 10^2)
 *
 * Per line:
 *   gross  = quantity × unit_price                       (exact, scale 10^6)
 *   reject when discount > gross
 *   net    = ROUND_HALF_UP(gross − discount, 2)
 *   vat    = ROUND_HALF_UP(net × vat_rate / 100, 2)     (computed on the stored, rounded net)
 *   total  = net + vat
 * Invoice: subtotal = Σ net, vat = Σ vat, total = Σ line totals (always equals subtotal + vat).
 * All amounts are non-negative, so ROUND_HALF_UP is "round half away from zero".
 */

export class InvoiceMathError extends Error {}

const QUANTITY = /^\d{1,14}(?:\.\d{1,4})?$/;
const MONEY = /^\d{1,16}(?:\.\d{1,2})?$/;
const RATE = /^\d{1,3}(?:\.\d{1,2})?$/;

/** Parses a non-negative decimal string into an integer at the given scale (number of decimals). */
function scaled(value: string, decimals: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Exact integer division with ROUND_HALF_UP for non-negative operands. */
function roundHalfUp(numerator: bigint, divisor: bigint): bigint {
  return (numerator * 2n + divisor) / (divisor * 2n);
}

export function formatMoney(halalas: bigint): string {
  return `${halalas / 100n}.${(halalas % 100n).toString().padStart(2, '0')}`;
}

function decimalInput(value: unknown, pattern: RegExp, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!pattern.test(text)) throw new InvoiceMathError(`${field} must be a decimal string`);
  return text;
}

export type LineInput = { quantity: unknown; unit_price: unknown; discount_amount?: unknown; vat_rate: unknown };

export type LineAmounts = {
  quantity: string;
  unit_price: string;
  discount_amount: string;
  vat_rate: string;
  net_amount: string;
  vat_amount: string;
  total_amount: string;
  net: bigint;
  vat: bigint;
  total: bigint;
};

export function computeLine(input: LineInput): LineAmounts {
  // Strings only: JSON numbers would already have passed through binary floating point.
  const quantity = decimalInput(input.quantity, QUANTITY, 'quantity');
  const unitPrice = decimalInput(input.unit_price, MONEY, 'unit_price');
  const discount = decimalInput(input.discount_amount ?? '0', MONEY, 'discount_amount');
  const rate = decimalInput(input.vat_rate, RATE, 'vat_rate');

  const quantityE4 = scaled(quantity, 4);
  const priceE2 = scaled(unitPrice, 2);
  const discountE2 = scaled(discount, 2);
  const rateE2 = scaled(rate, 2);
  if (quantityE4 <= 0n) throw new InvoiceMathError('quantity must be greater than zero');
  if (rateE2 > 10000n) throw new InvoiceMathError('vat_rate must be between 0 and 100');

  const grossE6 = quantityE4 * priceE2;
  const discountE6 = discountE2 * 10_000n;
  if (discountE6 > grossE6) throw new InvoiceMathError('discount_amount exceeds the line gross amount');

  const net = roundHalfUp(grossE6 - discountE6, 10_000n);
  const vat = roundHalfUp(net * rateE2, 10_000n);
  const total = net + vat;
  // NUMERIC(18,2) bound
  if (total >= 10n ** 18n) throw new InvoiceMathError('line amount is too large');

  return {
    quantity, unit_price: unitPrice, discount_amount: formatMoney(discountE2), vat_rate: rate,
    net_amount: formatMoney(net), vat_amount: formatMoney(vat), total_amount: formatMoney(total),
    net, vat, total,
  };
}

export function computeTotals(lines: LineAmounts[]): { subtotal_amount: string; vat_amount: string; total_amount: string } {
  const subtotal = lines.reduce((sum, line) => sum + line.net, 0n);
  const vat = lines.reduce((sum, line) => sum + line.vat, 0n);
  const total = lines.reduce((sum, line) => sum + line.total, 0n);
  if (total >= 10n ** 18n) throw new InvoiceMathError('invoice total is too large'); // NUMERIC(18,2) bound
  return { subtotal_amount: formatMoney(subtotal), vat_amount: formatMoney(vat), total_amount: formatMoney(total) };
}
