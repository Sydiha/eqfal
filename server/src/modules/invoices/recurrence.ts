/**
 * Pure schedule arithmetic for recurring invoices. Dates are plain YYYY-MM-DD strings (no time zone involved);
 * "today" always comes from the server's operational date (Asia/Riyadh), never from a browser clock.
 *
 * Month-end rule: every occurrence is derived from the template's anchor day (the day of month of start_date) and clamped to the
 * last day of the target month. The clamp never carries forward: 31 Jan -> 28/29 Feb -> 31 Mar (monthly), 30 Nov -> 28 Feb -> 30 May (quarterly),
 * 29 Feb 2028 -> 28 Feb 2029 -> 28 Feb 2030 -> 28 Feb 2031 -> 29 Feb 2032 (annual).
 */
export type Frequency = 'monthly' | 'quarterly' | 'annual';
export const FREQUENCIES: readonly Frequency[] = ['monthly', 'quarterly', 'annual'];
const STEP_MONTHS: Record<Frequency, number> = { monthly: 1, quarterly: 3, annual: 12 };

const daysInMonth = (year: number, month1: number) => new Date(Date.UTC(year, month1, 0)).getUTCDate();
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The occurrence `monthsAhead` months after the month of `date`, on the anchor day clamped to that month's length. */
function shift(date: string, monthsAhead: number, anchorDay: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + monthsAhead;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${pad(year, 4)}-${pad(month)}-${pad(Math.min(anchorDay, daysInMonth(year, month)))}`;
}

export function nextOccurrence(previous: string, frequency: Frequency, anchorDay: number): string {
  return shift(previous, STEP_MONTHS[frequency], anchorDay);
}

/** First scheduled occurrence that is on or after `onOrAfter`, walking from `from` (a scheduled date). */
export function firstOccurrenceOnOrAfter(from: string, onOrAfter: string, frequency: Frequency, anchorDay: number): string {
  let current = from;
  while (current < onOrAfter) current = nextOccurrence(current, frequency, anchorDay);
  return current;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const anchorDayOf = (startDate: string) => Number(startDate.slice(8, 10));
