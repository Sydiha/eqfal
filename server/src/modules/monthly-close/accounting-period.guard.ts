import { PoolClient } from 'pg';

export class AccountingPeriodClosedError extends Error {
  constructor() { super('Accounting period is closed'); }
}

function monthBuckets(start: string, end = start): string[] {
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  const last = new Date(`${end.slice(0, 7)}-01T00:00:00Z`);
  const buckets: string[] = [];
  while (cursor <= last) {
    buckets.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return buckets;
}

/** Serialize close and dated financial writes on the same company/month keys. */
export async function lockAccountingDate(companyId: string, date: string, client: PoolClient): Promise<void> {
  await lockAccountingRange(companyId, date, date, client);
}

export async function lockAccountingRange(companyId: string, start: string, end: string, client: PoolClient): Promise<void> {
  for (const bucket of monthBuckets(start, end)) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`accounting-period:${companyId}:${bucket}`]);
  }
}

export async function assertAccountingDateWritable(companyId: string, businessDate: string, client: PoolClient): Promise<void> {
  await lockAccountingDate(companyId, businessDate, client);
  const result = await client.query(
    `SELECT 1 FROM monthly_close_periods
     WHERE company_id=$1 AND status='closed' AND $2::date BETWEEN period_start AND period_end
     LIMIT 1`,
    [companyId, businessDate],
  );
  if (result.rowCount) throw new AccountingPeriodClosedError();
}
