/** Exact decimal sum of 2-dp money strings (single currency; bonus amounts carry no currency field and are SAR).
 * Returns null if any value is not a plain decimal, so a bad value is never silently dropped. */
export function sumMoney(values: string[]): string | null {
  let cents = 0n;
  for (const v of values) {
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(v);
    if (!m) return null;
    const c = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
    cents += m[1] ? -c : c;
  }
  const abs = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
