import { PoolClient } from 'pg';

export class AccountingPeriodClosedError extends Error {
  constructor() { super('Accounting period is closed'); }
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

export async function assertAccountingDateWritable(companyId: string, businessDate: AccountingDate, client: PoolClient): Promise<void> {
  const normalizedDate = normalizeAccountingDate(businessDate);
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
  await lockAccountingRange(companyId, normalizedStart, normalizedEnd, client);
  const result = await client.query(
    `SELECT 1 FROM monthly_close_periods WHERE company_id=$1 AND status='closed' AND period_start <= $3::date AND period_end >= $2::date LIMIT 1`,
    [companyId, normalizedStart, normalizedEnd],
  );
  if (result.rowCount) throw new AccountingPeriodClosedError();
}
