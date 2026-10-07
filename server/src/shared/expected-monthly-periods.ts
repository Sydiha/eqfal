/**
 * Canonical expected monthly-period boundaries for a fiscal year.
 * Single source of truth shared by annual-closing readiness and monthly-close
 * auto-provisioning so both always agree on the exact period bounds.
 * First/last months are truncated to the fiscal-year start/end.
 */
export function expectedMonthlyPeriods(start: string, end: string) {
  const periods: Array<{ period_start: string; period_end: string }> = [];
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.toISOString().slice(0, 10) <= end) {
    const monthStart = cursor.toISOString().slice(0, 10);
    const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 1);
    const monthEndDate = new Date(next); monthEndDate.setUTCDate(0);
    const monthEnd = monthEndDate.toISOString().slice(0, 10);
    periods.push({ period_start: monthStart < start ? start : monthStart, period_end: monthEnd > end ? end : monthEnd });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return periods;
}
