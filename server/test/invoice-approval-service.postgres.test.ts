import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Dormant invoice approval service + account mapping service against real PostgreSQL (disposable DATABASE_URL required).
// Skipped in CI like the other *.postgres.test.ts suites.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('invoice approval + account mappings (PostgreSQL)', () => {
  let pool: Pool;
  let approval: import('../src/modules/invoices/invoice-approval.service').InvoiceApprovalService;
  let mappings: import('../src/modules/invoices/invoice-account-mapping.service').InvoiceAccountMappingService;
  const run = randomUUID().slice(0, 8);
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const n = async (sql: string, p: unknown[] = []) => Number((await q(sql, p))[0].n);
  let creator: string; let approver: string;
  type Co = { id: string; fy: string; cust: string; supp: string; acct: string; acc: Record<string, string> };
  const CAPS = ['obligation.confirm', 'accounting.journal.create'];
  const approve = (co: Co, actor: string, id: string, v: number, caps = CAPS) => approval.approve(co.id, actor, caps, id, v);
  async function mapAll(co: Co) {
    for (const [k, t] of Object.entries({ receivable: 'asset', payable: 'liability', sales_revenue: 'revenue', purchase_expense: 'expense', vat_output: 'liability', vat_input: 'asset' })) {
      co.acc[k] = (await q(`INSERT INTO accounts (company_id, code, name, account_type) VALUES ($1,$2,$2,$3) RETURNING id`, [co.id, `M-${k}`, t]))[0].id;
      await mappings.set(co.id, approver, k, co.acc[k]);
    }
  }
  let A: Co; let B: Co;

  async function company(label: string): Promise<Co> {
    const id = (await q('INSERT INTO companies (slug, name) VALUES ($1,$1) RETURNING id', [`ia-${label}-${run}`]))[0].id;
    const fy = (await q(`INSERT INTO fiscal_years (company_id, name, start_date, end_date) VALUES ($1,'FY','2026-01-01','2026-12-31') RETURNING id`, [id]))[0].id;
    const cust = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'C','customer',$2) RETURNING id`, [id, creator]))[0].id;
    const supp = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'S','supplier',$2) RETURNING id`, [id, creator]))[0].id;
    const acct = (await q(`INSERT INTO accounts (company_id, code, name, account_type) VALUES ($1,'1100','Test','asset') RETURNING id`, [id]))[0].id;
    return { id, fy, cust, supp, acct, acc: {} };
  }
  async function submitted(co: Co, direction: 'sales' | 'purchase' = 'sales', issue = '2026-03-10', vat = direction === 'sales' ? 15 : 0) {
    const id = (await q(
      `INSERT INTO invoices (company_id, direction, counterparty_id, issue_date, subtotal_amount, vat_amount, total_amount, created_by_user_id)
       VALUES ($1,$2,$3,$4,100,$5::numeric,100+$5::numeric,$6) RETURNING id`, [co.id, direction, direction === 'sales' ? co.cust : co.supp, issue, vat, creator]))[0].id;
    await q(`UPDATE invoices SET status='submitted', version=version+1 WHERE id=$1`, [id]);
    return id as string;
  }
  const version = async (id: string) => (await q('SELECT version FROM invoices WHERE id=$1', [id]))[0].version as number;
  const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

  beforeAll(async () => {
    pool = (await import('../src/db/pool')).default!;
    const { InvoiceApprovalService } = await import('../src/modules/invoices/invoice-approval.service');
    const { InvoiceAccountMappingService } = await import('../src/modules/invoices/invoice-account-mapping.service');
    approval = new InvoiceApprovalService(pool);
    mappings = new InvoiceAccountMappingService(pool);
    creator = (await q(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [`ia-c-${run}@example.test`]))[0].id;
    approver = (await q(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [`ia-a-${run}@example.test`]))[0].id;
    A = await company('a'); B = await company('b');
    await mapAll(A); await mapAll(B);
  });
  afterAll(async () => { await pool?.end(); });

  it('approves atomically: number, confirmed obligation, balanced draft journal, audit; nothing posted, no VAT memo', async () => {
    const id = await submitted(A);
    const v = await version(id);
    const out = await approve(A, approver, id, v);
    const inv = out.invoice;
    expect(inv.status).toBe('approved'); expect(inv.internal_number).toBe('1'); expect(inv.fiscal_year_id).toBe(A.fy);
    expect(inv.approved_by_user_id).toBe(approver); expect(inv.version).toBe(v + 1);
    const ob = (await q('SELECT * , original_amount::text amt, recognized_on::text d FROM obligations WHERE id=$1', [out.obligation_id]))[0];
    expect(ob).toMatchObject({ company_id: A.id, invoice_id: id, source_type: 'invoice', verification_status: 'confirmed', direction: 'receivable', amt: '115.00', d: '2026-03-10' });
    const j = (await q(`SELECT *, accounting_date::text d FROM journal_entries WHERE id=$1`, [out.journal_id]))[0];
    expect(j).toMatchObject({ status: 'draft', source_type: 'obligation', source_id: out.obligation_id, fiscal_year_id: A.fy, d: '2026-03-10' });
    const lines = await q('SELECT account_id, debit::text, credit::text, memo FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence', [out.journal_id]);
    expect(lines).toEqual([
      { account_id: A.acc.receivable, debit: '115.00', credit: '0.00', memo: null },
      { account_id: A.acc.sales_revenue, debit: '0.00', credit: '100.00', memo: null },
      { account_id: A.acc.vat_output, debit: '0.00', credit: '15.00', memo: null }]);
    for (const action of ['invoice.approve', 'obligation.create', 'journal.create']) {
      expect(await n(`SELECT count(*) n FROM audit_log WHERE company_id=$1 AND action=$2 AND created_at > NOW() - interval '1 minute'`, [A.id, action])).toBeGreaterThan(0);
    }
    expect(await n(`SELECT count(*) n FROM journal_entries WHERE company_id=$1 AND status='posted'`, [A.id])).toBe(0);
  });

  it('posting the draft journal of a VAT-bearing invoice is refused (VAT not recognized yet)', async () => {
    const id = await submitted(A);
    const out = await approve(A, approver, id, await version(id));
    const { AccountingService } = await import('../src/modules/accounting/accounting.router');
    await expect(new AccountingService(pool).post(A.id, approver, out.journal_id)).rejects.toThrow(/VAT recognition is not enabled/);
    expect((await q('SELECT status FROM journal_entries WHERE id=$1', [out.journal_id]))[0].status).toBe('draft');
  });

  it('a zero-VAT invoice journal posts through the existing service and reconciles with the obligation', async () => {
    const id = await submitted(B, 'sales', '2026-08-01', 0);
    const out = await approve(B, approver, id, await version(id));
    const { AccountingService } = await import('../src/modules/accounting/accounting.router');
    await new AccountingService(pool).post(B.id, approver, out.journal_id);
    const sums = (await q(`SELECT SUM(debit)::text d, SUM(credit)::text c FROM journal_lines WHERE journal_entry_id=$1`, [out.journal_id]))[0];
    expect(sums).toEqual({ d: '100.00', c: '100.00' });
    expect(await n(`SELECT COALESCE(SUM(l.debit-l.credit),0) n FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.id=$1 AND l.account_id=$2`, [out.journal_id, B.acc.receivable]))
      .toBe(Number((await q('SELECT original_amount FROM obligations WHERE id=$1', [out.obligation_id]))[0].original_amount));
  });

  it('purchase without VAT: payable obligation, Dr expense / Cr payable; purchase with VAT is refused', async () => {
    const p = await submitted(A, 'purchase');
    const out = await approve(A, approver, p, await version(p));
    expect((await q('SELECT direction FROM obligations WHERE id=$1', [out.obligation_id]))[0].direction).toBe('payable');
    expect(await q('SELECT account_id, debit::text, credit::text FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence', [out.journal_id])).toEqual([
      { account_id: A.acc.purchase_expense, debit: '100.00', credit: '0.00' }, { account_id: A.acc.payable, debit: '0.00', credit: '100.00' }]);
    const pv = await submitted(A, 'purchase', '2026-03-10', 15);
    await expect(approve(A, approver, pv, await version(pv))).rejects.toMatchObject({ code: 'INVOICE_VAT_PREREQUISITE' });
  });

  it('missing, inactive or wrong-type mapping rejects approval and rolls everything back', async () => {
    const E = await company('e');
    const id = await submitted(E);
    await expect(approve(E, approver, id, await version(id))).rejects.toMatchObject({ code: 'INVOICE_MAPPING_MISSING' });
    await mapAll(E);
    await q('UPDATE accounts SET is_active=false WHERE id=$1', [E.acc.vat_output]);
    await expect(approve(E, approver, id, await version(id))).rejects.toMatchObject({ code: 'INVOICE_MAPPING_MISSING' });
    await q('UPDATE accounts SET is_active=true WHERE id=$1', [E.acc.vat_output]);
    await q(`UPDATE accounts SET account_type='expense' WHERE id=$1`, [E.acc.sales_revenue]);
    await expect(approve(E, approver, id, await version(id))).rejects.toMatchObject({ code: 'INVOICE_MAPPING_MISSING' });
    expect((await q('SELECT status FROM invoices WHERE id=$1', [id]))[0].status).toBe('submitted');
    for (const t of ['invoice_number_counters', 'obligations', 'journal_entries']) expect(await n(`SELECT count(*) n FROM ${t} WHERE company_id=$1`, [E.id])).toBe(0);
  });

  it('requires the existing accounting permissions', async () => {
    const id = await submitted(A);
    await expect(approve(A, approver, id, await version(id), ['accounting.journal.create'])).rejects.toMatchObject({ status: 403, code: 'INVOICE_FORBIDDEN' });
  });

  it('invoice-backed obligations are frozen and unique per invoice', async () => {
    const id = await submitted(A);
    const out = await approve(A, approver, id, await version(id));
    expect(await code(q('UPDATE obligations SET original_amount=1 WHERE id=$1', [out.obligation_id]))).toBe('23514');
    expect(await code(q('UPDATE obligations SET is_cancelled=true WHERE id=$1', [out.obligation_id]))).toBe('23514');
    expect(await code(q(`UPDATE obligations SET verification_status='unconfirmed' WHERE id=$1`, [out.obligation_id]))).toBe('23514');
    expect(await code(q('DELETE FROM obligations WHERE id=$1', [out.obligation_id]))).toBe('23514');
    expect(await code(q(`UPDATE obligations SET due_on='2026-12-31' WHERE id=$1`, [out.obligation_id]))).toBe('ok');
    expect(await code(q(`INSERT INTO obligations (company_id, direction, counterparty_id, invoice_id, original_amount, recognized_on, verification_status, source_type, created_by_user_id)
      VALUES ($1,'receivable',$2,$3,115,'2026-03-10','confirmed','invoice',$4)`, [A.id, A.cust, id, approver]))).toBe('23505');
    expect(await code(q(`INSERT INTO obligations (company_id, direction, counterparty_id, invoice_id, original_amount, recognized_on, verification_status, source_type, created_by_user_id)
      VALUES ($1,'receivable',$2,$3,115,'2026-03-10','confirmed','manual',$4)`, [A.id, A.cust, id, approver]))).toBe('23514');
    expect(await code(q(`INSERT INTO obligations (company_id, direction, counterparty_id, invoice_id, original_amount, recognized_on, verification_status, source_type, created_by_user_id)
      VALUES ($1,'receivable',$2,$3,115,'2026-03-10','confirmed','invoice',$4)`, [B.id, B.cust, await submitted(A), approver]))).toBe('23503');
  });

  it('numbers per direction independently and sequentially', async () => {
    const G = await company('g'); await mapAll(G);
    const p = await submitted(G, 'purchase');
    expect((await approve(G, approver, p, await version(p))).invoice.internal_number).toBe('1');
    const s = await submitted(G, 'sales');
    expect((await approve(G, approver, s, await version(s))).invoice.internal_number).toBe('1');
    const s2 = await submitted(G, 'sales');
    expect((await approve(G, approver, s2, await version(s2))).invoice.internal_number).toBe('2');
  });

  it('concurrent approvals of different invoices get unique gapless numbers that reconcile with the counter', async () => {
    const H = await company('h'); await mapAll(H);
    const ids = await Promise.all(Array.from({ length: 6 }, () => submitted(H, 'sales')));
    const vs = await Promise.all(ids.map(version));
    const res = await Promise.all(ids.map((id, i) => approve(H, approver, id, vs[i]!)));
    const nums = res.map((r) => Number(r.invoice.internal_number)).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await n(`SELECT last_number n FROM invoice_number_counters WHERE company_id=$1 AND direction='sales'`, [H.id])).toBe(6);
  });

  it('the same invoice approved concurrently: one winner, one number consumed', async () => {
    const id = await submitted(A, 'sales', '2026-04-01');
    const v = await version(id);
    const before = await n(`SELECT last_number n FROM invoice_number_counters WHERE company_id=$1 AND direction='sales'`, [A.id]);
    const r = await Promise.allSettled([approve(A, approver, id, v), approve(A, approver, id, v)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.status).toBe(409);
    expect(await n(`SELECT last_number n FROM invoice_number_counters WHERE company_id=$1 AND direction='sales'`, [A.id])).toBe(before + 1);
  });

  it('rejects wrong state, stale version, already approved', async () => {
    const d = (await q(`INSERT INTO invoices (company_id, direction, counterparty_id, issue_date, subtotal_amount, vat_amount, total_amount, created_by_user_id)
      VALUES ($1,'sales',$2,'2026-03-10',1,0,1,$3) RETURNING id`, [A.id, A.cust, creator]))[0].id;
    await expect(approve(A, approver, d, 1)).rejects.toMatchObject({ code: 'INVOICE_NOT_SUBMITTED' });
    const s = await submitted(A);
    await expect(approve(A, approver, s, 999)).rejects.toMatchObject({ code: 'INVOICE_VERSION_CONFLICT' });
    const ok = await approve(A, approver, s, await version(s));
    await expect(approve(A, approver, s, ok.invoice.version)).rejects.toMatchObject({ code: 'INVOICE_ALREADY_APPROVED' });
  });

  it('strictly prohibits self-approval (no override exists)', async () => {
    const id = await submitted(A);
    await expect(approve(A, creator, id, await version(id))).rejects.toMatchObject({ code: 'INVOICE_SELF_APPROVAL' });
    expect((await q('SELECT status FROM invoices WHERE id=$1', [id]))[0].status).toBe('submitted');
    expect(approval.approve.length).toBe(5);
  });

  it('tenant isolation: another company cannot approve', async () => {
    const id = await submitted(A);
    await expect(approve(B, approver, id, await version(id))).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('closed period rolls back without consuming a number', async () => {
    const C = await company('c'); await mapAll(C);
    await q(`INSERT INTO monthly_close_periods (company_id, fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,'2026-05-01','2026-05-31','closed')`, [C.id, C.fy]);
    const id = await submitted(C, 'sales', '2026-05-15');
    await expect(approve(C, approver, id, await version(id))).rejects.toMatchObject({ code: 'INVOICE_PERIOD_CLOSED' });
    expect(await n('SELECT count(*) n FROM invoice_number_counters WHERE company_id=$1', [C.id])).toBe(0);
    expect((await q('SELECT status FROM invoices WHERE id=$1', [id]))[0].status).toBe('submitted');
    const open = await submitted(C, 'sales', '2026-06-15');
    expect((await approve(C, approver, open, await version(open))).invoice.internal_number).toBe('1');
  });

  it('closed fiscal year, missing year and overlapping years are rejected', async () => {
    const D = await company('d'); await mapAll(D);
    const id = await submitted(D, 'sales', '2026-02-01');
    await q(`UPDATE fiscal_years SET status='closed' WHERE id=$1`, [D.fy]);
    await expect(approve(D, approver, id, await version(id))).rejects.toMatchObject({ code: 'INVOICE_FISCAL_YEAR_CLOSED' });
    const none = await submitted(D, 'sales', '2027-02-01');
    await expect(approve(D, approver, none, await version(none))).rejects.toMatchObject({ code: 'INVOICE_FISCAL_YEAR_UNRESOLVED' });
    await q(`INSERT INTO fiscal_years (company_id, name, start_date, end_date) VALUES ($1,'OV','2027-01-01','2027-12-31'),($1,'OV2','2027-06-01','2028-05-31')`, [D.id]);
    const overlap = await submitted(D, 'sales', '2027-07-01');
    await expect(approve(D, approver, overlap, await version(overlap))).rejects.toMatchObject({ code: 'INVOICE_FISCAL_YEAR_UNRESOLVED' });
    expect(await n('SELECT count(*) n FROM invoice_number_counters WHERE company_id=$1', [D.id])).toBe(0);
  });

  it('database guards still reject a direct draft -> approved jump', async () => {
    const d = (await q(`INSERT INTO invoices (company_id, direction, counterparty_id, issue_date, subtotal_amount, vat_amount, total_amount, created_by_user_id)
      VALUES ($1,'sales',$2,'2026-03-10',1,0,1,$3) RETURNING id`, [A.id, A.cust, creator]))[0].id;
    expect(await code(q(`UPDATE invoices SET status='approved', internal_number=999, fiscal_year_id=$2, approved_by_user_id=$3, approved_at=NOW() WHERE id=$1`, [d, A.fy, approver]))).toBe('23514');
  });

  describe('account mappings', () => {
    let F: Co;
    beforeAll(async () => { F = await company('f'); });
    it('starts empty (nothing invented) and reports every key missing', async () => {
      expect(await mappings.list(F.id)).toEqual([]);
      expect(await mappings.missingKeys(F.id)).toHaveLength(6);
    });
    it('rejects an account of the wrong type for the key', async () => {
      await expect(mappings.set(F.id, approver, 'sales_revenue', F.acct)).rejects.toMatchObject({ code: 'INVOICE_VALIDATION' });
    });
    it('sets, audits, replaces and clears an explicit mapping', async () => {
      await mappings.set(F.id, approver, 'receivable', F.acct);
      expect(await mappings.list(F.id)).toEqual([{ mapping_key: 'receivable', account_id: F.acct }]);
      expect(await mappings.missingKeys(F.id)).not.toContain('receivable');
      await mappings.set(F.id, approver, 'receivable', F.acct);
      expect(await n(`SELECT count(*) n FROM audit_log WHERE company_id=$1 AND action='invoice.account_mapping.set'`, [F.id])).toBe(2);
      await mappings.clear(F.id, approver, 'receivable');
      expect(await mappings.list(F.id)).toEqual([]);
    });
    it('rejects unknown keys, other-company accounts (service and database) and inactive accounts', async () => {
      await expect(mappings.set(F.id, approver, 'bogus', F.acct)).rejects.toMatchObject({ code: 'INVOICE_VALIDATION' });
      await expect(mappings.set(F.id, approver, 'payable', B.acct)).rejects.toMatchObject({ code: 'INVOICE_VALIDATION' });
      expect(await code(q(`INSERT INTO invoice_account_mappings (company_id, mapping_key, account_id, updated_by_user_id) VALUES ($1,'payable',$2,$3)`, [F.id, B.acct, approver]))).toBe('23503');
      const inactive = (await q(`INSERT INTO accounts (company_id, code, name, account_type, is_active) VALUES ($1,'9999','Off','asset',false) RETURNING id`, [F.id]))[0].id;
      await expect(mappings.set(F.id, approver, 'payable', inactive)).rejects.toMatchObject({ code: 'INVOICE_VALIDATION' });
      expect(await mappings.list(F.id)).toEqual([]);
    });
    it('a mapped account that is later deactivated counts as missing', async () => {
      const acc = (await q(`INSERT INTO accounts (company_id, code, name, account_type) VALUES ($1,'2200','L','liability') RETURNING id`, [F.id]))[0].id;
      await mappings.set(F.id, approver, 'payable', acc);
      await q('UPDATE accounts SET is_active=false WHERE id=$1', [acc]);
      expect(await mappings.missingKeys(F.id)).toContain('payable');
    });
  });
});
