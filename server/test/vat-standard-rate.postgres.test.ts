import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Effective-dated standard VAT rates (migration 069): table rules, the read-only resolution API and the save/submit validation.
// Requires an isolated, disposable PostgreSQL database with migrations applied (DATABASE_URL).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;
const PASSWORD = 'Vat-Rate-1!';

describeDatabase('standard VAT rate resolution (PostgreSQL)', () => {
  let pool: Pool;
  let server: http.Server;
  let base = '';
  let drafts: import('../src/modules/invoices/invoice.service').InvoiceDraftService;
  let parseDraft: typeof import('../src/modules/invoices/invoice.service').parseDraft;
  const run = randomUUID().slice(0, 8);
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const errCode = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
  const ids = { coA: '', coB: '', user: '', cust: '' };
  const emails = { create: `vr-create-${run}@example.test`, view: `vr-view-${run}@example.test`, edit: `vr-edit-${run}@example.test`, vatOnly: `vr-vat-${run}@example.test`, none: `vr-none-${run}@example.test`, otherCo: `vr-other-${run}@example.test` };

  async function get(email: string, url: string) {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const res = await fetch(`${base}/api${url}`, { headers: { origin: base, cookie } });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }
  const std = (rate: string) => ({ description: 'S', quantity: '1', unit_price: '100.00', vat_rate: rate, vat_treatment: 'standard' });
  const zero = { description: 'Z', quantity: '1', unit_price: '100.00', vat_rate: '0', vat_treatment: 'zero_rated' };
  const draft = (lines: unknown[], o: { tax?: string | null; issue?: string } = {}) => {
    const body: Record<string, unknown> = { counterparty_id: ids.cust, issue_date: o.issue ?? '2026-03-10', lines };
    if (o.tax !== null) body.tax_point_date = o.tax ?? o.issue ?? '2026-03-10';
    return parseDraft(body);
  };

  beforeAll(async () => {
    const { default: sharedPool } = await import('../src/db/pool');
    const { default: app } = await import('../src/app');
    const { CompanyManagementService } = await import('../src/modules/companies/company.service');
    const invoiceModule = await import('../src/modules/invoices/invoice.service');
    pool = sharedPool!;
    drafts = new invoiceModule.InvoiceDraftService(pool);
    parseDraft = invoiceModule.parseDraft;
    const companyService = new CompanyManagementService(pool);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const hash = await bcrypt.hash(PASSWORD, 4);
    const mkUser = async (email: string) => (await pool.query<{ id: string }>('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email, hash])).rows[0]!.id;
    const ownerA = await mkUser(`vr-ownera-${run}@example.test`), ownerB = await mkUser(`vr-ownerb-${run}@example.test`);
    ids.user = ownerA;
    ids.coA = (await companyService.create({ slug: `vr-a-${run}`, name: `VR-A-${run}`, name_ar: null }, ownerA)).id;
    ids.coB = (await companyService.create({ slug: `vr-b-${run}`, name: `VR-B-${run}`, name_ar: null }, ownerB)).id;
    ids.cust = (await q(`INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'C','customer',$2) RETURNING id`, [ids.coA, ownerA]))[0].id;
    const mkRole = async (company: string, name: string, capabilities: string[]) => {
      const id = (await pool.query<{ id: string }>('INSERT INTO roles(company_id,name,is_full_access) VALUES($1,$2,FALSE) RETURNING id', [company, name])).rows[0]!.id;
      for (const c of capabilities) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [id, c]);
      return id;
    };
    const members: Array<[string, string, string[]]> = [[emails.create, ids.coA, ['invoice.create']], [emails.view, ids.coA, ['invoice.view']], [emails.edit, ids.coA, ['invoice.edit']], [emails.vatOnly, ids.coA, ['vat.view']], [emails.none, ids.coA, ['obligation.view']], [emails.otherCo, ids.coB, ['document.view']]];
    for (const [email, company, caps] of members) {
      await pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [await mkUser(email), company, await mkRole(company, `R-${email.slice(3, 9)}`, caps)]);
    }
  });

  afterAll(async () => { server.close(); });

  describe('table rules', () => {
    it('seeds exactly the approved Saudi rates', async () => {
      expect(await q(`SELECT jurisdiction, rate::text r, effective_from::text f, effective_to::text t FROM vat_standard_rates WHERE jurisdiction='SA' ORDER BY effective_from`))
        .toEqual([{ jurisdiction: 'SA', r: '5.00', f: '2018-01-01', t: '2020-06-30' }, { jurisdiction: 'SA', r: '15.00', f: '2020-07-01', t: null }]);
    });
    it('refuses overlapping periods, inverted periods and unusable rates', async () => {
      expect(await errCode(pool.query(`INSERT INTO vat_standard_rates(jurisdiction,rate,effective_from,effective_to) VALUES('SA',10,'2020-06-30','2020-06-30')`))).not.toBe('ok');
      expect(await errCode(pool.query(`INSERT INTO vat_standard_rates(jurisdiction,rate,effective_from) VALUES('SA',10,'2030-01-01')`))).not.toBe('ok'); // overlaps the open 15% period
      expect(await errCode(pool.query(`INSERT INTO vat_standard_rates(jurisdiction,rate,effective_from,effective_to) VALUES('SA',10,'2017-01-01','2016-01-01')`))).toBe('23514');
      expect(await errCode(pool.query(`INSERT INTO vat_standard_rates(jurisdiction,rate,effective_from,effective_to) VALUES('SA',0,'2010-01-01','2010-12-31')`))).toBe('23514');
      expect(await errCode(pool.query(`INSERT INTO vat_standard_rates(jurisdiction,rate,effective_from,effective_to) VALUES('SA',101,'2010-01-01','2010-12-31')`))).toBe('23514');
      expect(Number((await q(`SELECT count(*) n FROM vat_standard_rates WHERE jurisdiction='SA'`))[0].n)).toBe(2);
    });
    it('allows a separate jurisdiction without touching SA', async () => {
      await pool.query(`INSERT INTO vat_standard_rates(jurisdiction,rate,effective_from) VALUES('ZZ',7,'2000-01-01')`);
      await pool.query(`DELETE FROM vat_standard_rates WHERE jurisdiction='ZZ'`);
    });
  });

  describe('read-only API', () => {
    it.each([['2017-12-31', 404], ['2018-01-01', 200], ['2020-06-30', 200], ['2020-07-01', 200], ['2026-10-12', 200]])('GET %s -> %i', async (date, status) => {
      expect((await get(emails.create, `/invoices/standard-rate?date=${date}`)).status).toBe(status);
    });
    it('resolves the boundary rates exactly', async () => {
      expect((await get(emails.create, '/invoices/standard-rate?date=2020-06-30')).json).toEqual({ date: '2020-06-30', jurisdiction: 'SA', rate: '5.00', effective_from: '2018-01-01', effective_to: '2020-06-30' });
      expect((await get(emails.create, '/invoices/standard-rate?date=2020-07-01')).json).toEqual({ date: '2020-07-01', jurisdiction: 'SA', rate: '15.00', effective_from: '2020-07-01', effective_to: null });
    });
    it('fails closed with a stable code when no rate exists', async () => {
      const res = await get(emails.create, '/invoices/standard-rate?date=2017-12-31');
      expect(res.status).toBe(404);
      expect(res.json.code).toBe('VAT_RATE_NOT_CONFIGURED');
    });
    it.each(['', '?date=', '?date=2026-02-30', '?date=2026-1-1', '?date=2026-01-01&x=1', '?date=2026-01-01&date=2026-01-02', '?x=1'])('rejects invalid query %s', async (query) => {
      expect((await get(emails.create, `/invoices/standard-rate${query}`)).status).toBe(400);
    });
    it('is available to invoice view, create and edit users without vat.view', async () => {
      for (const email of [emails.create, emails.view, emails.edit]) expect((await get(email, '/invoices/standard-rate?date=2026-03-10')).status).toBe(200);
    });
    it('is refused to users without an invoice capability, including vat.view and obligation.view holders', async () => {
      for (const email of [emails.vatOnly, emails.none, emails.otherCo]) expect((await get(email, '/invoices/standard-rate?date=2026-03-10')).status).toBe(403);
    });
    it('requires authentication', async () => {
      expect((await fetch(`${base}/api/invoices/standard-rate?date=2026-03-10`, { headers: { origin: base } })).status).toBe(401);
    });
    it('exposes reference data only: the response carries no company data', async () => {
      const a = (await get(emails.create, '/invoices/standard-rate?date=2026-03-10')).json;
      expect(Object.keys(a).sort()).toEqual(['date', 'effective_from', 'effective_to', 'jurisdiction', 'rate']);
      expect(JSON.stringify(a)).not.toContain(ids.coA);
      expect(JSON.stringify(a)).not.toContain(ids.coB);
    });
  });

  describe('server-side validation on save and submit (sales)', () => {
    it('accepts the rate in force and rejects any other standard rate on create and update', async () => {
      const ok = await drafts.create(ids.coA, ids.user, 'sales', draft([std('15')]));
      expect(ok.status).toBe('draft');
      expect(await errCode(drafts.create(ids.coA, ids.user, 'sales', draft([std('5')])))).toBe('INVOICE_VAT_RATE_MISMATCH');
      expect(await errCode(drafts.create(ids.coA, ids.user, 'sales', draft([std('14.99')])))).toBe('INVOICE_VAT_RATE_MISMATCH');
      expect(await errCode(drafts.update(ids.coA, ids.user, ok.id, ok.version, draft([std('5')])))).toBe('INVOICE_VAT_RATE_MISMATCH');
      const stored = await drafts.update(ids.coA, ids.user, ok.id, ok.version, draft([std('15.00')]));
      expect(stored.lines[0].vat_rate).toBe('15.00');
    });
    it('uses the tax point date: the rate changes exactly at the 2020-07-01 boundary', async () => {
      const lastFive = await drafts.create(ids.coA, ids.user, 'sales', draft([std('5')], { tax: '2020-06-30', issue: '2020-06-30' }));
      expect(lastFive.lines[0].vat_rate).toBe('5.00');
      expect(await errCode(drafts.create(ids.coA, ids.user, 'sales', draft([std('15')], { tax: '2020-06-30', issue: '2020-06-30' })))).toBe('INVOICE_VAT_RATE_MISMATCH');
      const firstFifteen = await drafts.create(ids.coA, ids.user, 'sales', draft([std('15')], { tax: '2020-07-01', issue: '2020-07-01' }));
      expect(firstFifteen.lines[0].vat_rate).toBe('15.00');
      expect(await errCode(drafts.create(ids.coA, ids.user, 'sales', draft([std('5')], { tax: '2020-07-01', issue: '2020-07-01' })))).toBe('INVOICE_VAT_RATE_MISMATCH');
      // the tax point date wins over the issue date
      expect((await drafts.create(ids.coA, ids.user, 'sales', draft([std('5')], { tax: '2020-06-30', issue: '2020-07-15' }))).lines[0].vat_rate).toBe('5.00');
    });
    it('fails closed when no rate is configured for the tax point date, but leaves other treatments alone', async () => {
      expect(await errCode(drafts.create(ids.coA, ids.user, 'sales', draft([std('15')], { tax: '2017-12-31', issue: '2017-12-31' })))).toBe('VAT_RATE_NOT_CONFIGURED');
      const z = await drafts.create(ids.coA, ids.user, 'sales', draft([zero], { tax: '2017-12-31', issue: '2017-12-31' }));
      expect(z.lines[0].vat_treatment).toBe('zero_rated');
      const mixed = await drafts.create(ids.coA, ids.user, 'sales', draft([zero, { ...zero, vat_treatment: 'exempt' }, { ...zero, vat_treatment: 'out_of_scope' }]));
      expect(mixed.lines.map((l: { vat_treatment: string }) => l.vat_treatment)).toEqual(['zero_rated', 'exempt', 'out_of_scope']);
    });
    it('treats a draft without a tax point date as provisional: it saves, but cannot be submitted', async () => {
      const d = await drafts.create(ids.coA, ids.user, 'sales', draft([std('15')], { tax: null }));
      expect(d.tax_point_date).toBeNull();
      expect(await errCode(drafts.submit(ids.coA, ids.user, d.id, d.version))).toBe('INVOICE_VAT_INCOMPLETE');
    });
    it('blocks submitting a historical draft whose saved rate no longer matches, and never rewrites the saved rate', async () => {
      const d = await drafts.create(ids.coA, ids.user, 'sales', draft([std('15')], { tax: null }));
      await pool.query(`UPDATE invoice_lines SET vat_rate=5, vat_amount=5.00, total_amount=105.00 WHERE invoice_id=$1`, [d.id]);
      await pool.query(`UPDATE invoices SET tax_point_date='2026-03-10' WHERE id=$1`, [d.id]);
      const fresh = (await q('SELECT version FROM invoices WHERE id=$1', [d.id]))[0].version;
      expect(await errCode(drafts.submit(ids.coA, ids.user, d.id, fresh))).toBe('INVOICE_VAT_RATE_MISMATCH');
      const after = await q(`SELECT l.vat_rate::text r, i.status FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE l.invoice_id=$1`, [d.id]);
      expect(after).toEqual([{ r: '5.00', status: 'draft' }]);
    });
    it('blocks submit when the tax point date has no configured rate', async () => {
      const d = await drafts.create(ids.coA, ids.user, 'sales', draft([std('15')], { tax: null }));
      await pool.query(`UPDATE invoices SET tax_point_date='2017-12-31' WHERE id=$1`, [d.id]);
      const fresh = (await q('SELECT version FROM invoices WHERE id=$1', [d.id]))[0].version;
      expect(await errCode(drafts.submit(ids.coA, ids.user, d.id, fresh))).toBe('VAT_RATE_NOT_CONFIGURED');
    });
    it('submits a correct sales draft and preserves its stored values afterwards', async () => {
      const d = await drafts.create(ids.coA, ids.user, 'sales', draft([std('15')]));
      const sub = await drafts.submit(ids.coA, ids.user, d.id, d.version);
      expect(sub.status).toBe('submitted');
      const row = (await q(`SELECT vat_amount::text v, total_amount::text t FROM invoices WHERE id=$1`, [d.id]))[0];
      expect(row).toEqual({ v: '15.00', t: '115.00' });
    });
    it('does not apply to purchase invoices or other tenants’ data', async () => {
      const supplier = (await q(`INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'S','supplier',$2) RETURNING id`, [ids.coA, ids.user]))[0].id;
      const p = await drafts.create(ids.coA, ids.user, 'purchase', parseDraft({ counterparty_id: supplier, issue_date: '2026-03-10', tax_point_date: '2026-03-10', lines: [std('5')] }));
      expect(p.lines[0].vat_rate).toBe('5.00');
      // a company cannot read or submit another company's draft through the rate-validated path
      const d = await drafts.create(ids.coA, ids.user, 'sales', draft([std('15')]));
      expect(await errCode(drafts.submit(ids.coB, ids.user, d.id, d.version))).toBe('INVOICE_NOT_FOUND');
    });
  });
});
