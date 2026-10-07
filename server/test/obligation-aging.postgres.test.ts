import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObligationAgingService } from '../src/modules/obligations/obligation-aging';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

const cents = (value: string) => Math.round(Number(value) * 100);

// Real PostgreSQL (migrations applied): AR/AP aging over existing obligations and settlements.
describeDatabase('AR/AP aging report with PostgreSQL', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const service = new ObligationAgingService(pool);
  const userId = randomUUID();
  const companies: string[] = [];
  const ids: Record<string, string> = {};
  let company = '';

  async function setupCompany() {
    const id = randomUUID();
    companies.push(id);
    await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'Aging')", [id, `aging-${id}`]);
    const customer = (await pool.query<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Customer A','customer',$2) RETURNING id", [id, userId])).rows[0]!.id;
    const supplier = (await pool.query<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Supplier B','supplier',$2) RETURNING id", [id, userId])).rows[0]!.id;
    const account = (await pool.query<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id", [id, userId])).rows[0]!.id;
    const batch = (await pool.query<{ id: string }>(
      "INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id",
      [id, account, `k-${id}`, userId])).rows[0]!.id;
    return { id, customer, supplier, account, batch };
  }

  let row = 0;
  async function obligation(c: Awaited<ReturnType<typeof setupCompany>>, key: string, o: { direction?: 'receivable' | 'payable'; amount: string; due?: string | null; recognized?: string; status?: 'confirmed' | 'unconfirmed'; cancelled?: boolean }) {
    const direction = o.direction ?? 'receivable';
    ids[key] = (await pool.query<{ id: string }>(
      `INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,due_on,verification_status,source_type,is_cancelled,created_by_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9) RETURNING id`,
      [c.id, direction, direction === 'receivable' ? c.customer : c.supplier, o.amount, o.recognized ?? '2026-01-01', o.due ?? null, o.status ?? 'confirmed', o.cancelled ?? false, userId])).rows[0]!.id;
  }
  async function settle(c: Awaited<ReturnType<typeof setupCompany>>, key: string, amount: string, date: string, direction: 'receivable' | 'payable' = 'receivable') {
    row += 1;
    const tx = (await pool.query<{ id: string }>(
      "INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,$4,$5,'SAR',$6,$7,'strong') RETURNING id",
      [c.id, c.account, c.batch, date, direction === 'receivable' ? amount : `-${amount}`, row, `fp-${randomUUID()}`])).rows[0]!.id;
    await pool.query('INSERT INTO obligation_settlements(company_id,obligation_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,$4,$5)', [c.id, ids[key], tx, amount, userId]);
  }

  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'x')", [userId, `aging-${userId}@example.test`]);
    const c = await setupCompany();
    company = c.id;
    await obligation(c, 'notDue', { amount: '100.00', due: '2026-07-10' });
    await obligation(c, 'dueToday', { amount: '50.00', due: '2026-06-30' });
    await obligation(c, 'noDueDate', { amount: '70.00', due: null });
    await obligation(c, 'day30', { amount: '200.00', due: '2026-05-31' });
    await obligation(c, 'day31Partial', { amount: '300.00', due: '2026-05-30' });
    await settle(c, 'day31Partial', '120.00', '2026-06-15');
    await obligation(c, 'day90', { amount: '400.00', due: '2026-04-01' });
    await obligation(c, 'day91', { amount: '500.00', due: '2026-03-31' });
    await obligation(c, 'settledLater', { amount: '100.00', due: '2026-06-20' });
    await settle(c, 'settledLater', '25.00', '2026-07-05');
    await obligation(c, 'fullySettled', { amount: '80.00', due: '2026-06-01' });
    await settle(c, 'fullySettled', '80.00', '2026-06-10');
    await obligation(c, 'cancelled', { amount: '90.00', due: '2026-06-01', cancelled: true });
    await obligation(c, 'unconfirmed', { amount: '60.00', due: '2026-06-01', status: 'unconfirmed' });
    await obligation(c, 'recognizedLater', { amount: '40.00', recognized: '2026-07-01', due: '2026-07-01' });
    await obligation(c, 'payable29', { direction: 'payable', amount: '1000.00', due: '2026-06-01' });
    await obligation(c, 'payableNotDue', { direction: 'payable', amount: '250.00', due: '2026-08-01' });
    const other = await setupCompany();
    await obligation(other, 'otherCompany', { amount: '9999.00', due: '2026-01-31' });
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM obligation_settlements WHERE company_id = ANY($1)', [companies]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
      await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    } catch { /* best-effort cleanup on a disposable database */ }
    await pool.end();
  });

  const bucketOf = (side: { items: Array<{ obligation_id: string; bucket: string }> }, key: string) => side.items.find((i) => i.obligation_id === ids[key])?.bucket;

  it('separates receivables and payables and excludes another company', async () => {
    const report = await service.report(company, '2026-06-30');
    expect(report.as_of_date).toBe('2026-06-30');
    expect(report.receivables.items.every((i) => i.counterparty_name === 'Customer A')).toBe(true);
    expect(report.payables.items.map((i) => i.obligation_id).sort()).toEqual([ids.payable29, ids.payableNotDue].sort());
    expect(report.receivables.items.some((i) => i.obligation_id === ids.otherCompany)).toBe(false);
    expect(bucketOf(report.payables, 'payable29')).toBe('days_1_30');
    expect(bucketOf(report.payables, 'payableNotDue')).toBe('current');
  });

  it('classifies each bucket boundary deterministically as of the report date', async () => {
    const ar = (await service.report(company, '2026-06-30')).receivables;
    expect(bucketOf(ar, 'notDue')).toBe('current');
    expect(bucketOf(ar, 'dueToday')).toBe('current');
    expect(bucketOf(ar, 'noDueDate')).toBe('current');
    expect(bucketOf(ar, 'day30')).toBe('days_1_30');
    expect(bucketOf(ar, 'day31Partial')).toBe('days_31_60');
    expect(bucketOf(ar, 'day90')).toBe('days_61_90');
    expect(bucketOf(ar, 'day91')).toBe('days_over_90');
    const nextDay = (await service.report(company, '2026-07-01')).receivables;
    expect(bucketOf(nextDay, 'dueToday')).toBe('days_1_30');
    expect(bucketOf(nextDay, 'day30')).toBe('days_31_60');
    expect(bucketOf(nextDay, 'day90')).toBe('days_over_90');
  });

  it('uses outstanding balance as of the date and excludes settled, cancelled, unconfirmed and future items', async () => {
    const ar = (await service.report(company, '2026-06-30')).receivables;
    expect(ar.items.find((i) => i.obligation_id === ids.day31Partial)).toMatchObject({ original_amount: '300.00', settled_amount: '120.00', outstanding_amount: '180.00', days_overdue: 31 });
    expect(ar.items.find((i) => i.obligation_id === ids.settledLater)?.outstanding_amount).toBe('100.00');
    for (const key of ['fullySettled', 'cancelled', 'unconfirmed', 'recognizedLater']) expect(bucketOf(ar, key)).toBeUndefined();
    const later = (await service.report(company, '2026-07-05')).receivables;
    expect(later.items.find((i) => i.obligation_id === ids.settledLater)?.outstanding_amount).toBe('75.00');
    expect(bucketOf(later, 'recognizedLater')).toBe('days_1_30');
  });

  it('bucket totals equal total outstanding on each side', async () => {
    const report = await service.report(company, '2026-06-30');
    const amounts = Object.fromEntries(report.receivables.buckets.map((b) => [b.bucket, b.amount]));
    expect(amounts).toEqual({ current: '220.00', days_1_30: '300.00', days_31_60: '180.00', days_61_90: '400.00', days_over_90: '500.00' });
    expect(report.receivables.total_outstanding).toBe('1600.00');
    expect(report.receivables.item_count).toBe(8);
    for (const side of [report.receivables, report.payables]) {
      expect(side.buckets.reduce((sum, b) => sum + cents(b.amount), 0)).toBe(cents(side.total_outstanding));
      expect(side.items.reduce((sum, i) => sum + cents(i.outstanding_amount), 0)).toBe(cents(side.total_outstanding));
    }
    expect(report.payables.total_outstanding).toBe('1250.00');
  });

  it('rejects an invalid as-of date', async () => {
    await expect(service.report(company, '2026-02-30')).rejects.toThrow('Invalid as_of_date');
  });
});
