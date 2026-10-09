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
  type Co = { id: string; fy: string; cust: string; supp: string; acct: string };
  let A: Co; let B: Co;

  async function company(label: string): Promise<Co> {
    const id = (await q('INSERT INTO companies (slug, name) VALUES ($1,$1) RETURNING id', [`ia-${label}-${run}`]))[0].id;
    const fy = (await q(`INSERT INTO fiscal_years (company_id, name, start_date, end_date) VALUES ($1,'FY','2026-01-01','2026-12-31') RETURNING id`, [id]))[0].id;
    const cust = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'C','customer',$2) RETURNING id`, [id, creator]))[0].id;
    const supp = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'S','supplier',$2) RETURNING id`, [id, creator]))[0].id;
    const acct = (await q(`INSERT INTO accounts (company_id, code, name, account_type) VALUES ($1,'1100','Test','asset') RETURNING id`, [id]))[0].id;
    return { id, fy, cust, supp, acct };
  }
  async function submitted(co: Co, direction: 'sales' | 'purchase' = 'sales', issue = '2026-03-10', by = creator) {
    const id = (await q(
      `INSERT INTO invoices (company_id, direction, counterparty_id, issue_date, subtotal_amount, vat_amount, total_amount, created_by_user_id)
       VALUES ($1,$2,$3,$4,100,15,115,$5) RETURNING id`, [co.id, direction, direction === 'sales' ? co.cust : co.supp, issue, by]))[0].id;
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
  });
  afterAll(async () => { await pool?.end(); });

  it('approves: number, fiscal year, audit, version; no obligation/journal/VAT side effects', async () => {
    const id = await submitted(A);
    const v = await version(id);
    const out = await approval.approve(A.id, approver, id, v);
    expect(out.status).toBe('approved'); expect(out.internal_number).toBe('1'); expect(out.fiscal_year_id).toBe(A.fy);
    expect(out.approved_by_user_id).toBe(approver); expect(out.version).toBe(v + 1);
    expect(await n(`SELECT count(*) n FROM audit_log WHERE company_id=$1 AND action='invoice.approve' AND entity_id=$2`, [A.id, id])).toBe(1);
    expect(await n('SELECT count(*) n FROM obligations WHERE company_id=$1', [A.id])).toBe(0);
    expect(await n('SELECT count(*) n FROM journal_entries WHERE company_id=$1', [A.id])).toBe(0);
  });

  it('numbers per direction independently and sequentially', async () => {
    const p = await submitted(A, 'purchase');
    expect((await approval.approve(A.id, approver, p, await version(p))).internal_number).toBe('1');
    const s = await submitted(A, 'sales');
    expect((await approval.approve(A.id, approver, s, await version(s))).internal_number).toBe('2');
  });

  it('concurrent approvals of different invoices get unique gapless numbers that reconcile with the counter', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => submitted(B, 'sales')));
    const vs = await Promise.all(ids.map(version));
    const res = await Promise.all(ids.map((id, i) => approval.approve(B.id, approver, id, vs[i]!)));
    const nums = res.map((r) => Number(r.internal_number)).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await n(`SELECT last_number n FROM invoice_number_counters WHERE company_id=$1 AND direction='sales'`, [B.id])).toBe(6);
  });

  it('the same invoice approved concurrently: one winner, one number consumed', async () => {
    const id = await submitted(A, 'sales', '2026-04-01');
    const v = await version(id);
    const before = await n(`SELECT last_number n FROM invoice_number_counters WHERE company_id=$1 AND direction='sales'`, [A.id]);
    const r = await Promise.allSettled([approval.approve(A.id, approver, id, v), approval.approve(A.id, approver, id, v)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.status).toBe(409);
    expect(await n(`SELECT last_number n FROM invoice_number_counters WHERE company_id=$1 AND direction='sales'`, [A.id])).toBe(before + 1);
  });

  it('rejects wrong state, stale version, already approved', async () => {
    const d = (await q(`INSERT INTO invoices (company_id, direction, counterparty_id, issue_date, subtotal_amount, vat_amount, total_amount, created_by_user_id)
      VALUES ($1,'sales',$2,'2026-03-10',1,0,1,$3) RETURNING id`, [A.id, A.cust, creator]))[0].id;
    await expect(approval.approve(A.id, approver, d, 1)).rejects.toMatchObject({ code: 'INVOICE_NOT_SUBMITTED' });
    const s = await submitted(A);
    await expect(approval.approve(A.id, approver, s, 999)).rejects.toMatchObject({ code: 'INVOICE_VERSION_CONFLICT' });
    const ok = await approval.approve(A.id, approver, s, await version(s));
    await expect(approval.approve(A.id, approver, s, ok.version)).rejects.toMatchObject({ code: 'INVOICE_ALREADY_APPROVED' });
  });

  it('enforces separation of duties by default; opt-in allows it', async () => {
    const id = await submitted(A);
    await expect(approval.approve(A.id, creator, id, await version(id))).rejects.toMatchObject({ code: 'INVOICE_SELF_APPROVAL' });
    expect((await q('SELECT status FROM invoices WHERE id=$1', [id]))[0].status).toBe('submitted');
    const out = await approval.approve(A.id, creator, id, await version(id), { allowSelfApproval: true });
    expect(out.status).toBe('approved');
  });

  it('tenant isolation: another company cannot approve', async () => {
    const id = await submitted(A);
    await expect(approval.approve(B.id, approver, id, await version(id))).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('closed period rolls back without consuming a number', async () => {
    const C = await company('c');
    await q(`INSERT INTO monthly_close_periods (company_id, fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,'2026-05-01','2026-05-31','closed')`, [C.id, C.fy]);
    const id = await submitted(C, 'sales', '2026-05-15');
    await expect(approval.approve(C.id, approver, id, await version(id))).rejects.toMatchObject({ code: 'INVOICE_PERIOD_CLOSED' });
    expect(await n('SELECT count(*) n FROM invoice_number_counters WHERE company_id=$1', [C.id])).toBe(0);
    expect((await q('SELECT status FROM invoices WHERE id=$1', [id]))[0].status).toBe('submitted');
    const open = await submitted(C, 'sales', '2026-06-15');
    expect((await approval.approve(C.id, approver, open, await version(open))).internal_number).toBe('1');
  });

  it('closed fiscal year, missing year and overlapping years are rejected', async () => {
    const D = await company('d');
    const id = await submitted(D, 'sales', '2026-02-01');
    await q(`UPDATE fiscal_years SET status='closed' WHERE id=$1`, [D.fy]);
    await expect(approval.approve(D.id, approver, id, await version(id))).rejects.toMatchObject({ code: 'INVOICE_FISCAL_YEAR_CLOSED' });
    const none = await submitted(D, 'sales', '2027-02-01');
    await expect(approval.approve(D.id, approver, none, await version(none))).rejects.toMatchObject({ code: 'INVOICE_FISCAL_YEAR_UNRESOLVED' });
    await q(`INSERT INTO fiscal_years (company_id, name, start_date, end_date) VALUES ($1,'OV','2027-01-01','2027-12-31'),($1,'OV2','2027-06-01','2028-05-31')`, [D.id]);
    const overlap = await submitted(D, 'sales', '2027-07-01');
    await expect(approval.approve(D.id, approver, overlap, await version(overlap))).rejects.toMatchObject({ code: 'INVOICE_FISCAL_YEAR_UNRESOLVED' });
    expect(await n('SELECT count(*) n FROM invoice_number_counters WHERE company_id=$1', [D.id])).toBe(0);
  });

  it('database guards still reject a direct draft -> approved jump', async () => {
    const d = (await q(`INSERT INTO invoices (company_id, direction, counterparty_id, issue_date, subtotal_amount, vat_amount, total_amount, created_by_user_id)
      VALUES ($1,'sales',$2,'2026-03-10',1,0,1,$3) RETURNING id`, [A.id, A.cust, creator]))[0].id;
    expect(await code(q(`UPDATE invoices SET status='approved', internal_number=999, fiscal_year_id=$2, approved_by_user_id=$3, approved_at=NOW() WHERE id=$1`, [d, A.fy, approver]))).toBe('23514');
  });

  describe('account mappings', () => {
    it('starts empty (nothing invented) and reports every key missing', async () => {
      expect(await mappings.list(A.id)).toEqual([]);
      expect(await mappings.missingKeys(A.id)).toHaveLength(6);
    });
    it('sets, audits, replaces and clears an explicit mapping', async () => {
      await mappings.set(A.id, approver, 'receivable', A.acct);
      expect(await mappings.list(A.id)).toEqual([{ mapping_key: 'receivable', account_id: A.acct }]);
      expect(await mappings.missingKeys(A.id)).not.toContain('receivable');
      await mappings.set(A.id, approver, 'receivable', A.acct);
      expect(await n(`SELECT count(*) n FROM audit_log WHERE company_id=$1 AND action='invoice.account_mapping.set'`, [A.id])).toBe(2);
      await mappings.clear(A.id, approver, 'receivable');
      expect(await mappings.list(A.id)).toEqual([]);
    });
    it('rejects unknown keys, other-company accounts (service and database) and inactive accounts', async () => {
      await expect(mappings.set(A.id, approver, 'bogus', A.acct)).rejects.toMatchObject({ code: 'INVOICE_VALIDATION' });
      await expect(mappings.set(A.id, approver, 'payable', B.acct)).rejects.toMatchObject({ code: 'INVOICE_VALIDATION' });
      expect(await code(q(`INSERT INTO invoice_account_mappings (company_id, mapping_key, account_id, updated_by_user_id) VALUES ($1,'payable',$2,$3)`, [A.id, B.acct, approver]))).toBe('23503');
      const inactive = (await q(`INSERT INTO accounts (company_id, code, name, account_type, is_active) VALUES ($1,'9999','Off','asset',false) RETURNING id`, [A.id]))[0].id;
      await expect(mappings.set(A.id, approver, 'payable', inactive)).rejects.toMatchObject({ code: 'INVOICE_VALIDATION' });
      expect(await mappings.list(A.id)).toEqual([]);
    });
    it('a mapped account that is later deactivated counts as missing', async () => {
      const acc = (await q(`INSERT INTO accounts (company_id, code, name, account_type) VALUES ($1,'2200','L','liability') RETURNING id`, [A.id]))[0].id;
      await mappings.set(A.id, approver, 'payable', acc);
      await q('UPDATE accounts SET is_active=false WHERE id=$1', [acc]);
      expect(await mappings.missingKeys(A.id)).toContain('payable');
    });
  });
});
