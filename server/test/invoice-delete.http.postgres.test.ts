import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Delete & Void Phase 1: draft invoice deletion over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
// invoice.* permissions are explicit-grant-only (migration 063); this suite provisions them directly on test roles,
// standing in for the owner-authorized provisioning procedure.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Invoice-Delete-1!';
const MISSING = '00000000-0000-4000-8000-000000000000';

describeDatabase('invoice delete API (PostgreSQL)', () => {
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
  const email = (label: string) => `invdel-${label}-${run}@example.test`;

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
    for (const label of ['ownerA', 'ownerB', 'creator', 'approver', 'deleter', 'deleterB']) ids[label] = await mkUser(label);
    const companies = new CompanyManagementService(pool);
    ids.coA = (await companies.create({ slug: `invdel-a-${run}`, name: `INVCAN-A-${run}`, name_ar: null }, ids.ownerA!)).id;
    ids.coB = (await companies.create({ slug: `invdel-b-${run}`, name: `INVCAN-B-${run}`, name_ar: null }, ids.ownerB!)).id;
    const role = async (company: string, name: string, caps: string[]) => {
      const id = (await pool.query<{ id: string }>('INSERT INTO roles(company_id,name) VALUES($1,$2) RETURNING id', [company, name])).rows[0]!.id;
      for (const c of caps) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [id, c]);
      return id;
    };
    const member = (user: string, company: string, roleId: string) => pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [user, company, roleId]);
    await member(ids.creator!, ids.coA!, await role(ids.coA!, 'Creator', ['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit']));
    await member(ids.approver!, ids.coA!, await role(ids.coA!, 'Approver', APPROVER_CAPS));
        await member(ids.deleter!, ids.coA!, await role(ids.coA!, 'Deleter', ['invoice.view', 'invoice.delete', 'invoice.cancel']));
    await member(ids.deleterB!, ids.coB!, await role(ids.coB!, 'DeleterB', ['invoice.view', 'invoice.delete']));
    ids.fy = (await pool.query<{ id: string }>("INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY26','2026-01-01','2026-12-31') RETURNING id", [ids.coA])).rows[0]!.id;
    const mappings = new InvoiceAccountMappingService(pool);
    for (const [k, t] of Object.entries({ receivable: 'asset', payable: 'liability', sales_revenue: 'revenue', purchase_expense: 'expense', vat_output: 'liability', vat_input: 'asset' })) {
      const acc = (await pool.query<{ id: string }>('INSERT INTO accounts(company_id,code,name,account_type) VALUES($1,$2,$2,$3) RETURNING id', [ids.coA, `F1-${k}`, t])).rows[0]!.id;
      await mappings.set(ids.coA!, ids.approver!, k, acc);
    }
    const cp = async (company: string, name: string, type: string) => (await pool.query<{ id: string }>(
      'INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,$2,$3,true,$4) RETURNING id', [company, name, type, ids.ownerA])).rows[0]!.id;
    ids.customerA = await cp(ids.coA!, 'Customer A', 'customer');
    for (const label of ['ownerA', 'ownerB', 'creator', 'approver', 'deleter', 'deleterB']) { clients[label] = new Client(email(label)); await clients[label]!.login(); }
  });
  afterAll(() => { server.close(); });

  const created = async (over: Record<string, unknown> = {}) => (await clients.creator!.req('POST', '/invoices', { ...draft(), ...over })).json.invoice;
  const submitted = async () => { const c = await created(); return (await clients.creator!.req('POST', `/invoices/${c.id}/submit`, { version: c.version })).json.invoice; };
  const approved = async () => { const s = await submitted(); const r = await clients.approver!.req('POST', `/invoices/${s.id}/approve`, { version: s.version }); expect(r.status).toBe(200); return r.json; };
  const del = (who: string, inv: { id: string; version: number }, version: number | string | null = inv.version, extra: Record<string, string> = {}) =>
    clients[who]!.req('DELETE', `/invoices/${inv.id}${version === null ? '' : `?version=${version}`}`, undefined, extra);
  const exists = (id: string) => count('SELECT COUNT(*)::text n FROM invoices WHERE id=$1', [id]);
  const auditCount = (id: string) => count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='invoice.draft.delete'", [id]);
  const doc = async (company: string, tag: string) => (await pool.query<{ id: string }>(
    "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256) VALUES($1,$2,'e.pdf','application/pdf',1,$3,$4) RETURNING id",
    [company, ids.ownerA, `del-${tag}-${randomUUID()}`, 'c'.repeat(64)])).rows[0]!.id;

  it('invoice.delete is registered; Full Access holds it through the wildcard, no default role does, and unprivileged users are refused', async () => {
    expect((await pool.query<{ implicit_full_access: boolean }>("SELECT implicit_full_access FROM capabilities WHERE id='invoice.delete'")).rows[0]?.implicit_full_access).toBe(true);
    expect(await count("SELECT COUNT(*)::text n FROM role_capabilities rc JOIN roles r ON r.id=rc.role_id WHERE rc.capability_id='invoice.delete' AND r.name IN ('Viewer','Accountant','Finance Manager','Company Manager')", [])).toBe(0);
    const owned = await created();
    expect((await del('ownerA', owned)).status).toBe(200);
    const inv = await created();
    expect((await del('creator', inv)).status).toBe(403);
    expect((await del('approver', inv)).status).toBe(403);
    expect((await del('deleter', inv, inv.version, { origin: 'https://evil.example' })).status).toBe(403);
    expect(await exists(inv.id)).toBe(1);
    expect(await auditCount(inv.id)).toBe(0);
  });

  it('deletes a draft sales invoice: header and lines removed, evidence document kept and relinkable, audit keeps the snapshot', async () => {
    const documentId = await doc(ids.coA!, 'a1');
    const inv = await created({ source_document_id: documentId });
    expect(inv.source_document_id).toBe(documentId);
    const numbersBefore = await count('SELECT COUNT(*)::text n FROM invoice_number_counters WHERE company_id=$1', [ids.coA]);
    const res = await del('deleter', inv);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ deleted: true, id: inv.id });
    expect(await exists(inv.id)).toBe(0);
    expect(await count('SELECT COUNT(*)::text n FROM invoice_lines WHERE invoice_id=$1', [inv.id])).toBe(0);
    expect(await count('SELECT COUNT(*)::text n FROM invoice_source_links WHERE invoice_id=$1', [inv.id])).toBe(0);
    expect(await count('SELECT COUNT(*)::text n FROM documents WHERE id=$1', [documentId])).toBe(1);
    expect(await count('SELECT COUNT(*)::text n FROM invoice_number_counters WHERE company_id=$1', [ids.coA])).toBe(numbersBefore);
    expect((await clients.deleter!.req('GET', `/invoices/${inv.id}`)).status).toBe(404);
    expect(await auditCount(inv.id)).toBe(1);
    const audit = (await pool.query("SELECT actor_user_id, company_id, before_data, after_data FROM audit_log WHERE entity_id=$1 AND action='invoice.draft.delete'", [inv.id])).rows[0];
    expect(audit.actor_user_id).toBe(ids.deleter);
    expect(audit.company_id).toBe(ids.coA);
    expect(audit.after_data).toBeNull();
    expect(audit.before_data.status).toBe('draft');
    expect(audit.before_data.lines).toHaveLength(1);
    const again = await created({ source_document_id: documentId });
    expect(again.source_document_id).toBe(documentId);
  });

  it('deletes a draft purchase invoice the same way', async () => {
    const supplier = (await pool.query<{ id: string }>("INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,'Sup','supplier',true,$2) RETURNING id", [ids.coA, ids.ownerA])).rows[0]!.id;
    const inv = await created({ direction: 'purchase', counterparty_id: supplier, external_reference: `R-${run}`, lines: [{ description: 'Goods', quantity: '1', unit_price: '500.00', vat_rate: '15', vat_treatment: 'standard', vat_recoverability: 'fully_recoverable' }] });
    expect(inv?.direction).toBe('purchase');
    expect((await del('deleter', inv)).status).toBe(200);
    expect(await exists(inv.id)).toBe(0);
    expect(await auditCount(inv.id)).toBe(1);
  });

  it('REFUSES a submitted invoice (409) and keeps it intact', async () => {
    const inv = await submitted();
    const res = await del('deleter', inv);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('INVOICE_DELETE_NOT_ALLOWED');
    expect((await pool.query('SELECT status FROM invoices WHERE id=$1', [inv.id])).rows[0].status).toBe('submitted');
    expect(await count('SELECT COUNT(*)::text n FROM invoice_lines WHERE invoice_id=$1', [inv.id])).toBe(1);
    expect(await auditCount(inv.id)).toBe(0);
  });

  it('REFUSES a cancelled invoice: the row, its lines and its reason stay as history', async () => {
    const inv = await created();
    const done = (await clients.deleter!.req('POST', `/invoices/${inv.id}/cancel`, { version: inv.version, reason: 'Issued by mistake' })).json.invoice;
    const res = await del('deleter', done);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('INVOICE_DELETE_NOT_ALLOWED');
    expect((await pool.query('SELECT status, cancellation_reason FROM invoices WHERE id=$1', [inv.id])).rows[0]).toMatchObject({ status: 'cancelled', cancellation_reason: 'Issued by mistake' });
    expect(await count('SELECT COUNT(*)::text n FROM invoice_lines WHERE invoice_id=$1', [inv.id])).toBe(1);
  });

  it('REFUSES an approved invoice and leaves number, obligation, draft journal and VAT snapshot untouched; the database refuses the shortcut too', async () => {
    const ok = await approved();
    const inv = ok.invoice;
    const res = await del('deleter', inv);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('INVOICE_DELETE_NOT_ALLOWED');
    expect((await pool.query('SELECT status, internal_number FROM invoices WHERE id=$1', [inv.id])).rows[0]).toMatchObject({ status: 'approved', internal_number: inv.internal_number });
    expect(await count("SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1 AND NOT is_cancelled", [inv.id])).toBe(1);
    expect(await count("SELECT COUNT(*)::text n FROM journal_entries WHERE source_id=$1 AND status='draft'", [ok.obligation_id])).toBe(1);
    expect(await count('SELECT COUNT(*)::text n FROM invoice_vat_reviews WHERE invoice_id=$1', [inv.id])).toBe(1);
    expect(await auditCount(inv.id)).toBe(0);
    await expect(pool.query('DELETE FROM invoices WHERE id=$1', [inv.id])).rejects.toThrow(/only draft invoices can be deleted/);
    await expect(pool.query('DELETE FROM obligations WHERE invoice_id=$1', [inv.id])).rejects.toThrow();
  });

  it('REFUSES an approved invoice whose journal is posted, without any change', async () => {
    const ok = await approved();
    await pool.query("UPDATE journal_entries SET status='posted', posted_at=NOW(), posted_by=$3 WHERE source_id=$1 AND company_id=$2", [ok.obligation_id, ids.coA, ids.approver]);
    expect((await del('deleter', ok.invoice)).json.code).toBe('INVOICE_DELETE_NOT_ALLOWED');
    expect(await exists(ok.invoice.id)).toBe(1);
    expect(await count("SELECT COUNT(*)::text n FROM journal_entries WHERE source_id=$1 AND status='posted'", [ok.obligation_id])).toBe(1);
  });

  it('rejects a missing/malformed/stale version and unknown or malformed ids without deleting', async () => {
    const inv = await created();
    expect((await del('deleter', inv, null)).status).toBe(400);
    expect((await del('deleter', inv, 'abc')).status).toBe(400);
    expect((await del('deleter', inv, 0)).status).toBe(400);
    expect((await del('deleter', inv, inv.version + 5)).json.code).toBe('INVOICE_VERSION_CONFLICT');
    expect((await clients.deleter!.req('DELETE', `/invoices/${MISSING}?version=1`)).status).toBe(404);
    expect((await clients.deleter!.req('DELETE', '/invoices/not-a-uuid?version=1')).status).toBe(404);
    expect(await exists(inv.id)).toBe(1);
    expect(await auditCount(inv.id)).toBe(0);
  });

  it('a draft edited after the page was loaded is not deleted with the old version', async () => {
    const inv = await created();
    const edited = (await clients.creator!.req('PUT', `/invoices/${inv.id}`, { counterparty_id: ids.customerA, issue_date: '2026-10-02', tax_point_date: '2026-10-02', version: inv.version, lines: draft().lines })).json.invoice;
    expect((await del('deleter', inv)).json.code).toBe('INVOICE_VERSION_CONFLICT');
    expect((await del('deleter', edited)).status).toBe(200);
  });

  it('concurrent deletes of the same draft: exactly one succeeds, one audit event', async () => {
    const inv = await created();
    const results = await Promise.all([1, 2, 3, 4].map(() => del('deleter', inv)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(3);
    expect(await auditCount(inv.id)).toBe(1);
  });

  it('tenant isolation: another company cannot delete or even detect this draft, and its own delete right does not cross over', async () => {
    const inv = await created();
    expect((await del('deleterB', inv)).status).toBe(404);
    expect((await del('ownerB', inv)).status).toBe(404);
    expect(await exists(inv.id)).toBe(1);
    expect(await auditCount(inv.id)).toBe(0);
  });
});
