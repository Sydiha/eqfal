/** ISO calendar months overlap a fiscal year from its opening month through its closing month. */
export function monthOverlapsFiscalYear(
  month: string,
  fiscalYear: { start_date: string; end_date: string } | undefined,
): boolean {
  if (!fiscalYear) return false;
  const yearMonth = month.slice(0, 7);
  return yearMonth >= fiscalYear.start_date.slice(0, 7) && yearMonth <= fiscalYear.end_date.slice(0, 7);
}
