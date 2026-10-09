import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// PR-3A invoice submit/return over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
// invoice.* permissions are explicit-grant-only (migration 063); this suite provisions them directly on test roles,
// standing in for the owner-authorized provisioning procedure.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Invoice-Submit-1!';
const MISSING = '00000000-0000-4000-8000-000000000000';

describeDatabase('invoice submit/return API (PostgreSQL)', () => {
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
  const email = (label: string) => `invsub-${label}-${run}@example.test`;

  const draft = () => ({
    direction: 'sales', counterparty_id: ids.customerA, issue_date: '2026-10-01',
    lines: [{ description: 'Consulting', quantity: '1', unit_price: '1000.00', vat_rate: '15' }],
  });
  const putBody = () => { const { direction: _d, ...rest } = draft(); return rest; };
  const count = async (sql: string, p: unknown[]) => Number((await pool.query<{ n: string }>(sql, p)).rows[0]!.n);

  beforeAll(async () => {
    const { default: sharedPool } = await import('../src/db/pool');
    const { default: app } = await import('../src/app');
    const { CompanyManagementService } = await import('../src/modules/companies/company.service');
    pool = sharedPool!;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const mkUser = async (label: string) => (await pool.query<{ id: string }>('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email(label), hash])).rows[0]!.id;
    for (const label of ['ownerA', 'ownerB', 'submitter', 'editor']) ids[label] = await mkUser(label);
    const companies = new CompanyManagementService(pool);
    ids.coA = (await companies.create({ slug: `invsub-a-${run}`, name: `INVSUB-A-${run}`, name_ar: null }, ids.ownerA!)).id;
    ids.coB = (await companies.create({ slug: `invsub-b-${run}`, name: `INVSUB-B-${run}`, name_ar: null }, ids.ownerB!)).id;
    const role = async (company: string, name: string, caps: string[]) => {
      const id = (await pool.query<{ id: string }>('INSERT INTO roles(company_id,name) VALUES($1,$2) RETURNING id', [company, name])).rows[0]!.id;
      for (const c of caps) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [id, c]);
      return id;
    };
    const member = (user: string, company: string, roleId: string) => pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [user, company, roleId]);
    await member(ids.submitter!, ids.coA!, await role(ids.coA!, 'InvSubmitter', ['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit']));
    await member(ids.editor!, ids.coA!, await role(ids.coA!, 'InvEditorOnly', ['invoice.view', 'invoice.create', 'invoice.edit']));
    const fullB = (await pool.query<{ id: string }>('SELECT id FROM roles WHERE company_id=$1 AND is_full_access', [ids.coB])).rows[0]!.id;
    for (const c of ['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit']) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [fullB, c]);
    const cp = async (company: string, name: string, type: string) => (await pool.query<{ id: string }>(
      'INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,$2,$3,true,$4) RETURNING id', [company, name, type, ids.ownerA])).rows[0]!.id;
    ids.customerA = await cp(ids.coA!, 'Customer A', 'customer');
    for (const label of ['ownerA', 'ownerB', 'submitter', 'editor']) { clients[label] = new Client(email(label)); await clients[label]!.login(); }
  });
  afterAll(() => { server.close(); });

  const newDraft = async () => (await clients.submitter!.req('POST', '/invoices', draft())).json.invoice;

  it('invoice.submit is explicit-grant-only: Full Access and edit-only roles are refused', async () => {
    const inv = await newDraft();
    expect((await clients.ownerA!.req('POST', `/invoices/${inv.id}/submit`, { version: inv.version })).status).toBe(403);
    expect((await clients.editor!.req('POST', `/invoices/${inv.id}/submit`, { version: inv.version })).status).toBe(403);
    expect((await clients.editor!.req('POST', `/invoices/${inv.id}/return`, { version: inv.version })).status).toBe(403);
    expect((await clients.submitter!.req('POST', `/invoices/${inv.id}/submit`, { version: inv.version }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('submit freezes the draft with no number, obligation or journal; return reopens it; all audited', async () => {
    const inv = await newDraft();
    const s = await clients.submitter!.req('POST', `/invoices/${inv.id}/submit`, { version: inv.version });
    expect(s.status).toBe(200);
    expect(s.json.invoice.status).toBe('submitted');
    expect(s.json.invoice.version).toBe(inv.version + 1);
    expect(s.json.invoice.internal_number).toBeNull();
    expect(s.json.invoice.fiscal_year_id).toBeNull();
    expect((await clients.submitter!.req('PUT', `/invoices/${inv.id}`, { ...putBody(), version: s.json.invoice.version })).status).toBe(409);
    expect(await count('SELECT COUNT(*)::text n FROM invoice_number_counters WHERE company_id=$1', [ids.coA])).toBe(0);
    expect(await count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='invoice'", [ids.coA])).toBe(0);
    const r = await clients.submitter!.req('POST', `/invoices/${inv.id}/return`, { version: s.json.invoice.version });
    expect(r.status).toBe(200);
    expect(r.json.invoice.status).toBe('draft');
    expect((await clients.submitter!.req('PUT', `/invoices/${inv.id}`, { ...putBody(), version: r.json.invoice.version })).status).toBe(200);
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action IN ('invoice.submit','invoice.return')", [inv.id])).toBe(2);
  });

  it('rejects wrong state, stale version, bad input and unknown ids', async () => {
    const inv = await newDraft();
    expect((await clients.submitter!.req('POST', `/invoices/${inv.id}/return`, { version: inv.version })).json.code).toBe('INVOICE_NOT_SUBMITTED');
    expect((await clients.submitter!.req('POST', `/invoices/${inv.id}/submit`, { version: inv.version + 5 })).json.code).toBe('INVOICE_VERSION_CONFLICT');
    expect((await clients.submitter!.req('POST', `/invoices/${inv.id}/submit`, {})).status).toBe(400);
    expect((await clients.submitter!.req('POST', `/invoices/${MISSING}/submit`, { version: 1 })).status).toBe(404);
    expect((await clients.submitter!.req('POST', '/invoices/not-a-uuid/submit', { version: 1 })).status).toBe(404);
    await clients.submitter!.req('POST', `/invoices/${inv.id}/submit`, { version: inv.version });
    expect((await clients.submitter!.req('POST', `/invoices/${inv.id}/submit`, { version: inv.version + 1 })).json.code).toBe('INVOICE_NOT_DRAFT');
  });

  it('concurrent submits of the same draft: exactly one succeeds, one audit event', async () => {
    const inv = await newDraft();
    const results = await Promise.all([1, 2, 3, 4].map(() => clients.submitter!.req('POST', `/invoices/${inv.id}/submit`, { version: inv.version })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='invoice.submit'", [inv.id])).toBe(1);
  });

  it('tenant isolation: another company cannot submit or return this invoice', async () => {
    const inv = await newDraft();
    expect((await clients.ownerB!.req('POST', `/invoices/${inv.id}/submit`, { version: inv.version })).status).toBe(404);
    await clients.submitter!.req('POST', `/invoices/${inv.id}/submit`, { version: inv.version });
    expect((await clients.ownerB!.req('POST', `/invoices/${inv.id}/return`, { version: inv.version + 1 })).status).toBe(404);
    const row = (await pool.query('SELECT status FROM invoices WHERE id=$1', [inv.id])).rows[0];
    expect(row.status).toBe('submitted');
  });

  it('a purchase invoice cannot be submitted if its supplier became a customer type mismatch', async () => {
    const supplier = (await pool.query<{ id: string }>("INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,'Sup','supplier',true,$2) RETURNING id", [ids.coA, ids.ownerA])).rows[0]!.id;
    const inv = (await clients.submitter!.req('POST', '/invoices', { ...draft(), direction: 'purchase', counterparty_id: supplier, external_reference: `R-${run}` })).json.invoice;
    await pool.query('UPDATE counterparties SET is_active=false WHERE id=$1', [supplier]);
    const res = await clients.submitter!.req('POST', `/invoices/${inv.id}/submit`, { version: inv.version });
    expect(res.json.code).toBe('INVOICE_COUNTERPARTY_INVALID');
    expect((await pool.query('SELECT status FROM invoices WHERE id=$1', [inv.id])).rows[0].status).toBe('draft');
  });
});
