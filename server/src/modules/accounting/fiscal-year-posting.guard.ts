import { PoolClient } from 'pg';
import { JournalPostingConflictError, JournalPostingValidationError } from './journal-posting-errors';

export class FiscalYearClosedError extends JournalPostingConflictError {
  constructor() { super('Fiscal year is closed'); }
}

export type PostingFiscalYear = { start_date: string; end_date: string; status: 'open' | 'closed' };

/**
 * Shared posting guard: the journal's fiscal year must belong to the company,
 * contain the accounting date, and be open. FOR SHARE makes a concurrent
 * closeFiscalYear (which takes FOR UPDATE) serialize against posting.
 * Independent of, and in addition to, the monthly-period guard.
 */
export async function assertFiscalYearOpen(
  companyId: string,
  fiscalYearId: string,
  accountingDate: string,
  client: PoolClient,
): Promise<PostingFiscalYear> {
  const year = (
    await client.query<PostingFiscalYear>(
      'SELECT start_date::text,end_date::text,status FROM fiscal_years WHERE id=$1 AND company_id=$2 FOR SHARE',
      [fiscalYearId, companyId],
    )
  ).rows[0];
  if (!year || accountingDate < year.start_date || accountingDate > year.end_date) {
    throw new JournalPostingValidationError('Accounting date must be within the fiscal year');
  }
  if (year.status === 'closed') throw new FiscalYearClosedError();
  return year;
}
