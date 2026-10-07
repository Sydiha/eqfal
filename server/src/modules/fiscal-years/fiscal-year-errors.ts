export type FiscalYearConflictCode =
  | 'FISCAL_YEAR_OVERLAP'
  | 'FISCAL_YEAR_ALREADY_CLOSED'
  | 'FISCAL_YEAR_CLOSED_IMMUTABLE';

/** Business-state conflicts (HTTP 409). The router classifies by `code`, never by message text. */
export class FiscalYearConflictError extends Error {
  constructor(readonly code: FiscalYearConflictCode, message: string) {
    super(message);
    this.name = 'FiscalYearConflictError';
  }
}
