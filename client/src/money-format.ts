// Single display formatter for monetary amounts: thousands separators and exactly two decimals (e.g. 110,000.00).
// Works on the decimal string itself (BigInt on the digits), so no floating-point arithmetic touches the value and large or
// 3+-decimal inputs keep every digit. Grouping and digits are always Latin/LTR, also in Arabic. Anything that is not a plain
// decimal (identifiers, free text) is returned unchanged; only call this for money, never for dates, percentages, counts or ids.
const DECIMAL = /^([+-])?(\d+)(?:\.(\d*))?$/;

export function formatMoney(value: string | number | null | undefined, empty = '—'): string {
  if (value === null || value === undefined) return empty;
  const raw = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(2) : '') : value.trim();
  if (raw === '') return typeof value === 'number' ? String(value) : empty;
  const m = DECIMAL.exec(raw);
  if (!m) return typeof value === 'number' ? String(value) : value;
  const [, sign, whole, fraction = ''] = m;
  let units = BigInt(whole! + (fraction + '00').slice(0, 2));
  if (fraction.length > 2 && fraction.charCodeAt(2) >= 53) units += 1n; // round half away from zero on the decimal digits
  const text = units.toString().padStart(3, '0');
  const intPart = text.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const negative = sign === '-' && units !== 0n;
  return `${negative ? '-' : ''}${intPart}.${text.slice(-2)}`;
}
