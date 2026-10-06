import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockVatPeriodScope } from '../src/modules/vat/vat.router';
import { FiscalYearService } from '../src/modules/fiscal-years/fiscal-year.service';
import {
  FiscalYearCloseBlockedError,
  getFiscalYearCloseReadiness,
} from '../src/modules/fiscal-years/fiscal-year-close-readiness';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

// Real PostgreSQL (migrations applied): fiscal-year close readiness gate (Task 35C Phase 1).
describeDatabase('Fiscal-year close readiness gate with PostgreSQL', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const service = new FiscalYearService(pool);
  const companies: string[] = [];
  const userId = randomUUID();

  type World = { company: string; fy: string; fy2025: string; asset: { balance: string; pnl: string } };

  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'x')", [userId, `fy-close-${userId}@example.test`]);
  });

  afterAll(async () => {
    // Journal rows are protected from deletion by DB triggers, so company
    // cleanup is best-effort; the test database is disposable.
    try {
      await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
      await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    } catch { /* best-effort cleanup */ }
    await pool.end();
  });

  async function world(opts: { vat?: boolean; monthsClosed?: number } = {}): Promise<World> {
    const company = randomUUID();
    companies.push(company);
    await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'FY Close')", [company, `fy-close-${company}`]);
    const fy = (await pool.query<{ id: string }>(
      "INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY 2026','2026-01-01','2026-12-31') RETURNING id", [company])).rows[0]!.id;
    const fy2025 = (await pool.query<{ id: string }>(
      "INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY 2025','2025-01-01','2025-12-31') RETURNING id", [company])).rows[0]!.id;
    const vatCols = opts.vat
      ? "'registered','300000000000003','2025-01-01','monthly'"
      : "'not_registered',NULL,NULL,NULL";
    await pool.query(
      `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,vat_registration_number,vat_registered_from,vat_filing_frequency,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,prepared_by_user_id,approved_by_user_id,approved_at)
       VALUES($1,1,'approved','IFRS','SAR','SAR','2025-01-01',${vatCols},'zakat_applicable','saudi_gcc_only','not_currently_applicable','no','2025-01-01',$2,$2,NOW())`,
      [company, userId]);
    const months = opts.monthsClosed ?? 12;
    for (let m = 1; m <= 12; m++) {
      const start = new Date(Date.UTC(2026, m - 1, 1)).toISOString().slice(0, 10);
      const end = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10);
      await pool.query(
        'INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,$3,$4,$5)',
        [company, fy, start, end, m <= months ? 'closed' : 'open']);
    }
    const acct = async (code: string, type: string) => (await pool.query<{ id: string }>(
      'INSERT INTO accounts(company_id,code,name,account_type) VALUES($1,$2,$2,$3) RETURNING id', [company, code, type])).rows[0]!.id;
    return { company, fy, fy2025, asset: { balance: await acct('1100', 'asset'), pnl: await acct('5100', 'expense') } };
  }

  const status = async (w: World) =>
    (await pool.query<{ status: string }>('SELECT status FROM fiscal_years WHERE id=$1', [w.fy])).rows[0]!.status;
  const auditCount = async (w: World) =>
    Number((await pool.query<{ n: string }>(
      "SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='fiscal_year.status_change'", [w.fy])).rows[0]!.n);
  const tryClose = async (w: World): Promise<string[]> => {
    try { await service.closeFiscalYear(w.fy, w.company, userId, 'test'); return []; }
    catch (err) {
      if (err instanceof FiscalYearCloseBlockedError) return err.blockers.map((b) => b.code);
      throw err;
    }
  };
  const expectBlocked = async (w: World, code: string) => {
    expect(await tryClose(w)).toContain(code);
    expect(await status(w)).toBe('open');
    expect(await auditCount(w)).toBe(0);
  };
  const expectCloses = async (w: World) => {
    expect(await tryClose(w)).toEqual([]);
    expect(await status(w)).toBe('closed');
  };
  const counterparty = async (w: World) => (await pool.query<{ id: string }>(
    "INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'CP','customer',$2) RETURNING id", [w.company, userId])).rows[0]!.id;
  const obligation = async (w: World, recognizedOn: string, verification = 'unconfirmed') =>
    pool.query(
      "INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'receivable',$2,100,$3,$4,'manual',$5)",
      [w.company, await counterparty(w), recognizedOn, verification, userId]);
  const draftJournal = (w: World, fyId: string, date: string) => pool.query(
    "INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,$3,'draft',$4)", [w.company, fyId, date, userId]);
  const adjustment = (w: World, start: string, end: string) => pool.query(
    "INSERT INTO periodic_adjustments(company_id,adjustment_type,total_amount,recognition_start,recognition_end,description,balance_account_id,pnl_account_id,workflow_status,prepared_by_user_id) VALUES($1,'prepaid_expense',120,$2,$3,'adj',$4,$5,'draft',$6)",
    [w.company, start, end, w.asset.balance, w.asset.pnl, userId]);
  const bankTx = async (w: World, date: string, reconciliation = 'unmatched') => {
    const account = (await pool.query<{ id: string }>(
      "INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'B','SAR',$2) RETURNING id", [w.company, userId])).rows[0]!.id;
    const batch = (await pool.query<{ id: string }>(
      "INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'f.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id", [w.company, account, randomUUID(), userId])).rows[0]!.id;
    const reconciled = reconciliation === 'reconciled';
    await pool.query(
      `INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength,reconciliation_status,reconciled_by_user_id,reconciled_at)
       VALUES($1,$2,$3,$4,-10,'SAR',1,$5,'strong',$6,${reconciled ? '$7,NOW()' : 'NULL,NULL'})`,
      reconciled ? [w.company, account, batch, date, randomUUID(), reconciliation, userId] : [w.company, account, batch, date, randomUUID(), reconciliation]);
  };
  const pendingDepreciation = async (w: World, periodStart: string, periodEnd: string) => {
    const category = (await pool.query<{ id: string }>(
      "SELECT id FROM asset_categories WHERE company_id=$1 AND code='machinery_equipment'", [w.company])).rows[0]!.id;
    const asset = (await pool.query<{ id: string }>(
      `INSERT INTO fixed_assets(company_id,asset_category_id,name,source_type,manual_reason,source_reference,acquisition_cost,acquisition_date,placed_in_service_date,residual_value,opening_accumulated_depreciation,depreciation_method,status,created_by)
       VALUES($1,$2,'A','manual_opening','r','ref',1000,'2025-01-01','2025-01-01',0,0,'straight_line','active',$3) RETURNING id`, [w.company, category, userId])).rows[0]!.id;
    await pool.query(
      "INSERT INTO asset_depreciation_entries(company_id,asset_id,period_start,period_end,opening_nbv,depreciation_amount,accumulated_depreciation,closing_nbv,status) VALUES($1,$2,$3,$4,1000,10,10,990,'pending')",
      [w.company, asset, periodStart, periodEnd]);
  };

  it('closes when every hard blocker is clear, writes exactly one audit event (14, 17)', async () => {
    const w = await world();
    await expectCloses(w);
    expect(await auditCount(w)).toBe(1);
  });

  it('blocks on an open or missing monthly period; failed close leaves the year open with no audit (1, 15, 16)', async () => {
    const open = await world({ monthsClosed: 11 });
    await expectBlocked(open, 'monthly_period_open');
    const missing = await world();
    await pool.query('DELETE FROM monthly_close_periods WHERE fiscal_year_id=$1 AND period_start=$2', [missing.fy, '2026-06-01']);
    await expectBlocked(missing, 'monthly_period_missing');
  });

  it('draft journal inside blocks, outside does not (2, 3)', async () => {
    const inside = await world();
    await draftJournal(inside, inside.fy, '2026-03-10');
    await expectBlocked(inside, 'draft_journals');
    const outside = await world();
    await draftJournal(outside, outside.fy2025, '2025-06-01');
    await expectCloses(outside);
  });

  it('unconfirmed obligation inside blocks, before/after does not (4, 5)', async () => {
    const inside = await world();
    await obligation(inside, '2026-05-01');
    await expectBlocked(inside, 'unconfirmed_obligations');
    const outside = await world();
    await obligation(outside, '2025-05-01');
    await obligation(outside, '2027-02-01');
    await expectCloses(outside);
  });

  it('periodic adjustment intersecting blocks, non-intersecting does not (6, 7)', async () => {
    const hit = await world();
    await adjustment(hit, '2025-11-01', '2026-02-28');
    await expectBlocked(hit, 'pending_periodic_adjustments');
    const miss = await world();
    await adjustment(miss, '2025-01-01', '2025-06-30');
    await adjustment(miss, '2027-01-01', '2027-06-30');
    await expectCloses(miss);
  });

  it('pending depreciation applicable to the year blocks, other years do not (8)', async () => {
    const hit = await world();
    await pendingDepreciation(hit, '2026-02-01', '2026-02-28');
    await expectBlocked(hit, 'pending_depreciation');
    const miss = await world();
    await pendingDepreciation(miss, '2025-02-01', '2025-02-28');
    await expectCloses(miss);
  });

  it('unreconciled bank transaction inside blocks, outside or reconciled does not (9, 10)', async () => {
    const hit = await world();
    await bankTx(hit, '2026-04-04');
    await expectBlocked(hit, 'unreconciled_bank_transactions');
    const miss = await world();
    await bankTx(miss, '2025-04-04');
    await bankTx(miss, '2026-04-04', 'reconciled');
    await expectCloses(miss);
  });

  it('applicable VAT with an unfiled period blocks; non-applicable company is not blocked (11, 12)', async () => {
    const vat = await world({ vat: true });
    await pool.query("INSERT INTO vat_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-01-01','2026-01-31','open')", [vat.company, vat.fy]);
    await expectBlocked(vat, 'vat_incomplete');
    const none = await world();
    await pool.query("INSERT INTO vat_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-01-01','2026-01-31','open')", [none.company, none.fy]);
    await expectCloses(none);
  });

  it('warning-only domains do not block (13)', async () => {
    const w = await world();
    await obligation(w, '2025-05-01', 'confirmed');
    const client = await pool.connect();
    try {
      const readiness = await getFiscalYearCloseReadiness(client, w.company, { id: w.fy, start_date: '2026-01-01', end_date: '2026-12-31' });
      expect(readiness.ready).toBe(true);
      expect(readiness.warnings.map((x) => x.code)).toContain('annual_closing_package_not_approved');
    } finally { client.release(); }
    await expectCloses(w);
  });

  it('is tenant isolated: another company cannot close the year (18)', async () => {
    const a = await world();
    const b = await world();
    await expect(service.closeFiscalYear(a.fy, b.company, userId)).rejects.toThrow(/not found or access denied/);
    expect(await status(a)).toBe('open');
  });

  it('waits for an in-flight VAT writer and then sees its blocker (stale-readiness protection)', async () => {
    const w = await world({ vat: true });
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      // Same locks a VAT period writer holds before inserting.
      await lockVatPeriodScope(w.company, '2026-01-01', '2026-12-31', writer);
      await writer.query("INSERT INTO vat_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-02-01','2026-02-28','open')", [w.company, w.fy]);
      let settled = false;
      const closing = tryClose(w).then((codes) => { settled = true; return codes; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await writer.query('COMMIT');
      expect(await closing).toContain('vat_incomplete');
      expect(await status(w)).toBe('open');
    } finally { writer.release(); }
  });
});
