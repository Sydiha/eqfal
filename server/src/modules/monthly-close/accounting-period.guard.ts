import { PoolClient } from 'pg';

export class AccountingPeriodClosedError extends Error {
  readonly code: string = 'ACCOUNTING_PERIOD_CLOSED';
  constructor(message = 'Accounting period is closed') { super(message); }
}

/** The date (or range) falls in a closed fiscal year, independent of the monthly period status. Subclass so existing handlers still map it to 409. */
export class AccountingFiscalYearClosedError extends AccountingPeriodClosedError {
  override readonly code = 'FISCAL_YEAR_CLOSED';
  constructor() { super('Fiscal year is closed'); }
}

type AccountingDate = string | Date;

function normalizeAccountingDate(value: AccountingDate): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Invalid accounting date');
    return value.toISOString().slice(0, 10);
  }
  return value;
}

function monthBuckets(start: AccountingDate, end: AccountingDate = start): string[] {
  const normalizedStart = normalizeAccountingDate(start);
  const normalizedEnd = normalizeAccountingDate(end);
  const cursor = new Date(`${normalizedStart.slice(0, 7)}-01T00:00:00Z`);
  const last = new Date(`${normalizedEnd.slice(0, 7)}-01T00:00:00Z`);
  const buckets: string[] = [];
  while (cursor <= last) {
    buckets.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return buckets;
}

/** Serialize close and dated financial writes on the same company/month keys. */
export async function lockAccountingDate(companyId: string, date: AccountingDate, client: PoolClient): Promise<void> {
  await lockAccountingRange(companyId, date, date, client);
}

export async function lockAccountingRange(companyId: string, start: AccountingDate, end: AccountingDate, client: PoolClient): Promise<void> {
  for (const bucket of monthBuckets(start, end)) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`accounting-period:${companyId}:${bucket}`]);
  }
}

/**
 * Independent closed-fiscal-year check. Reads every overlapping year FOR SHARE (start_date order) so a concurrent closeFiscalYear, which holds the
 * year row FOR UPDATE, serializes with the write. Called BEFORE the month advisory lock to keep the closer's lock order (year row, then months).
 */
export async function assertFiscalYearsOpen(companyId: string, start: string, end: string, client: PoolClient): Promise<void> {
  const years = await client.query<{ status: string }>(
    `/* closed-year-guard */ SELECT status FROM fiscal_years WHERE company_id=$1 AND start_date <= $3::date AND end_date >= $2::date ORDER BY start_date FOR SHARE`,
    [companyId, start, end],
  );
  if (years.rows.some(year => year.status === 'closed')) throw new AccountingFiscalYearClosedError();
}

export async function assertAccountingDateWritable(companyId: string, businessDate: AccountingDate, client: PoolClient): Promise<void> {
  const normalizedDate = normalizeAccountingDate(businessDate);
  await assertFiscalYearsOpen(companyId, normalizedDate, normalizedDate, client);
  await lockAccountingDate(companyId, normalizedDate, client);
  const result = await client.query(
    `SELECT 1 FROM monthly_close_periods
     WHERE company_id=$1 AND status='closed' AND $2::date BETWEEN period_start AND period_end
     LIMIT 1`,
    [companyId, normalizedDate],
  );
  if (result.rowCount) throw new AccountingPeriodClosedError();
}

export async function assertAccountingRangeWritable(companyId: string, start: AccountingDate, end: AccountingDate, client: PoolClient): Promise<void> {
  const normalizedStart = normalizeAccountingDate(start);
  const normalizedEnd = normalizeAccountingDate(end);
  await assertFiscalYearsOpen(companyId, normalizedStart, normalizedEnd, client);
  await lockAccountingRange(companyId, normalizedStart, normalizedEnd, client);
  const result = await client.query(
    `SELECT 1 FROM monthly_close_periods WHERE company_id=$1 AND status='closed' AND period_start <= $3::date AND period_end >= $2::date LIMIT 1`,
    [companyId, normalizedStart, normalizedEnd],
  );
  if (result.rowCount) throw new AccountingPeriodClosedError();
}
