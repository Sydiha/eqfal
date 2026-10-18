export const EXTERNAL_PERIOD_REPORT_CODE = 'EXTERNAL_PERIOD_REPORT_UNAVAILABLE';
export const CASH_FLOW_EXTERNAL_PERIOD_CODE = 'CASH_FLOW_EXTERNAL_PERIOD';

/** The active cut-over range overlapping a fiscal year, as read by the report's own fiscal-year query (null when none). */
export type CutoverBounds = { cutover_from?: string | null; cutover_to?: string | null };

/** SQL fragment (two columns) for a query over `fiscal_years`: the active cut-over range bounds that overlap the year. */
export const CUTOVER_BOUNDS_SQL =
  "(SELECT a.from_date::text FROM ledger_source_authority a WHERE a.company_id=fiscal_years.company_id AND a.status='active' AND a.from_date<=fiscal_years.end_date AND a.to_date>=fiscal_years.start_date ORDER BY a.from_date LIMIT 1) cutover_from,"
  + "(SELECT a.to_date::text FROM ledger_source_authority a WHERE a.company_id=fiscal_years.company_id AND a.status='active' AND a.from_date<=fiscal_years.end_date AND a.to_date>=fiscal_years.start_date ORDER BY a.from_date LIMIT 1) cutover_to";

/** A report range that EQFAL cannot produce because the dates before the cut-over (D) are maintained externally. `code` is stable for the client. */
export class ExternalPeriodReportError extends Error {
  constructor(public readonly code: string, message: string, public readonly cutoverDate: string) { super(message); }
}

/**
 * Trial balance, financial position, profit or loss, changes in equity (C1B-3b). With an active cut-over range ending on D the ledger holds
 * D's imported balances as ONE journal dated D, so a range is meaningful only when it contains the whole external span or starts after D:
 *   from = fiscal-year start and to >= D, or from > D. Anything else would show nothing (to < D) or the year-to-date P&L lumped inside a
 *   sub-period (from inside [start, D]). Returns D (null when the year has no active range) so reports can state it.
 */
export function assertStatementRange(cut: CutoverBounds, from: string, to: string): string | null {
  if (!cut.cutover_to || !cut.cutover_from) return null;
  if (to < cut.cutover_to || (from > cut.cutover_from && from <= cut.cutover_to)) {
    throw new ExternalPeriodReportError(EXTERNAL_PERIOD_REPORT_CODE, `Dates up to ${cut.cutover_to} are maintained outside EQFAL; request the whole year to date or a period starting after ${cut.cutover_to}`, cut.cutover_to);
  }
  return cut.cutover_to;
}

/** Cash flow: no statement may cover any date on or before D (the pre-D cash movements are not in EQFAL). */
export function assertCashFlowRange(cut: CutoverBounds, from: string): void {
  if (cut.cutover_to && from <= cut.cutover_to) {
    throw new ExternalPeriodReportError(CASH_FLOW_EXTERNAL_PERIOD_CODE, `Cash movements up to ${cut.cutover_to} are maintained outside EQFAL; request a period starting after ${cut.cutover_to}`, cut.cutover_to);
  }
}
