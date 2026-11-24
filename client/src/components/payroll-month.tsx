/** Localized display of a payroll month (YYYY-MM or YYYY-MM-DD). Display only: the stored value is never changed. */
export function payrollMonthLabel(value: string, language: string): string {
  const ym = value.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return value;
  const locale = language.startsWith('ar') ? 'ar-u-ca-gregory-nu-latn' : 'en-US';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`));
}

/** Month name for people, with the technical YYYY-MM identifier kept as a quiet, direction-isolated secondary value. */
export function PayrollMonth({ value, language }: { value: string; language: string }) {
  return <span className="payroll-month-label"><bdi>{payrollMonthLabel(value, language)}</bdi> <bdi className="payroll-technical-id" dir="ltr">({value.slice(0, 7)})</bdi></span>;
}
