import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// F1 invoice approval over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
// invoice.* permissions are explicit-grant-only (migration 063); this suite provisions them directly on test roles,
// standing in for the owner-authorized provisioning procedure.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Invoice-Approve-1!';
const MISSING = '00000000-0000-4000-8000-000000000000';

describeDatabase('invoice approve API (PostgreSQL)', () => {
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
  const email = (label: string) => `invapp-${label}-${run}@example.test`;

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
    for (const label of ['ownerA', 'ownerB', 'creator', 'approver', 'weakApprover', 'dual', 'approverB']) ids[label] = await mkUser(label);
    const companies = new CompanyManagementService(pool);
    ids.coA = (await companies.create({ slug: `invapp-a-${run}`, name: `INVAPP-A-${run}`, name_ar: null }, ids.ownerA!)).id;
    ids.coB = (await companies.create({ slug: `invapp-b-${run}`, name: `INVAPP-B-${run}`, name_ar: null }, ids.ownerB!)).id;
    const role = async (company: string, name: string, caps: string[]) => {
      const id = (await pool.query<{ id: string }>('INSERT INTO roles(company_id,name) VALUES($1,$2) RETURNING id', [company, name])).rows[0]!.id;
      for (const c of caps) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [id, c]);
      return id;
    };
    const member = (user: string, company: string, roleId: string) => pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [user, company, roleId]);
    await member(ids.creator!, ids.coA!, await role(ids.coA!, 'Creator', ['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit']));
    await member(ids.approver!, ids.coA!, await role(ids.coA!, 'Approver', APPROVER_CAPS));
    // Holds invoice.approve but not the accounting capabilities the service also requires.
    await member(ids.weakApprover!, ids.coA!, await role(ids.coA!, 'WeakApprover', ['invoice.view', 'invoice.approve']));
    // Creates AND approves: self-approval must still be refused.
    await member(ids.dual!, ids.coA!, await role(ids.coA!, 'Dual', [...APPROVER_CAPS, 'invoice.create', 'invoice.edit', 'invoice.submit']));
    await member(ids.approverB!, ids.coB!, await role(ids.coB!, 'ApproverB', APPROVER_CAPS));
    ids.fy = (await pool.query<{ id: string }>("INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY26','2026-01-01','2026-12-31') RETURNING id", [ids.coA])).rows[0]!.id;
    const mappings = new InvoiceAccountMappingService(pool);
    for (const [k, t] of Object.entries({ receivable: 'asset', payable: 'liability', sales_revenue: 'revenue', purchase_expense: 'expense', vat_output: 'liability', vat_input: 'asset' })) {
      const acc = (await pool.query<{ id: string }>('INSERT INTO accounts(company_id,code,name,account_type) VALUES($1,$2,$2,$3) RETURNING id', [ids.coA, `F1-${k}`, t])).rows[0]!.id;
      await mappings.set(ids.coA!, ids.approver!, k, acc);
    }
    const cp = async (company: string, name: string, type: string) => (await pool.query<{ id: string }>(
      'INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,$2,$3,true,$4) RETURNING id', [company, name, type, ids.ownerA])).rows[0]!.id;
    ids.customerA = await cp(ids.coA!, 'Customer A', 'customer');
    for (const label of ['ownerA', 'ownerB', 'creator', 'approver', 'weakApprover', 'dual', 'approverB']) { clients[label] = new Client(email(label)); await clients[label]!.login(); }
  });
  afterAll(() => { server.close(); });

  const submitted = async (by = 'creator', over: Record<string, unknown> = {}) => {
    const created = (await clients[by]!.req('POST', '/invoices', { ...draft(), ...over })).json.invoice;
    return (await clients[by]!.req('POST', `/invoices/${created.id}/submit`, { version: created.version })).json.invoice;
  };
  const approve = (who: string, inv: { id: string; version: number }, version = inv.version) => clients[who]!.req('POST', `/invoices/${inv.id}/approve`, { version });

  it('registers invoice.approve as explicit-grant-only; Full Access and company owners are refused', async () => {
    const row = (await pool.query<{ implicit_full_access: boolean }>("SELECT implicit_full_access FROM capabilities WHERE id='invoice.approve'")).rows[0];
    expect(row?.implicit_full_access).toBe(false);
    expect((await pool.query("SELECT 1 FROM role_capabilities WHERE capability_id='invoice.approve' AND role_id IN (SELECT id FROM roles WHERE is_full_access)")).rowCount).toBe(0);
    const inv = await submitted();
    expect((await approve('ownerA', inv)).status).toBe(403);
    expect((await approve('creator', inv)).status).toBe(403);
    expect((await clients.approver!.req('POST', `/invoices/${inv.id}/approve`, { version: inv.version }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await pool.query('SELECT status FROM invoices WHERE id=$1', [inv.id])).rows[0].status).toBe('submitted');
  });

  it('approval also requires obligation.confirm and accounting.journal.create', async () => {
    const inv = await submitted();
    const res = await approve('weakApprover', inv);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('INVOICE_FORBIDDEN');
    expect(await count('SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1', [inv.id])).toBe(0);
  });

  it('approves: one number, one confirmed obligation, one DRAFT journal, one VAT snapshot, never posted, audited', async () => {
    const inv = await submitted();
    const res = await approve('approver', inv);
    expect(res.status).toBe(200);
    expect(res.json.invoice.status).toBe('approved');
    expect(res.json.invoice.internal_number).toMatch(/^\d+$/);
    expect(res.json.invoice.approved_by_user_id).toBe(ids.approver);
    expect(await count("SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1 AND verification_status='confirmed' AND source_type='invoice'", [inv.id])).toBe(1);
    expect(await count("SELECT COUNT(*)::text n FROM journal_entries WHERE source_id=$1 AND source_type='obligation' AND status='draft'", [res.json.obligation_id])).toBe(1);
    expect(await count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_id=$2 AND status='posted'", [ids.coA, res.json.obligation_id])).toBe(0);
    expect(await count('SELECT COUNT(*)::text n FROM invoice_vat_reviews WHERE invoice_id=$1', [inv.id])).toBe(1);
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='invoice.approve'", [inv.id])).toBe(1);
  });

  it('read model exposes obligation, journal status, VAT status, paid and outstanding amounts and an actionable status', async () => {
    const inv = await submitted();
    const before = (await clients.approver!.req('GET', `/invoices/${inv.id}`)).json.invoice;
    expect(before).toMatchObject({ obligation: null, journal: null, paid_amount: null, outstanding_amount: null, actionable_status: 'awaiting_approval' });
    expect(before.vat.status).toBe('pending');
    const res = await approve('approver', inv);
    const after = (await clients.approver!.req('GET', `/invoices/${inv.id}`)).json.invoice;
    expect(after.obligation.id).toBe(res.json.obligation_id);
    expect(after.journal).toEqual({ id: res.json.journal_id, status: 'draft' });
    expect(after.vat.status).toBe('reviewed');
    expect(after.vat.review_id).toBe(res.json.vat_review_id);
    expect(after.paid_amount).toBe('0.00');
    expect(after.outstanding_amount).toBe('1150.00');
    expect(after.actionable_status).toBe('awaiting_posting');
    expect(res.json.invoice.actionable_status).toBe('awaiting_posting');
    // Posting is a separate action: simulate it to prove the read model follows the authoritative journal row.
    await pool.query("UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE id=$1", [res.json.journal_id, ids.approver]);
    const posted = (await clients.approver!.req('GET', `/invoices/${inv.id}`)).json.invoice;
    expect(posted.journal.status).toBe('posted');
    expect(posted.actionable_status).toBe('awaiting_settlement');
    const listed = (await clients.approver!.req('GET', '/invoices?status=approved&limit=100')).json.invoices.find((i: { id: string }) => i.id === inv.id);
    expect(listed).toMatchObject({ outstanding_amount: '1150.00', actionable_status: 'awaiting_settlement' });
  });

  it('prevents self-approval even for a user holding every approval capability', async () => {
    const inv = await submitted('dual');
    const res = await approve('dual', inv);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('INVOICE_SELF_APPROVAL');
    expect(await count('SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1', [inv.id])).toBe(0);
    expect((await pool.query('SELECT internal_number FROM invoices WHERE id=$1', [inv.id])).rows[0].internal_number).toBeNull();
  });

  it('duplicate and concurrent requests create exactly one number, obligation and journal', async () => {
    const inv = await submitted();
    const results = await Promise.all([1, 2, 3, 4].map(() => approve('approver', inv)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await count('SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1', [inv.id])).toBe(1);
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='invoice.approve'", [inv.id])).toBe(1);
    const again = await approve('approver', inv, inv.version + 1);
    expect(again.json.code).toBe('INVOICE_ALREADY_APPROVED');
  });

  it('rejects stale versions, bad input, non-submitted invoices and unknown ids', async () => {
    const inv = await submitted();
    expect((await approve('approver', inv, inv.version + 3)).json.code).toBe('INVOICE_VERSION_CONFLICT');
    expect((await clients.approver!.req('POST', `/invoices/${inv.id}/approve`, {})).status).toBe(400);
    expect((await clients.approver!.req('POST', `/invoices/${MISSING}/approve`, { version: 1 })).status).toBe(404);
    expect((await clients.approver!.req('POST', '/invoices/not-a-uuid/approve', { version: 1 })).status).toBe(404);
    const created = (await clients.creator!.req('POST', '/invoices', draft())).json.invoice;
    expect((await approve('approver', created)).json.code).toBe('INVOICE_NOT_SUBMITTED');
    expect(await count('SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1', [inv.id])).toBe(0);
  });

  it('a closed accounting period blocks approval without consuming a number or leaving records', async () => {
    const inv = await submitted('creator', { issue_date: '2026-06-10', tax_point_date: '2026-06-10' });
    await pool.query("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-06-01','2026-06-30','closed')", [ids.coA, ids.fy]);
    const res = await approve('approver', inv);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('INVOICE_PERIOD_CLOSED');
    expect(await count('SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1', [inv.id])).toBe(0);
    expect((await pool.query('SELECT status, internal_number FROM invoices WHERE id=$1', [inv.id])).rows[0]).toMatchObject({ status: 'submitted', internal_number: null });
  });

  it('a closed VAT period blocks approval', async () => {
    const inv = await submitted('creator', { issue_date: '2026-07-10', tax_point_date: '2026-07-10' });
    await pool.query("INSERT INTO vat_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-07-01','2026-07-31','closed')", [ids.coA, ids.fy]);
    const res = await approve('approver', inv);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('INVOICE_VAT_PERIOD_CLOSED');
    expect(await count('SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1', [inv.id])).toBe(0);
  });

  it('a missing account mapping blocks approval and rolls everything back', async () => {
    const inv = await submitted();
    const saved = (await pool.query<{ account_id: string }>("SELECT account_id FROM invoice_account_mappings WHERE company_id=$1 AND mapping_key='sales_revenue'", [ids.coA])).rows[0]!.account_id;
    await pool.query("DELETE FROM invoice_account_mappings WHERE company_id=$1 AND mapping_key='sales_revenue'", [ids.coA]);
    try {
      const res = await approve('approver', inv);
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('INVOICE_MAPPING_MISSING');
      expect(await count('SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1', [inv.id])).toBe(0);
      expect((await pool.query('SELECT internal_number FROM invoices WHERE id=$1', [inv.id])).rows[0].internal_number).toBeNull();
    } finally {
      await pool.query("INSERT INTO invoice_account_mappings(company_id,mapping_key,account_id,updated_by_user_id) VALUES($1,'sales_revenue',$2,$3)", [ids.coA, saved, ids.approver]);
    }
  });

  it('tenant isolation: another company cannot approve or read this invoice', async () => {
    const inv = await submitted();
    expect((await approve('approverB', inv)).status).toBe(404);
    expect((await clients.approverB!.req('GET', `/invoices/${inv.id}`)).status).toBe(404);
    expect((await pool.query('SELECT status FROM invoices WHERE id=$1', [inv.id])).rows[0].status).toBe('submitted');
    expect(await count('SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1', [inv.id])).toBe(0);
  });
});
