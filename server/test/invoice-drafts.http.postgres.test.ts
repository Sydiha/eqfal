import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// PR-2B invoice draft engine over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
// invoice.* permissions are explicit-grant-only (migration 063); this suite provisions them directly on test roles,
// standing in for the owner-authorized provisioning procedure.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Invoice-Drafts-1!';
const MISSING = '00000000-0000-4000-8000-000000000000';

describeDatabase('invoice drafts API (PostgreSQL)', () => {
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
  const email = (label: string) => `invdraft-${label}-${run}@example.test`;

  const draft = (o: Record<string, unknown> = {}) => ({
    direction: 'sales', counterparty_id: ids.customerA, issue_date: '2026-10-01',
    lines: [{ description: 'Consulting', quantity: '1', unit_price: '1000.00', vat_rate: '15' }], ...o,
  });

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
    for (const label of ['ownerA', 'ownerB', 'editor', 'viewer', 'creator', 'none']) ids[label] = await mkUser(label);
    const companies = new CompanyManagementService(pool);
    ids.coA = (await companies.create({ slug: `invdraft-a-${run}`, name: `INVDRAFT-A-${run}`, name_ar: null }, ids.ownerA!)).id;
    ids.coB = (await companies.create({ slug: `invdraft-b-${run}`, name: `INVDRAFT-B-${run}`, name_ar: null }, ids.ownerB!)).id;
    const role = async (company: string, name: string, caps: string[]) => {
      const id = (await pool.query<{ id: string }>('INSERT INTO roles(company_id,name) VALUES($1,$2) RETURNING id', [company, name])).rows[0]!.id;
      for (const c of caps) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [id, c]);
      return id;
    };
    const member = (user: string, company: string, roleId: string) => pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [user, company, roleId]);
    await member(ids.editor!, ids.coA!, await role(ids.coA!, 'InvEditor', ['invoice.view', 'invoice.create', 'invoice.edit']));
    await member(ids.viewer!, ids.coA!, await role(ids.coA!, 'InvViewer', ['invoice.view']));
    await member(ids.creator!, ids.coA!, await role(ids.coA!, 'InvCreator', ['invoice.view', 'invoice.create']));
    await member(ids.none!, ids.coA!, await role(ids.coA!, 'NoInvoice', ['document.view', 'obligation.view']));
    // Company B: its Full Access owner is given invoice rights explicitly, for cross-company probes.
    const fullB = (await pool.query<{ id: string }>('SELECT id FROM roles WHERE company_id=$1 AND is_full_access', [ids.coB])).rows[0]!.id;
    for (const c of ['invoice.view', 'invoice.create', 'invoice.edit']) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [fullB, c]);

    const cp = async (company: string, name: string, type: string, active = true) => (await pool.query<{ id: string }>(
      'INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,$2,$3,$4,$5) RETURNING id', [company, name, type, active, ids.ownerA])).rows[0]!.id;
    ids.customerA = await cp(ids.coA!, 'Customer A', 'customer');
    ids.supplierA = await cp(ids.coA!, 'Supplier A', 'supplier');
    ids.inactiveA = await cp(ids.coA!, 'Old A', 'customer', false);
    ids.customerB = await cp(ids.coB!, 'Customer B', 'customer');
    const doc = async (company: string) => (await pool.query<{ id: string }>(
      "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256) VALUES($1,$2,'e.pdf','application/pdf',1,$3,$4) RETURNING id",
      [company, ids.ownerA, `k-${randomUUID()}`, 'c'.repeat(64)])).rows[0]!.id;
    ids.docA = await doc(ids.coA!); ids.docA2 = await doc(ids.coA!); ids.docB = await doc(ids.coB!);

    for (const label of ['ownerA', 'ownerB', 'editor', 'viewer', 'creator', 'none']) { clients[label] = new Client(email(label)); await clients[label]!.login(); }
  });

  afterAll(() => { server.close(); });

  describe('authorization (deny by default)', () => {
    it('Full Access without an explicit grant is refused on every invoice route', async () => {
      const A = clients.ownerA!;
      expect((await A.req('GET', '/invoices')).status).toBe(403);
      expect((await A.req('GET', `/invoices/${MISSING}`)).status).toBe(403);
      expect((await A.req('POST', '/invoices', draft())).status).toBe(403);
      expect((await A.req('PUT', `/invoices/${MISSING}`, { ...draft(), version: 1 })).status).toBe(403);
    });

    it('a role without invoice capabilities is refused; view-only cannot create or edit; create-only cannot edit', async () => {
      expect((await clients.none!.req('GET', '/invoices')).status).toBe(403);
      expect((await clients.none!.req('POST', '/invoices', draft())).status).toBe(403);
      expect((await clients.viewer!.req('GET', '/invoices')).status).toBe(200);
      expect((await clients.viewer!.req('POST', '/invoices', draft())).status).toBe(403);
      const created = await clients.creator!.req('POST', '/invoices', draft());
      expect(created.status).toBe(201);
      expect((await clients.creator!.req('PUT', `/invoices/${created.json.invoice.id}`, { ...draft(), version: 1 })).status).toBe(403);
    });

    it('unauthenticated and cross-origin writes are refused', async () => {
      const anon = new Client('nobody@example.test');
      expect((await anon.req('GET', '/invoices')).status).toBe(401);
      const hostile = await clients.editor!.req('POST', '/invoices', draft(), { origin: 'https://evil.example' });
      expect(hostile.status).toBe(403);
    });

    it('no invoice capability was granted to any default role by this feature', async () => {
      const { rows } = await pool.query(
        `SELECT r.name FROM role_capabilities rc JOIN roles r ON r.id = rc.role_id
         WHERE rc.capability_id LIKE 'invoice.%' AND r.company_id = $1 AND (r.is_full_access OR r.name IN ('Viewer','Accountant','Finance Manager'))`, [ids.coA]);
      expect(rows).toEqual([]);
    });
  });

  describe('draft lifecycle and totals', () => {
    it('creates a sales draft with server-computed line-level amounts and an audit event', async () => {
      const res = await clients.editor!.req('POST', '/invoices', draft({
        source_document_id: ids.docA,
        lines: [
          { description: 'A', quantity: '1', unit_price: '0.10', vat_rate: '15' },
          { description: 'B', quantity: '1', unit_price: '0.10', vat_rate: '15' },
          { description: 'C', quantity: '2', unit_price: '100.00', vat_rate: '15', discount_amount: '20.00' },
          { description: 'D', quantity: '1.5', unit_price: '0.03', vat_rate: '0' },
        ],
      }));
      expect(res.status).toBe(201);
      const inv = res.json.invoice;
      expect(inv).toMatchObject({ status: 'draft', direction: 'sales', version: 1, internal_number: null, fiscal_year_id: null, source_document_id: ids.docA });
      expect(inv.lines.map((l: any) => [l.net_amount, l.vat_amount, l.total_amount])).toEqual([
        ['0.10', '0.02', '0.12'], ['0.10', '0.02', '0.12'], ['180.00', '27.00', '207.00'], ['0.05', '0.00', '0.05'],
      ]);
      expect([inv.subtotal_amount, inv.vat_amount, inv.total_amount]).toEqual(['180.25', '27.04', '207.29']);
      // stored header = SUM of stored rounded lines
      const sums = (await pool.query('SELECT SUM(net_amount)::text n, SUM(vat_amount)::text v, SUM(total_amount)::text t FROM invoice_lines WHERE invoice_id=$1', [inv.id])).rows[0];
      expect([sums.n, sums.v, sums.t]).toEqual([inv.subtotal_amount, inv.vat_amount, inv.total_amount]);
      const audit = await pool.query("SELECT 1 FROM audit_log WHERE entity_id=$1 AND action='invoice.draft.create' AND company_id=$2", [inv.id, ids.coA]);
      expect(audit.rowCount).toBe(1);
      ids.salesDraft = inv.id;
    });

    it('ignores client-supplied totals and status fields (rejects unknown fields)', async () => {
      for (const extra of [{ total_amount: '1.00' }, { status: 'approved' }, { internal_number: 5 }, { company_id: ids.coB }]) {
        const res = await clients.editor!.req('POST', '/invoices', draft(extra));
        expect(res.status).toBe(400);
        expect(res.json.code).toBe('INVOICE_VALIDATION');
      }
      const lineExtra = await clients.editor!.req('POST', '/invoices', draft({ lines: [{ description: 'x', quantity: '1', unit_price: '1.00', vat_rate: '15', net_amount: '9.99' }] }));
      expect(lineExtra.status).toBe(400);
    });

    it('edits a draft as a full replacement with optimistic versioning', async () => {
      const id = ids.salesDraft!;
      const res = await clients.editor!.req('PUT', `/invoices/${id}`, {
        version: 1, counterparty_id: ids.customerA, issue_date: '2026-10-02', due_date: '2026-10-30', notes: 'edited',
        lines: [{ description: 'Only line', quantity: '3', unit_price: '0.70', vat_rate: '15' }],
      });
      expect(res.status).toBe(200);
      expect(res.json.invoice).toMatchObject({ version: 2, notes: 'edited', due_date: '2026-10-30', source_document_id: null, subtotal_amount: '2.10', vat_amount: '0.32', total_amount: '2.42' });
      expect(res.json.invoice.lines).toHaveLength(1);
      const stale = await clients.editor!.req('PUT', `/invoices/${id}`, { ...draft(), direction: undefined, version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('INVOICE_VERSION_CONFLICT');
      expect((await pool.query("SELECT 1 FROM audit_log WHERE entity_id=$1 AND action='invoice.draft.update'", [id])).rowCount).toBe(1);
    });

    it('direction cannot be changed on edit', async () => {
      const res = await clients.editor!.req('PUT', `/invoices/${ids.salesDraft}`, { ...draft(), version: 2 });
      expect(res.status).toBe(400); // "direction" is not an editable field
    });

    it('refuses to edit submitted, approved or cancelled invoices', async () => {
      const created = (await clients.editor!.req('POST', '/invoices', draft())).json.invoice;
      // Move to submitted directly in the database (no submission API exists yet).
      await pool.query("UPDATE invoices SET status='submitted' WHERE id=$1", [created.id]);
      const sub = await clients.editor!.req('PUT', `/invoices/${created.id}`, { ...draft(), direction: undefined, version: 1 });
      expect(sub.status).toBe(409);
      expect(sub.json.code).toBe('INVOICE_NOT_DRAFT');
      await pool.query("UPDATE invoices SET status='cancelled', cancelled_at=NOW(), cancelled_by_user_id=$2, cancellation_reason='t' WHERE id=$1", [created.id, ids.ownerA]);
      expect((await clients.editor!.req('PUT', `/invoices/${created.id}`, { ...draft(), direction: undefined, version: 1 })).json.code).toBe('INVOICE_NOT_DRAFT');
      const fy = (await pool.query<{ id: string }>("INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,$2,'2030-01-01','2030-12-31') RETURNING id", [ids.coA, `FY-${run}`])).rows[0]!.id;
      const approved = (await clients.editor!.req('POST', '/invoices', draft())).json.invoice;
      await pool.query("UPDATE invoices SET status='submitted' WHERE id=$1", [approved.id]);
      await pool.query("UPDATE invoices SET status='approved', internal_number=1, fiscal_year_id=$2, approved_at=NOW(), approved_by_user_id=$3 WHERE id=$1", [approved.id, fy, ids.ownerA]);
      const ap = await clients.editor!.req('PUT', `/invoices/${approved.id}`, { ...draft(), direction: undefined, version: 1 });
      expect(ap.status).toBe(409);
      expect(ap.json.code).toBe('INVOICE_NOT_DRAFT');
      expect((await pool.query('SELECT total_amount::text FROM invoices WHERE id=$1', [approved.id])).rows[0].total_amount).toBe('1150.00');
    });
  });

  describe('validation', () => {
    const bad = async (body: unknown, code = 'INVOICE_VALIDATION') => {
      const res = await clients.editor!.req('POST', '/invoices', body);
      expect(res.status, JSON.stringify(body)).toBe(code === 'INVOICE_SOURCE_ALREADY_LINKED' || code === 'INVOICE_DUPLICATE_REFERENCE' ? 409 : 400);
      expect(res.json.code).toBe(code);
    };
    it('rejects malformed headers, dates and lines', async () => {
      await bad(draft({ direction: 'refund' }));
      await bad(draft({ issue_date: '2026-02-30' }));
      await bad(draft({ due_date: '2026-09-30' }));
      await bad(draft({ lines: [] }));
      await bad(draft({ lines: Array.from({ length: 201 }, () => ({ description: 'x', quantity: '1', unit_price: '1.00', vat_rate: '15' })) }));
      await bad(draft({ lines: [{ description: ' ', quantity: '1', unit_price: '1.00', vat_rate: '15' }] }));
      await bad(draft({ lines: [{ description: 'x', quantity: 1, unit_price: '1.00', vat_rate: '15' }] }));
      await bad(draft({ lines: [{ description: 'x', quantity: '1', unit_price: '1.00', vat_rate: '101' }] }));
      await bad(draft({ lines: [{ description: 'x', quantity: '1', unit_price: '10.00', vat_rate: '15', discount_amount: '10.01' }] }));
      await bad(draft({ external_reference: 'r'.repeat(101) }));
      await bad(draft({ counterparty_id: 'not-a-uuid' }));
    });
    it('rejects inactive, unknown and wrong-type counterparties', async () => {
      await bad(draft({ counterparty_id: ids.inactiveA }), 'INVOICE_COUNTERPARTY_INVALID');
      await bad(draft({ counterparty_id: MISSING }), 'INVOICE_COUNTERPARTY_INVALID');
      await bad(draft({ counterparty_id: ids.supplierA }), 'INVOICE_COUNTERPARTY_INVALID');
      await bad(draft({ direction: 'purchase', counterparty_id: ids.customerA }), 'INVOICE_COUNTERPARTY_INVALID');
    });
    it('prevents duplicate source links and duplicate supplier references', async () => {
      const first = await clients.editor!.req('POST', '/invoices', draft({ source_document_id: ids.docA2 }));
      expect(first.status).toBe(201);
      await bad(draft({ source_document_id: ids.docA2 }), 'INVOICE_SOURCE_ALREADY_LINKED');
      const p1 = await clients.editor!.req('POST', '/invoices', draft({ direction: 'purchase', counterparty_id: ids.supplierA, external_reference: `SUP-${run}` }));
      expect(p1.status).toBe(201);
      await bad(draft({ direction: 'purchase', counterparty_id: ids.supplierA, external_reference: `SUP-${run}` }), 'INVOICE_DUPLICATE_REFERENCE');
    });
  });

  describe('tenant isolation', () => {
    it('cross-company counterparty and document ids are refused and write nothing', async () => {
      const before = (await pool.query('SELECT COUNT(*)::int n FROM invoices WHERE company_id=$1', [ids.coA])).rows[0].n;
      const cp = await clients.editor!.req('POST', '/invoices', draft({ counterparty_id: ids.customerB }));
      expect(cp.json.code).toBe('INVOICE_COUNTERPARTY_INVALID');
      const doc = await clients.editor!.req('POST', '/invoices', draft({ source_document_id: ids.docB }));
      expect(doc.json.code).toBe('INVOICE_DOCUMENT_INVALID');
      expect((await pool.query('SELECT COUNT(*)::int n FROM invoices WHERE company_id=$1', [ids.coA])).rows[0].n).toBe(before);
    });

    it("another company's invoice reads as not found and cannot be edited", async () => {
      const b = (await clients.ownerB!.req('POST', '/invoices', draft({ counterparty_id: ids.customerB }))).json.invoice;
      const hashBefore = (await pool.query("SELECT md5(i::text) h FROM invoices i WHERE id=$1", [b.id])).rows[0].h;
      expect((await clients.editor!.req('GET', `/invoices/${b.id}`)).status).toBe(404);
      const put = await clients.editor!.req('PUT', `/invoices/${b.id}`, { ...draft(), direction: undefined, version: 1 });
      expect(put.status).toBe(404);
      // B cannot pull A's counterparty into its own draft either
      const pull = await clients.ownerB!.req('PUT', `/invoices/${b.id}`, { ...draft({ counterparty_id: ids.customerA }), direction: undefined, version: 1 });
      expect(pull.json.code).toBe('INVOICE_COUNTERPARTY_INVALID');
      expect((await pool.query("SELECT md5(i::text) h FROM invoices i WHERE id=$1", [b.id])).rows[0].h).toBe(hashBefore);
      const list = await clients.editor!.req('GET', '/invoices?limit=100');
      expect(list.json.invoices.every((i: any) => i.company_id === ids.coA)).toBe(true);
      expect(list.json.invoices.some((i: any) => i.id === b.id)).toBe(false);
    });
  });

  describe('listing', () => {
    it('filters by direction, status, counterparty and date, and paginates with a total', async () => {
      const all = await clients.viewer!.req('GET', '/invoices?limit=100');
      expect(all.status).toBe(200);
      expect(all.json.total).toBe(all.json.invoices.length);
      const purchases = await clients.viewer!.req('GET', '/invoices?direction=purchase');
      expect(purchases.json.invoices.length).toBeGreaterThan(0);
      expect(purchases.json.invoices.every((i: any) => i.direction === 'purchase')).toBe(true);
      const drafts = await clients.viewer!.req('GET', `/invoices?status=draft&counterparty_id=${ids.customerA}&from=2026-10-01&to=2026-10-01`);
      expect(drafts.json.invoices.every((i: any) => i.status === 'draft' && i.counterparty_id === ids.customerA && i.issue_date === '2026-10-01')).toBe(true);
      const page1 = await clients.viewer!.req('GET', '/invoices?limit=2&offset=0');
      const page2 = await clients.viewer!.req('GET', '/invoices?limit=2&offset=2');
      expect(page1.json.invoices).toHaveLength(2);
      expect(page1.json.total).toBe(all.json.total);
      expect(page2.json.invoices.map((i: any) => i.id)).not.toContain(page1.json.invoices[0].id);
    });
    it('rejects invalid query parameters', async () => {
      for (const q of ['direction=refund', 'status=posted', 'limit=0', 'limit=101', 'offset=-1', 'from=2026-13-01', 'from=2026-10-02&to=2026-10-01', 'foo=1', 'counterparty_id=x', 'direction=sales&direction=purchase']) {
        const res = await clients.viewer!.req('GET', `/invoices?${q}`);
        expect(res.status, q).toBe(400);
        expect(res.json.code).toBe('INVOICE_VALIDATION');
      }
    });
    it('returns 404 for unknown or malformed ids', async () => {
      expect((await clients.viewer!.req('GET', `/invoices/${MISSING}`)).status).toBe(404);
      expect((await clients.viewer!.req('GET', '/invoices/abc')).status).toBe(404);
    });
  });
});
