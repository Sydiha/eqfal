import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// F4 invoice cancellation over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
// invoice.* permissions are explicit-grant-only (migration 063); this suite provisions them directly on test roles,
// standing in for the owner-authorized provisioning procedure.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Invoice-Cancel-1!';
const MISSING = '00000000-0000-4000-8000-000000000000';

describeDatabase('invoice cancel API (PostgreSQL)', () => {
  let pool: Pool;
  let server: http.Server;
  let base = '';
  const run = randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};

  class Client {
    cookie = '';
    constructor(private readonly email: string) {}
    async req(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
      const headers: Record<string, string> = { origin: base, ...extra };
      if (this.cookie) headers['cookie'] = this.cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${base}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';')[0]!;
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* empty */ }
      return { status: res.status, json };
    }
    async login() {
      const res = await this.req('POST', '/auth/login', { email: this.email, password: PASSWORD });
      if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    }
  }
  const clients: Record<string, Client> = {};
  const email = (label: string) => `invcan-${label}-${run}@example.test`;

  const draft = () => ({
    direction: 'sales', counterparty_id: ids.customerA, issue_date: '2026-10-01', tax_point_date: '2026-10-01',
    lines: [{ description: 'Consulting', quantity: '1', unit_price: '1000.00', vat_rate: '15', vat_treatment: 'standard' }],
  });
  const count = async (sql: string, p: unknown[]) => Number((await pool.query<{ n: string }>(sql, p)).rows[0]!.n);
  const APPROVER_CAPS = ['invoice.view', 'invoice.approve', 'obligation.confirm', 'accounting.journal.create'];

  beforeAll(async () => {
    const { default: sharedPool } = await import('../src/db/pool');
    const { default: app } = await import('../src/app');
    const { CompanyManagementService } = await import('../src/modules/companies/company.service');
    const { InvoiceAccountMappingService } = await import('../src/modules/invoices/invoice-account-mapping.service');
    pool = sharedPool!;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const mkUser = async (label: string) => (await pool.query<{ id: string }>('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email(label), hash])).rows[0]!.id;
    for (const label of ['ownerA', 'ownerB', 'creator', 'approver', 'canceller', 'cancellerB']) ids[label] = await mkUser(label);
    const companies = new CompanyManagementService(pool);
    ids.coA = (await companies.create({ slug: `invcan-a-${run}`, name: `INVCAN-A-${run}`, name_ar: null }, ids.ownerA!)).id;
    ids.coB = (await companies.create({ slug: `invcan-b-${run}`, name: `INVCAN-B-${run}`, name_ar: null }, ids.ownerB!)).id;
    const role = async (company: string, name: string, caps: string[]) => {
      const id = (await pool.query<{ id: string }>('INSERT INTO roles(company_id,name) VALUES($1,$2) RETURNING id', [company, name])).rows[0]!.id;
      for (const c of caps) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [id, c]);
      return id;
    };
    const member = (user: string, company: string, roleId: string) => pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [user, company, roleId]);
    await member(ids.creator!, ids.coA!, await role(ids.coA!, 'Creator', ['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit']));
    await member(ids.approver!, ids.coA!, await role(ids.coA!, 'Approver', APPROVER_CAPS));
    // Holds invoice.approve but not the accounting capabilities the service also requires.
    await member(ids.canceller!, ids.coA!, await role(ids.coA!, 'Canceller', ['invoice.view', 'invoice.cancel']));
    await member(ids.cancellerB!, ids.coB!, await role(ids.coB!, 'CancellerB', ['invoice.view', 'invoice.cancel']));
    ids.fy = (await pool.query<{ id: string }>("INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY26','2026-01-01','2026-12-31') RETURNING id", [ids.coA])).rows[0]!.id;
    const mappings = new InvoiceAccountMappingService(pool);
    for (const [k, t] of Object.entries({ receivable: 'asset', payable: 'liability', sales_revenue: 'revenue', purchase_expense: 'expense', vat_output: 'liability', vat_input: 'asset' })) {
      const acc = (await pool.query<{ id: string }>('INSERT INTO accounts(company_id,code,name,account_type) VALUES($1,$2,$2,$3) RETURNING id', [ids.coA, `F1-${k}`, t])).rows[0]!.id;
      await mappings.set(ids.coA!, ids.approver!, k, acc);
    }
    const cp = async (company: string, name: string, type: string) => (await pool.query<{ id: string }>(
      'INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,$2,$3,true,$4) RETURNING id', [company, name, type, ids.ownerA])).rows[0]!.id;
    ids.customerA = await cp(ids.coA!, 'Customer A', 'customer');
    for (const label of ['ownerA', 'ownerB', 'creator', 'approver', 'canceller', 'cancellerB']) { clients[label] = new Client(email(label)); await clients[label]!.login(); }
  });
  afterAll(() => { server.close(); });

  const created = async (over: Record<string, unknown> = {}) => (await clients.creator!.req('POST', '/invoices', { ...draft(), ...over })).json.invoice;
  const submitted = async () => { const c = await created(); return (await clients.creator!.req('POST', `/invoices/${c.id}/submit`, { version: c.version })).json.invoice; };
  const approved = async () => { const s = await submitted(); const r = await clients.approver!.req('POST', `/invoices/${s.id}/approve`, { version: s.version }); expect(r.status).toBe(200); return r.json; };
  const cancel = (who: string, inv: { id: string; version: number }, reason: string | null = 'Issued by mistake', version = inv.version) =>
    clients[who]!.req('POST', `/invoices/${inv.id}/cancel`, reason === null ? { version } : { version, reason });
  const footprint = async (id: string) => ({
    obligations: await count('SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1', [id]),
    vat: await count('SELECT COUNT(*)::text n FROM invoice_vat_reviews WHERE invoice_id=$1', [id]),
    numbers: await count('SELECT COUNT(*)::text n FROM invoice_number_counters WHERE company_id=$1', [ids.coA]),
  });

  it('registers invoice.cancel as explicit-grant-only; Full Access, creators and approvers are refused', async () => {
    const row = (await pool.query<{ implicit_full_access: boolean }>("SELECT implicit_full_access FROM capabilities WHERE id='invoice.cancel'")).rows[0];
    expect(row?.implicit_full_access).toBe(false);
    expect((await pool.query("SELECT 1 FROM role_capabilities WHERE capability_id='invoice.cancel' AND role_id IN (SELECT id FROM roles WHERE is_full_access)")).rowCount).toBe(0);
    const inv = await created();
    expect((await cancel('ownerA', inv)).status).toBe(403);
    expect((await cancel('creator', inv)).status).toBe(403);
    expect((await cancel('approver', inv)).status).toBe(403);
    expect((await clients.canceller!.req('POST', `/invoices/${inv.id}/cancel`, { version: inv.version, reason: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await pool.query('SELECT status FROM invoices WHERE id=$1', [inv.id])).rows[0].status).toBe('draft');
  });

  it('cancels a draft: reason, actor and time kept, no accounting records, audited, history visible', async () => {
    const inv = await created();
    const res = await cancel('canceller', inv, '  Issued by mistake  ');
    expect(res.status).toBe(200);
    expect(res.json.invoice.status).toBe('cancelled');
    expect(res.json.invoice.version).toBe(inv.version + 1);
    expect(res.json.invoice.actionable_status).toBe('cancelled');
    expect(res.json.invoice.cancellation).toMatchObject({ cancelled_by_user_id: ids.canceller, reason: 'Issued by mistake' });
    expect(res.json.invoice.cancellation.cancelled_at).toBeTruthy();
    expect(res.json.invoice.adjustments).toEqual([]);
    expect(await footprint(inv.id)).toEqual({ obligations: 0, vat: 0, numbers: 0 });
    expect(await count("SELECT COUNT(*)::text n FROM invoice_lines WHERE invoice_id=$1", [inv.id])).toBe(1); // original lines preserved
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='invoice.cancel'", [inv.id])).toBe(1);
    const read = (await clients.canceller!.req('GET', `/invoices/${inv.id}`)).json.invoice;
    expect(read.status).toBe('cancelled');
    expect(read.cancellation.reason).toBe('Issued by mistake');
    const active = (await clients.canceller!.req('GET', '/invoices?status=cancelled')).json;
    expect(JSON.stringify(active)).toContain(inv.id);
  });

  it('cancels a submitted invoice with the same guarantees (no number, obligation, journal or VAT existed)', async () => {
    const inv = await submitted();
    const res = await cancel('canceller', inv);
    expect(res.status).toBe(200);
    expect(res.json.invoice.status).toBe('cancelled');
    expect(res.json.invoice.internal_number).toBeNull();
    expect(await footprint(inv.id)).toEqual({ obligations: 0, vat: 0, numbers: 0 });
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='invoice.cancel'", [inv.id])).toBe(1);
  });

  it('a cancelled invoice is final: cannot be edited, submitted, returned, approved or cancelled again', async () => {
    const inv = await created();
    const done = (await cancel('canceller', inv)).json.invoice;
    expect((await cancel('canceller', done)).json.code).toBe('INVOICE_ALREADY_CANCELLED');
    expect((await clients.creator!.req('PUT', `/invoices/${inv.id}`, { counterparty_id: ids.customerA, issue_date: '2026-10-01', tax_point_date: '2026-10-01', version: done.version, lines: draft().lines })).status).toBe(409);
    expect((await clients.creator!.req('POST', `/invoices/${inv.id}/submit`, { version: done.version })).json.code).toBe('INVOICE_NOT_DRAFT');
    expect((await clients.creator!.req('POST', `/invoices/${inv.id}/return`, { version: done.version })).json.code).toBe('INVOICE_NOT_SUBMITTED');
    expect((await clients.approver!.req('POST', `/invoices/${inv.id}/approve`, { version: done.version })).status).toBe(409);
    expect((await pool.query('SELECT status FROM invoices WHERE id=$1', [inv.id])).rows[0].status).toBe('cancelled');
    await expect(pool.query("UPDATE invoices SET status='draft' WHERE id=$1", [inv.id])).rejects.toThrow(/immutable/);
  });

  it('rejects a missing/blank/oversized reason, a stale version and unknown ids', async () => {
    const inv = await created();
    expect((await cancel('canceller', inv, null)).status).toBe(400);
    expect((await cancel('canceller', inv, '   ')).status).toBe(400);
    expect((await cancel('canceller', inv, 'x'.repeat(501))).status).toBe(400);
    expect((await cancel('canceller', inv, 'ok', inv.version + 5)).json.code).toBe('INVOICE_VERSION_CONFLICT');
    expect((await clients.canceller!.req('POST', `/invoices/${MISSING}/cancel`, { version: 1, reason: 'x' })).status).toBe(404);
    expect((await clients.canceller!.req('POST', '/invoices/not-a-uuid/cancel', { version: 1, reason: 'x' })).status).toBe(404);
    expect((await pool.query('SELECT status FROM invoices WHERE id=$1', [inv.id])).rows[0].status).toBe('draft');
  });

  it('concurrent cancels of the same invoice: exactly one succeeds, one audit event', async () => {
    const inv = await created();
    const results = await Promise.all([1, 2, 3, 4].map(() => cancel('canceller', inv)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='invoice.cancel'", [inv.id])).toBe(1);
  });

  it('REJECTS cancelling an approved invoice and leaves number, obligation, draft journal, VAT snapshot and status untouched', async () => {
    const ok = await approved();
    const inv = ok.invoice;
    const res = await cancel('canceller', inv);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('INVOICE_CANCEL_NOT_ALLOWED');
    const row = (await pool.query('SELECT status, internal_number, cancelled_at FROM invoices WHERE id=$1', [inv.id])).rows[0];
    expect(row).toMatchObject({ status: 'approved', internal_number: inv.internal_number, cancelled_at: null });
    expect(await count("SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1 AND NOT is_cancelled", [inv.id])).toBe(1);
    expect(await count("SELECT COUNT(*)::text n FROM journal_entries WHERE source_id=$1 AND status='draft'", [ok.obligation_id])).toBe(1);
    expect(await count('SELECT COUNT(*)::text n FROM invoice_vat_reviews WHERE invoice_id=$1', [inv.id])).toBe(1);
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='invoice.cancel'", [inv.id])).toBe(0);
  });

  it('REJECTS cancelling an approved invoice whose journal is posted or that already has a linked credit note, even through the database', async () => {
    const ok = await approved();
    const inv = ok.invoice;
    await pool.query("UPDATE journal_entries SET status='posted', posted_at=NOW(), posted_by=$3 WHERE source_id=$1 AND company_id=$2", [ok.obligation_id, ids.coA, ids.approver]);
    expect((await cancel('canceller', inv)).json.code).toBe('INVOICE_CANCEL_NOT_ALLOWED');
    await pool.query(
      `INSERT INTO invoice_adjustments (company_id, original_invoice_id, direction, adjustment_type, adjustment_date, subtotal_amount, vat_amount, total_amount, reason, created_by_user_id, counterparty_id, external_number)
       VALUES ($1,$2,'sales','credit','2026-10-02',100,15,115,'Returned goods',$3,$4,'CN-1')`, [ids.coA, inv.id, ids.creator, ids.customerA]);
    expect((await cancel('canceller', inv)).json.code).toBe('INVOICE_CANCEL_NOT_ALLOWED');
    const read = (await clients.canceller!.req('GET', `/invoices/${inv.id}`)).json.invoice;
    expect(read.adjustments).toHaveLength(1);
    expect(read.adjustments[0]).toMatchObject({ adjustment_type: 'credit', status: 'draft', total_amount: '115.00' });
    // The database itself refuses the direct shortcut (approved invoices are immutable except the controlled cancellation path).
    await expect(pool.query('DELETE FROM invoices WHERE id=$1', [inv.id])).rejects.toThrow();
    await expect(pool.query('DELETE FROM obligations WHERE invoice_id=$1', [inv.id])).rejects.toThrow(/cannot be deleted/);
  });

  it('tenant isolation: another company cannot cancel or even detect this invoice', async () => {
    const inv = await created();
    expect((await cancel('cancellerB', inv)).status).toBe(404);
    expect((await clients.cancellerB!.req('GET', `/invoices/${inv.id}`)).status).toBe(404);
    expect((await pool.query('SELECT status FROM invoices WHERE id=$1', [inv.id])).rows[0].status).toBe('draft');
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='invoice.cancel'", [inv.id])).toBe(0);
  });

  it('purchase invoices cancel the same way', async () => {
    const supplier = (await pool.query<{ id: string }>("INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,'Sup','supplier',true,$2) RETURNING id", [ids.coA, ids.ownerA])).rows[0]!.id;
    const inv = await created({ direction: 'purchase', counterparty_id: supplier, external_reference: `R-${run}`, lines: [{ description: 'Goods', quantity: '1', unit_price: '500.00', vat_rate: '15', vat_treatment: 'standard', vat_recoverability: 'fully_recoverable' }] });
    expect(inv?.id).toBeTruthy();
    const res = await cancel('canceller', inv);
    expect(res.status).toBe(200);
    expect(res.json.invoice.direction).toBe('purchase');
    expect(res.json.invoice.status).toBe('cancelled');
  });
});
