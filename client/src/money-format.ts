// Single display formatter for monetary amounts: thousands separators and at least two decimals (e.g. 110,000.00).
// Works on the decimal string itself (BigInt on the digits), so no floating-point arithmetic touches the value.
// It never rounds: a value with more than two significant decimals keeps every digit (1,234.5678), only redundant
// trailing zeros beyond the second decimal are dropped. Grouping and digits are always Latin/LTR, also in Arabic.
// Anything that is not a plain decimal (identifiers, free text, empty) is returned unchanged; only call this for
// money, never for dates, percentages, counts or ids.
const DECIMAL = /^([+-])?(\d+)(?:\.(\d*))?$/;

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function formatMoney(value: string | number | null | undefined, empty = '—'): string {
  if (value === null || value === undefined) return empty;
  if (typeof value === 'number') return Number.isFinite(value) ? formatMoney(value.toFixed(2)) : String(value);
  const raw = value.trim();
  if (raw === '') return empty;
  const m = DECIMAL.exec(raw);
  if (!m) return value;
  const [, sign, whole, fraction = ''] = m;
  const extra = fraction.slice(2).replace(/0+$/, '');
  const decimals = (fraction.slice(0, 2).padEnd(2, '0') + extra);
  const intPart = group(whole!.replace(/^0+(?=\d)/, ''));
  const isZero = /^0*$/.test(whole! + fraction);
  return `${sign === '-' && !isZero ? '-' : ''}${intPart}.${decimals}`;
}

// Exact decimal arithmetic on strings (scaled BigInt) for totals that used to go through floating point.
const scaled = (value: string) => {
  const m = DECIMAL.exec(value.trim());
  if (!m) return null;
  const fraction = m[3] ?? '';
  const units = BigInt(m[2]! + fraction) * (m[1] === '-' ? -1n : 1n);
  return { units, scale: fraction.length };
};
const render = (units: bigint, scale: number) => {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(Math.max(scale, 2) + 1, '0');
  const pad = Math.max(scale, 2);
  return `${negative ? '-' : ''}${digits.slice(0, -pad)}.${digits.slice(-pad)}`;
};

/** Exact sum of decimal strings; invalid or missing entries count as zero (callers pass server decimals). */
export function sumMoney(values: Array<string | null | undefined>): string {
  const parts = values.map((v) => (v == null ? null : scaled(v))).filter((p): p is { units: bigint; scale: number } => p !== null);
  const scale = parts.reduce((max, p) => Math.max(max, p.scale), 2);
  return render(parts.reduce((total, p) => total + p.units * 10n ** BigInt(scale - p.scale), 0n), scale);
}

/** Exact a - b on decimal strings. */
export function subtractMoney(a: string, b: string): string {
  return sumMoney([a, b.startsWith('-') ? b.slice(1) : `-${b}`]);
}
