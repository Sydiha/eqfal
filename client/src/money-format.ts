// Single display formatter for monetary amounts: thousands separators and at least two decimals (e.g. 110,000.00).
// Works on the decimal string itself (BigInt on the digits), so no floating-point arithmetic touches the value.
// It never rounds: a value with more than two significant decimals keeps every digit (1,234.5678), only redundant
// trailing zeros beyond the second decimal are dropped. Grouping and digits are always Latin/LTR, also in Arabic.
// Numbers: a JS Number is a binary double (about 15-17 significant digits), so it cannot hold most decimal fractions
// exactly. Prefer passing the exact decimal string from the API. For a number we use its shortest round-trip decimal
// (what String() gives), which keeps every digit the double can faithfully represent (0.125 -> 0.125, 1.005 -> 1.005),
// expands exponent notation without rounding, and never drops digits to two places. Integers beyond 2^53 are no longer
// exact in a Number, so they (and NaN/Infinity) are returned via String() unchanged rather than formatted as if exact.
// Anything that is not a plain decimal (identifiers, free text, empty) is returned unchanged; only call this for
// money, never for dates, percentages, counts or ids.
const DECIMAL = /^([+-])?(\d+)(?:\.(\d*))?$/;

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Shortest round-trip decimal of a finite Number without exponent notation (no rounding).
function numberToDecimal(n: number): string {
  const text = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!m) return text;
  const [, sign, int, frac = '', exp] = m;
  const digits = int! + frac, shift = Number(exp) + int!.length;
  const body = shift <= 0 ? `0.${'0'.repeat(-shift)}${digits}` : shift >= digits.length ? digits + '0'.repeat(shift - digits.length) : `${digits.slice(0, shift)}.${digits.slice(shift)}`;
  return sign + body;
}

export function formatMoney(value: string | number | null | undefined, empty = '—'): string {
  if (value === null || value === undefined) return empty;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return String(value);
    return formatMoney(numberToDecimal(value));
  }
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
