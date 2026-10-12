import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// GET /api/invoices/customers against a real database: tenant isolation, active/non-supplier filter and capability gate.
// Requires an isolated, disposable PostgreSQL database with migrations applied (DATABASE_URL).
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Invoice-Cust-1!';

describeDatabase('invoice customer picker (PostgreSQL)', () => {
  let pool: Pool;
  let server: http.Server;
  let base = '';
  const run = randomUUID().slice(0, 8);
  const ids = { coA: '', coB: '' };
  const emails = { create: `invcust-create-${run}@example.test`, obligationOnly: `invcust-oblig-${run}@example.test`, none: `invcust-none-${run}@example.test` };

  async function get(email: string, url: string) {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const res = await fetch(`${base}/api${url}`, { headers: { origin: base, cookie } });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }

  beforeAll(async () => {
    const { default: sharedPool } = await import('../src/db/pool');
    const { default: app } = await import('../src/app');
    const { CompanyManagementService } = await import('../src/modules/companies/company.service');
    pool = sharedPool!;
    const companyService = new CompanyManagementService(pool);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const hash = await bcrypt.hash(PASSWORD, 4);
    const mkUser = async (email: string) => (await pool.query<{ id: string }>('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email, hash])).rows[0]!.id;
    const ownerA = await mkUser(`invcust-ownera-${run}@example.test`), ownerB = await mkUser(`invcust-ownerb-${run}@example.test`);
    ids.coA = (await companyService.create({ slug: `invcust-a-${run}`, name: `INVCUST-A-${run}`, name_ar: null }, ownerA)).id;
    ids.coB = (await companyService.create({ slug: `invcust-b-${run}`, name: `INVCUST-B-${run}`, name_ar: null }, ownerB)).id;
    const mkRole = async (name: string, capabilities: string[]) => {
      const id = (await pool.query<{ id: string }>('INSERT INTO roles(company_id,name,is_full_access) VALUES($1,$2,FALSE) RETURNING id', [ids.coA, name])).rows[0]!.id;
      for (const c of capabilities) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [id, c]);
      return id;
    };
    for (const [email, role] of [[emails.create, await mkRole('InvCreate', ['invoice.create'])], [emails.obligationOnly, await mkRole('ObligOnly', ['obligation.view'])], [emails.none, await mkRole('None', [])]] as const) {
      await pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [await mkUser(email), ids.coA, role]);
    }
    const cp = (company: string, name: string, type: string, active = true) => pool.query('INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,$2,$3,$4,$5)', [company, name, type, active, ownerA]);
    await cp(ids.coA, `Customer A ${run}`, 'customer');
    await cp(ids.coA, `Gov A ${run}`, 'government');
    await cp(ids.coA, `Supplier A ${run}`, 'supplier');
    await cp(ids.coA, `Inactive A ${run}`, 'customer', false);
    await cp(ids.coB, `Customer B ${run}`, 'customer');
  });

  afterAll(async () => { server.close(); });

  it('an invoice.create-only user gets active non-supplier counterparties of the active company, with id/name/type only', async () => {
    const res = await get(emails.create, '/invoices/customers');
    expect(res.status).toBe(200);
    expect(res.json.customers.map((c: { name: string }) => c.name).sort()).toEqual([`Customer A ${run}`, `Gov A ${run}`]);
    for (const c of res.json.customers) expect(Object.keys(c).sort()).toEqual(['id', 'name', 'type']);
  });

  it('never returns other companies, suppliers or inactive counterparties', async () => {
    const text = JSON.stringify((await get(emails.create, '/invoices/customers')).json);
    for (const hidden of [`Customer B ${run}`, `Supplier A ${run}`, `Inactive A ${run}`]) expect(text).not.toContain(hidden);
  });

  it('refuses users without an invoice view/create/edit capability, including obligation.view holders', async () => {
    expect((await get(emails.obligationOnly, '/invoices/customers')).status).toBe(403);
    expect((await get(emails.none, '/invoices/customers')).status).toBe(403);
  });

  it('leaves /api/counterparties behaviour unchanged: it still requires obligation.view', async () => {
    expect((await get(emails.create, '/counterparties')).status).toBe(403);
    expect((await get(emails.obligationOnly, '/counterparties')).status).toBe(200);
  });
});
