import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// PR-2A: invoice.view/create/edit are explicit-grant-only (capabilities.implicit_full_access = FALSE).
// Requires an isolated, disposable PostgreSQL database with migrations applied (DATABASE_URL).
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Invoice-Grant-1!';
const INVOICE_CAPS = ['invoice.view', 'invoice.create', 'invoice.edit'];

describeDatabase('explicit-grant-only invoice capabilities (PostgreSQL)', () => {
  let pool: Pool;
  let server: http.Server;
  let base = '';
  let repo: import('../src/modules/memberships/membership.repository').MembershipRepository;
  let companyService: import('../src/modules/companies/company.service').CompanyManagementService;
  const run = randomUUID().slice(0, 8);
  const ids = { owner: '', ownerB: '', granter: '', plain: '', coA: '', coB: '', fullA: '', fullB: '' };
  const roles: Record<string, string> = {};

  class Client {
    cookie = '';
    constructor(private readonly email: string) {}
    async req(method: string, url: string, body?: unknown) {
      const headers: Record<string, string> = { origin: base };
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
  let owner: Client; let granter: Client; let plain: Client;

  const email = (label: string) => `invgrant-${label}-${run}@example.test`;
  const grantRows = async (roleId: string) => (await pool.query<{ capability_id: string }>('SELECT capability_id FROM role_capabilities WHERE role_id = $1 ORDER BY 1', [roleId])).rows.map((r) => r.capability_id);
  const caps = (user: string, company: string) => repo.getActiveCapabilities(user, company);
  const mkRole = async (company: string, name: string, capabilities: string[]) => {
    const id = (await pool.query<{ id: string }>('INSERT INTO roles(company_id,name,is_full_access) VALUES($1,$2,FALSE) RETURNING id', [company, name])).rows[0]!.id;
    for (const c of capabilities) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [id, c]);
    return id;
  };
  const member = (user: string, company: string, role: string) =>
    pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3) ON CONFLICT (user_id, company_id) DO UPDATE SET role_id = $3, is_active = TRUE', [user, company, role]);

  beforeAll(async () => {
    const { default: sharedPool } = await import('../src/db/pool');
    const { default: app } = await import('../src/app');
    const { CompanyManagementService } = await import('../src/modules/companies/company.service');
    const { MembershipRepository } = await import('../src/modules/memberships/membership.repository');
    pool = sharedPool!;
    repo = new MembershipRepository(pool);
    companyService = new CompanyManagementService(pool);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const hash = await bcrypt.hash(PASSWORD, 4);
    const mkUser = async (label: string) => (await pool.query<{ id: string }>('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email(label), hash])).rows[0]!.id;
    ids.owner = await mkUser('owner'); ids.ownerB = await mkUser('ownerb'); ids.granter = await mkUser('granter'); ids.plain = await mkUser('plain');
    ids.coA = (await companyService.create({ slug: `invgrant-a-${run}`, name: `INVGRANT-A-${run}`, name_ar: null }, ids.owner)).id;
    ids.coB = (await companyService.create({ slug: `invgrant-b-${run}`, name: `INVGRANT-B-${run}`, name_ar: null }, ids.ownerB)).id;
    ids.fullA = (await pool.query<{ id: string }>('SELECT id FROM roles WHERE company_id=$1 AND is_full_access', [ids.coA])).rows[0]!.id;
    ids.fullB = (await pool.query<{ id: string }>('SELECT id FROM roles WHERE company_id=$1 AND is_full_access', [ids.coB])).rows[0]!.id;
    // Target role (no invoice grants) and a delegating role that holds the grant right plus invoice.view only.
    roles['target'] = await mkRole(ids.coA, 'Target', []);
    roles['targetB'] = await mkRole(ids.coB, 'TargetB', []);
    roles['granter'] = await mkRole(ids.coA, 'Granter', ['access.view', 'access.role.capability.grant', 'access.role.capability.revoke', 'invoice.view']);
    roles['plain'] = await mkRole(ids.coA, 'Plain', ['access.view', 'access.role.capability.grant']);
    await member(ids.granter, ids.coA, roles['granter']!);
    await member(ids.plain, ids.coA, roles['plain']!);
    owner = new Client(email('owner')); granter = new Client(email('granter')); plain = new Client(email('plain'));
    await Promise.all([owner.login(), granter.login(), plain.login()]);
  });

  afterAll(async () => {
    // audit_log is append-only, so the disposable test database keeps this run's uniquely named rows.
    server.close();
  });

  it('registers invoice.* as explicit-only and assigns it to no role', async () => {
    const rows = (await pool.query<{ id: string; implicit_full_access: boolean }>("SELECT id, implicit_full_access FROM capabilities WHERE id LIKE 'invoice.%' ORDER BY id")).rows;
    expect(rows.map((r) => r.id)).toEqual(['invoice.create', 'invoice.edit', 'invoice.view']);
    expect(rows.every((r) => r.implicit_full_access === false)).toBe(true);
    expect((await pool.query("SELECT 1 FROM role_capabilities WHERE capability_id LIKE 'invoice.%' AND role_id IN ($1,$2)", [ids.fullA, ids.fullB])).rowCount).toBe(0);
  });

  it('existing-role regression: Full Access still resolves every pre-existing capability and no invoice permission', async () => {
    // Sort in JS on both sides: the database collation (CI image) orders punctuation differently from a JS sort.
    const expected = (await pool.query<{ id: string }>('SELECT id FROM capabilities WHERE implicit_full_access = TRUE')).rows.map((r) => r.id).sort();
    expect(expected.length).toBeGreaterThanOrEqual(127);
    expect(expected.some((c) => c.startsWith('invoice.'))).toBe(false);
    const viaRepo = (await caps(ids.owner, ids.coA)).sort();
    expect(viaRepo).toEqual(expected);
    const viaCompany = await (companyService as any).capabilitiesIn(ids.owner, ids.coA, pool);
    expect([...viaCompany].sort()).toEqual(expected);
    for (const c of INVOICE_CAPS) { expect(viaRepo).not.toContain(c); expect(viaCompany).not.toContain(c); }
  });

  it('every capability other than invoice.* keeps implicit_full_access = TRUE', async () => {
    expect((await pool.query("SELECT 1 FROM capabilities WHERE implicit_full_access = FALSE AND id NOT LIKE 'invoice.%'")).rowCount).toBe(0);
  });

  it('deny by default: HTTP requests for invoice permissions are refused for Full Access and ordinary roles', async () => {
    const me = await owner.req('GET', '/auth/session');
    expect(JSON.stringify(me.json)).not.toContain('invoice.');
    for (const c of INVOICE_CAPS) {
      const grant = await owner.req('PUT', `/access/roles/${roles['target']}/capabilities/${c}`);
      expect(grant.status, c).toBe(403);
      expect(grant.json?.code).toBe('ACCESS_ROLE_CEILING');
    }
    expect(await grantRows(roles['target']!)).toEqual([]);
  });

  it('privilege escalation: a Full Access owner cannot grant invoice.* via single or bulk endpoints, nor to the Full Access role', async () => {
    const bulk = await owner.req('POST', `/access/roles/${roles['target']}/capabilities/bulk`, { grants: ['access.view', ...INVOICE_CAPS] });
    expect(bulk.status).toBe(403);
    expect(await grantRows(roles['target']!)).toEqual([]); // atomic: nothing from the bulk request was applied
    const onFull = await owner.req('PUT', `/access/roles/${ids.fullA}/capabilities/invoice.view`);
    expect(onFull.status).toBe(403);
    expect(await grantRows(ids.fullA)).toEqual([]);
    const unknown = await owner.req('PUT', `/access/roles/${roles['target']}/capabilities/invoice.approve`);
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(await grantRows(roles['target']!)).toEqual([]);
  });

  it('privilege escalation: holding the grant right without the invoice permission is not enough', async () => {
    const res = await plain.req('PUT', `/access/roles/${roles['target']}/capabilities/invoice.view`);
    expect(res.status).toBe(403);
    expect(await grantRows(roles['target']!)).toEqual([]);
  });

  it('explicit grants resolve exactly as granted (provisioned out of band) and nothing more', async () => {
    expect(await caps(ids.granter, ids.coA)).toContain('invoice.view');
    expect(await caps(ids.granter, ids.coA)).not.toContain('invoice.create');
    expect(await caps(ids.granter, ids.coA)).not.toContain('invoice.edit');
    // an explicit row on a Full Access role resolves that one capability only
    await pool.query("INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,'invoice.view')", [ids.fullB]);
    const full = await caps(ids.ownerB, ids.coB);
    expect(full).toContain('invoice.view');
    expect(full).not.toContain('invoice.create');
    expect(full).not.toContain('invoice.edit');
    expect([...await (companyService as any).capabilitiesIn(ids.ownerB, ids.coB, pool)]).toContain('invoice.view');
    await pool.query("DELETE FROM role_capabilities WHERE role_id=$1 AND capability_id='invoice.view'", [ids.fullB]);
    expect(await caps(ids.ownerB, ids.coB)).not.toContain('invoice.view');
  });

  it('delegation stays inside the ceiling: a holder may pass on only what they hold, and revoke works', async () => {
    const ok = await granter.req('PUT', `/access/roles/${roles['target']}/capabilities/invoice.view`);
    expect(ok.status).toBe(204);
    expect(await grantRows(roles['target']!)).toEqual(['invoice.view']);
    for (const c of ['invoice.create', 'invoice.edit']) {
      expect((await granter.req('PUT', `/access/roles/${roles['target']}/capabilities/${c}`)).status).toBe(403);
    }
    expect((await granter.req('POST', `/access/roles/${roles['target']}/capabilities/bulk`, { grants: ['invoice.create'] })).status).toBe(403);
    expect(await grantRows(roles['target']!)).toEqual(['invoice.view']);
    expect((await granter.req('DELETE', `/access/roles/${roles['target']}/capabilities/invoice.view`)).status).toBe(204);
    expect(await grantRows(roles['target']!)).toEqual([]);
  });

  it('tenant isolation: grants never cross companies', async () => {
    // company A's holder cannot write to company B's role, and a same-named explicit grant in A does not reach B
    const cross = await granter.req('PUT', `/access/roles/${roles['targetB']}/capabilities/invoice.view`);
    expect([403, 404]).toContain(cross.status);
    expect(await grantRows(roles['targetB']!)).toEqual([]);
    expect(await caps(ids.granter, ids.coB)).toEqual([]); // no membership in B
    expect(await caps(ids.ownerB, ids.coB)).not.toContain('invoice.view');
    expect(await caps(ids.owner, ids.coB)).toEqual([]);
  });

  it('re-applying migration 063 is idempotent and keeps invoice.* explicit-only', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/063_explicit_grant_capabilities.sql'), 'utf8');
    await pool.query(sql);
    const rows = (await pool.query("SELECT implicit_full_access FROM capabilities WHERE id LIKE 'invoice.%'")).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.implicit_full_access === false)).toBe(true);
  });
});
