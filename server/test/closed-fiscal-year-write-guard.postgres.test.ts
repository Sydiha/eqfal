import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { VatService } from '../src/modules/vat/vat.router';
import { lockFiscalYearCloseScope } from '../src/modules/fiscal-years/fiscal-year-close-readiness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountingFiscalYearClosedError,
  AccountingPeriodClosedError,
  assertAccountingDateWritable,
  assertAccountingRangeWritable,
} from '../src/modules/monthly-close/accounting-period.guard';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

// Real PostgreSQL: the closed-fiscal-year write guard is independent of the monthly period status.
describeDatabase('Closed fiscal year write guard with PostgreSQL', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const companies: string[] = [];

  async function company(): Promise<{ id: string; fy2026: string; fy2027: string }> {
    const id = randomUUID();
    companies.push(id);
    await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'FY guard')", [id, `fy-guard-${id}`]);
    const fy2026 = (await pool.query<{ id: string }>("INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY 2026','2026-01-01','2026-12-31') RETURNING id", [id])).rows[0]!.id;
    const fy2027 = (await pool.query<{ id: string }>("INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY 2027','2027-01-01','2027-12-31') RETURNING id", [id])).rows[0]!.id;
    return { id, fy2026, fy2027 };
  }
  const setMonth = (id: string, fy: string, start: string, end: string, status: 'open' | 'closed') => pool.query(
    'INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,$3,$4,$5)', [id, fy, start, end, status]);
  const closeYear = (fy: string) => pool.query("UPDATE fiscal_years SET status='closed' WHERE id=$1", [fy]);
  async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query('BEGIN'); return await fn(client); } finally { await client.query('ROLLBACK'); client.release(); }
  }
  const date = (id: string, d: string) => inTx(c => assertAccountingDateWritable(id, d, c));
  const range = (id: string, s: string, e: string) => inTx(c => assertAccountingRangeWritable(id, s, e, c));

  beforeAll(async () => { await pool.query('SELECT 1'); });
  afterAll(async () => {
    try { await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]); } catch { /* disposable test database */ }
    await pool.end();
  });

  it('closed fiscal year + open month: rejected with FISCAL_YEAR_CLOSED', async () => {
    const co = await company();
    await setMonth(co.id, co.fy2026, '2026-03-01', '2026-03-31', 'open');
    await closeYear(co.fy2026);
    const failure = await date(co.id, '2026-03-10').catch(e => e);
    expect(failure).toBeInstanceOf(AccountingFiscalYearClosedError);
    expect(failure.code).toBe('FISCAL_YEAR_CLOSED');
  });

  it('closed fiscal year + no month row: rejected', async () => {
    const co = await company();
    await closeYear(co.fy2026);
    await expect(date(co.id, '2026-03-10')).rejects.toBeInstanceOf(AccountingFiscalYearClosedError);
  });

  it('closed fiscal year + closed month: rejected', async () => {
    const co = await company();
    await setMonth(co.id, co.fy2026, '2026-03-01', '2026-03-31', 'closed');
    await closeYear(co.fy2026);
    await expect(date(co.id, '2026-03-10')).rejects.toBeInstanceOf(AccountingPeriodClosedError);
  });

  it('open fiscal year + open month: allowed', async () => {
    const co = await company();
    await setMonth(co.id, co.fy2026, '2026-03-01', '2026-03-31', 'open');
    await expect(date(co.id, '2026-03-10')).resolves.toBeUndefined();
  });

  it('open fiscal year + closed month: the monthly rejection is preserved', async () => {
    const co = await company();
    await setMonth(co.id, co.fy2026, '2026-03-01', '2026-03-31', 'closed');
    const failure = await date(co.id, '2026-03-10').catch(e => e);
    expect(failure).toBeInstanceOf(AccountingPeriodClosedError);
    expect(failure).not.toBeInstanceOf(AccountingFiscalYearClosedError);
    expect(failure.code).toBe('ACCOUNTING_PERIOD_CLOSED');
  });

  it('a date outside every fiscal year is not blocked by this guard', async () => {
    const co = await company();
    await closeYear(co.fy2026);
    await expect(date(co.id, '2030-05-05')).resolves.toBeUndefined();
  });

  it('range crossing from an open year into a closed year is rejected; fully inside the open year is allowed', async () => {
    const co = await company();
    await closeYear(co.fy2026);
    await expect(range(co.id, '2026-12-15', '2027-01-15')).rejects.toBeInstanceOf(AccountingFiscalYearClosedError);
    await expect(range(co.id, '2027-01-01', '2027-01-31')).resolves.toBeUndefined();
  });

  it('a closed year of one company never affects another company', async () => {
    const a = await company();
    const b = await company();
    await closeYear(a.fy2026);
    await expect(date(a.id, '2026-06-01')).rejects.toBeInstanceOf(AccountingFiscalYearClosedError);
    await expect(date(b.id, '2026-06-01')).resolves.toBeUndefined();
    await expect(range(b.id, '2026-01-01', '2026-12-31')).resolves.toBeUndefined();
  });

  it('a write waits for a concurrent fiscal-year close (year row FOR UPDATE) and is then rejected, without deadlock', async () => {
    const co = await company();
    const closer = await pool.connect();
    try {
      await closer.query('BEGIN');
      await closer.query('SELECT id FROM fiscal_years WHERE id=$1 FOR UPDATE', [co.fy2026]);
      let settled = false;
      const write = date(co.id, '2026-06-01').catch(e => e).finally(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      // The closer then takes the month locks the writer would use next, as closeFiscalYear does.
      await closer.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`accounting-period:${co.id}:2026-06`]);
      await closer.query("UPDATE fiscal_years SET status='closed' WHERE id=$1", [co.fy2026]);
      await closer.query('COMMIT');
      expect(await write).toBeInstanceOf(AccountingFiscalYearClosedError);
    } finally { closer.release(); }
  });

  // Representative real write path that takes VAT keys: the closed-year check must happen before them (closer order: year row, VAT keys, months).
  describe('VAT review write path (real service)', () => {
    const vat = new VatService(pool);
    const userId = randomUUID();
    const pending = (taxDate: string) => ({ taxDate, status: 'pending' as const, treatment: null, taxable: null, vat: null, note: null, recoverability: undefined, recoverable: null, reason: null, version: undefined });
    beforeAll(async () => { await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'x')", [userId, `fy-guard-${userId}@example.test`]); });
    afterAll(async () => { try { await pool.query('DELETE FROM users WHERE id=$1', [userId]); } catch { /* disposable test database */ } });
    async function purchase(companyId: string): Promise<string> {
      return (await pool.query<{ id: string }>(
        "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount) VALUES($1,$2,'p.pdf','application/pdf',10,$3,$4,'approved','purchase','2026-03-05','100.00') RETURNING id",
        [companyId, userId, `k-${randomUUID()}`, randomUUID().replace(/-/g, '').padEnd(64, '0')])).rows[0]!.id;
    }

    it('saves a review in an open year and rejects it in a closed year with nothing written', async () => {
      const co = await company();
      const doc = await purchase(co.id);
      await expect(vat.saveReview(co.id, userId, doc, pending('2026-03-10'))).resolves.toMatchObject({ document_id: doc });
      await closeYear(co.fy2026);
      await expect(vat.saveReview(co.id, userId, doc, pending('2026-03-11'))).rejects.toBeInstanceOf(AccountingFiscalYearClosedError);
      const rows = (await pool.query<{ tax_date: string }>('SELECT tax_date::text FROM document_vat_reviews WHERE document_id=$1', [doc])).rows;
      expect(rows.map(r => r.tax_date)).toEqual(['2026-03-10']);
    });

    it('does not hold VAT keys while waiting for a fiscal-year close, so the closer can take them (no deadlock)', async () => {
      const co = await company();
      const doc = await purchase(co.id);
      const closer = await pool.connect();
      try {
        await closer.query('BEGIN');
        await closer.query("SET LOCAL lock_timeout='3s'");
        await closer.query('SELECT id FROM fiscal_years WHERE id=$1 FOR UPDATE', [co.fy2026]);
        let settled = false;
        const write = vat.saveReview(co.id, userId, doc, pending('2026-03-12')).catch(e => e).finally(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        await lockFiscalYearCloseScope(closer, co.id, { start_date: '2026-01-01', end_date: '2026-12-31' } as never);
        await closer.query("UPDATE fiscal_years SET status='closed' WHERE id=$1", [co.fy2026]);
        await closer.query('COMMIT');
        expect(await write).toBeInstanceOf(AccountingFiscalYearClosedError);
      } finally { closer.release(); }
    });
  });
});
