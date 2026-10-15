import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Owner-approved access model (migration 075, 2026-10-15) over real HTTP + PostgreSQL:
// global System Admin, Full Access wildcard, Company Manager ceilings and delegation, multi-company memberships,
// and invoice approval without manual journal permissions. Runs on its OWN throwaway database because System Admin
// status is global (the shared test database holds other suites' users).
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Access-Model-1!';

describeDatabase('access model: System Admin, Full Access wildcard, Company Manager (PostgreSQL)', () => {
  const dbName = `eqfal_access_${randomBytes(6).toString('hex')}`;
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const testUrl = new URL(databaseUrl as string);
  testUrl.pathname = `/${dbName}`;
  const originalUrl = process.env['DATABASE_URL'];
  let pool: Pool;
  let server: http.Server;
  let base = '';
  const ids: Record<string, string> = {};
  const roles: Record<string, string> = {};

  class Client {
    cookie = '';
    session: any = null;
    constructor(readonly email: string) {}
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
      this.session = res.json;
      return res.json;
    }
    async use(companyId: string) {
      const res = await this.req('POST', '/auth/switch-company', { companyId });
      if (res.status !== 200) throw new Error(`switch failed: ${res.status}`);
      this.session = res.json;
      return res.json;
    }
  }
  const clients: Record<string, Client> = {};
  const email = (label: string) => `access-${label}@example.test`;
  const q = async <T = any>(sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows as T[];
  const n = async (sql: string, p: unknown[] = []) => Number((await pool.query<{ n: string }>(sql, p)).rows[0]!.n);
  const roleId = async (company: string, name: string) => (await q<{ id: string }>('SELECT id FROM roles WHERE company_id=$1 AND name=$2', [company, name]))[0]!.id;
  const membershipId = async (user: string, company: string) => (await q<{ id: string }>('SELECT id FROM memberships WHERE user_id=$1 AND company_id=$2', [user, company]))[0]!.id;
  const allCaps = async () => (await q<{ id: string }>('SELECT id FROM capabilities ORDER BY id')).map((r) => r.id);

  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE ${dbName}`);
    process.env['DATABASE_URL'] = testUrl.toString();
    const { runMigrations } = await import('../src/db/migrate');
    const { default: sharedPool } = await import('../src/db/pool');
    pool = sharedPool!;
    await runMigrations(pool);
    const { default: app } = await import('../src/app');
    const { CompanyManagementService } = await import('../src/modules/companies/company.service');
    const { InvoiceAccountMappingService } = await import('../src/modules/invoices/invoice-account-mapping.service');
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const hash = await bcrypt.hash(PASSWORD, 4);
    for (const label of ['sa', 'ownerA', 'ownerB', 'mgrA', 'multi', 'ops', 'staffA', 'staffB', 'outsider']) {
      ids[label] = (await q<{ id: string }>('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email(label), hash]))[0]!.id;
    }
    const companies = new CompanyManagementService(pool);
    ids.coA = (await companies.create({ slug: 'access-a', name: 'Access A', name_ar: 'شركة أ' }, ids.ownerA!)).id;
    ids.coB = (await companies.create({ slug: 'access-b', name: 'Access B', name_ar: null }, ids.ownerB!)).id;
    for (const [company, key] of [[ids.coA!, 'A'], [ids.coB!, 'B']] as const) {
      for (const name of ['Viewer', 'Accountant', 'Finance Manager', 'Company Manager', 'Full Access']) roles[`${name}${key}`] = await roleId(company, name);
    }
    const member = (user: string, company: string, role: string) => q('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [user, company, role]);
    await member(ids.mgrA!, ids.coA!, roles['Company ManagerA']!);
    await member(ids.multi!, ids.coA!, roles['ViewerA']!);
    await member(ids.multi!, ids.coB!, roles['AccountantB']!);
    await member(ids.staffA!, ids.coA!, roles['ViewerA']!);
    await member(ids.staffB!, ids.coB!, roles['ViewerB']!);
    // Operational (non-accountant) role: invoices end to end, approval included, but NO manual journal or obligation capability.
    roles.opsA = (await q<{ id: string }>("INSERT INTO roles(company_id,name) VALUES($1,'Operations') RETURNING id", [ids.coA]))[0]!.id;
    for (const c of ['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit', 'invoice.approve']) await q('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [roles.opsA, c]);
    await member(ids.ops!, ids.coA!, roles.opsA);

    // Invoice prerequisites in A: an open fiscal year covering the issue date, account mappings and a customer.
    ids.fyA = (await q<{ id: string }>("INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY26','2026-01-01','2026-12-31') RETURNING id", [ids.coA]))[0]!.id;
    const mappings = new InvoiceAccountMappingService(pool);
    for (const [k, t] of Object.entries({ receivable: 'asset', payable: 'liability', sales_revenue: 'revenue', purchase_expense: 'expense', vat_output: 'liability', vat_input: 'asset' })) {
      const acc = (await q<{ id: string }>('INSERT INTO accounts(company_id,code,name,account_type) VALUES($1,$2,$2,$3) RETURNING id', [ids.coA, `AM-${k}`, t]))[0]!.id;
      await mappings.set(ids.coA!, ids.ownerA!, k, acc);
    }
    ids.customerA = (await q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,'Customer A','customer',true,$2) RETURNING id", [ids.coA, ids.ownerA]))[0]!.id;
    ids.customerB = (await q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,'Customer B','customer',true,$2) RETURNING id", [ids.coB, ids.ownerB]))[0]!.id;
    ids.invoiceB = (await q<{ id: string }>(
      `INSERT INTO invoices(company_id,direction,status,counterparty_id,issue_date,currency,subtotal_amount,vat_amount,total_amount,created_by_user_id)
       VALUES($1,'sales','draft',$2,'2026-10-01','SAR',0,0,0,$3) RETURNING id`, [ids.coB, ids.customerB, ids.ownerB]))[0]!.id;

    for (const label of ['ownerA', 'ownerB', 'mgrA', 'multi', 'ops', 'staffA', 'staffB', 'outsider']) { clients[label] = new Client(email(label)); await clients[label]!.login(); }
  }, 180_000);

  afterAll(async () => {
    server?.close();
    await pool?.end();
    process.env['DATABASE_URL'] = originalUrl;
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await adminPool.end();
  });

  // ── 1. One-time System Admin bootstrap ─────────────────────────────────
  it('bootstrap: promotes one existing account once, audits it, then refuses; never creates accounts', async () => {
    const { bootstrapSystemAdmin } = await import('../src/modules/memberships/system-admin.service');
    expect(await n('SELECT count(*) n FROM users WHERE is_system_admin')).toBe(0);
    await expect(bootstrapSystemAdmin(pool, 'nobody@example.test')).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    const usersBefore = await n('SELECT count(*) n FROM users');
    expect(await bootstrapSystemAdmin(pool, email('sa'))).toMatchObject({ userId: ids.sa });
    await expect(bootstrapSystemAdmin(pool, email('ownerA'))).rejects.toMatchObject({ code: 'ALREADY_INITIALIZED' });
    expect(await n('SELECT count(*) n FROM users')).toBe(usersBefore);
    expect(await n('SELECT count(*) n FROM users WHERE is_system_admin')).toBe(1);
    expect(await n("SELECT count(*) n FROM system_audit_log WHERE action='system.admin.bootstrap' AND target_user_id=$1 AND actor_label='bootstrap-cli'", [ids.sa])).toBe(1);
    // Migration 075 itself promoted nobody, and the audit is append-only.
    await expect(q("UPDATE system_audit_log SET action='x'")).rejects.toMatchObject({ code: '23514' });
    clients.sa = new Client(email('sa'));
  });

  // ── 2. System Admin global access without memberships ───────────────────
  it('System Admin can select any active company without a membership and holds every capability there', async () => {
    expect(await n('SELECT count(*) n FROM memberships WHERE user_id=$1', [ids.sa])).toBe(0);
    const session = await clients.sa!.login();
    expect(session.user.isSystemAdmin).toBe(true);
    expect(session.allowedCompanies.map((c: { id: string }) => c.id).sort()).toEqual([ids.coA, ids.coB].sort());
    const inB = await clients.sa!.use(ids.coB!);
    expect(inB.activeCompanyId).toBe(ids.coB);
    expect([...inB.capabilities].sort()).toEqual(await allCaps());
  });

  it('System Admin performs financial operations in a company it is not a member of; business validation still applies', async () => {
    const sa = clients.sa!;
    await sa.use(ids.coB!);
    expect((await sa.req('GET', `/invoices/${ids.invoiceB}`)).status).toBe(200);
    expect((await sa.req('GET', '/journals')).status).toBe(200);
    const fy = await sa.req('POST', '/fiscal-years', { name: 'SA FY', start_date: '2025-01-01', end_date: '2025-12-31' });
    expect(fy.status, JSON.stringify(fy.json)).toBe(201);
    const fyId = fy.json.fiscalYear.id as string;
    // Overlapping fiscal year is still refused: authority never bypasses integrity rules.
    expect((await sa.req('POST', '/fiscal-years', { name: 'Overlap', start_date: '2025-06-01', end_date: '2026-05-31' })).status).toBe(409);
    const cash = (await sa.req('POST', '/accounts', { code: 'SA-1000', name: 'Cash', name_en: 'Cash', account_type: 'asset' })).json;
    const equity = (await sa.req('POST', '/accounts', { code: 'SA-3000', name: 'Equity', name_en: 'Equity', account_type: 'equity' })).json;
    const journal = await sa.req('POST', '/journals', { fiscal_year_id: fyId, accounting_date: '2025-02-01', description: 'System Admin journal' });
    expect(journal.status).toBe(201);
    const lines = await sa.req('PUT', `/journals/${journal.json.id}/lines`, { lines: [{ account_id: cash.id, debit: '100.00', credit: '0', memo: null }, { account_id: equity.id, debit: '0', credit: '90.00', memo: null }] });
    expect(lines.status, JSON.stringify(lines.json)).toBe(200);
    const unbalanced = await sa.req('POST', `/journals/${journal.json.id}/post`, {});
    expect(unbalanced.status).not.toBe(200);
    expect(unbalanced.status).not.toBe(403);
    await sa.req('PUT', `/journals/${journal.json.id}/lines`, { lines: [{ account_id: cash.id, debit: '100.00', credit: '0', memo: null }, { account_id: equity.id, debit: '0', credit: '100.00', memo: null }] });
    const posted = await sa.req('POST', `/journals/${journal.json.id}/post`, {});
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    // Closing an unready fiscal year is refused by the readiness rules (not by authorization).
    const close = await sa.req('POST', `/fiscal-years/${fyId}/close`, {});
    expect(close.status).toBe(409);
    expect(await n("SELECT count(*) n FROM audit_log WHERE company_id=$1 AND actor_user_id=$2 AND action='journal.post'", [ids.coB, ids.sa])).toBe(1);
  });

  // ── 3. No unauthorized System Admin promotion or removal ─────────────────
  it('only a System Admin can grant or revoke System Admin; the last one is protected (service and database)', async () => {
    const owner = clients.ownerA!;
    expect((await owner.req('PUT', `/admin/users/${ids.ownerA}/system-admin`, { is_system_admin: true })).status).toBe(403);
    expect((await owner.req('GET', '/admin/users')).status).toBe(403);
    expect((await clients.mgrA!.req('GET', '/admin/companies')).status).toBe(403);
    const sa = clients.sa!;
    const lastRevoke = await sa.req('PUT', `/admin/users/${ids.sa}/system-admin`, { is_system_admin: false });
    expect(lastRevoke.status).toBe(403);
    expect(lastRevoke.json.code).toBe('ACCESS_LAST_SYSTEM_ADMIN');
    await expect(q('UPDATE users SET is_system_admin = FALSE WHERE id=$1', [ids.sa])).rejects.toMatchObject({ code: '23514' });
    expect((await sa.req('PATCH', `/admin/users/${ids.sa}/active`, { is_active: false })).json.code).toBe('ACCESS_SELF_LOCKOUT');
    // Grant to a second account, then revoke again: both audited globally.
    expect((await sa.req('PUT', `/admin/users/${ids.staffB}/system-admin`, { is_system_admin: true })).status).toBe(200);
    expect((await sa.req('PUT', `/admin/users/${ids.staffB}/system-admin`, { is_system_admin: false })).status).toBe(200);
    expect(await n("SELECT count(*) n FROM system_audit_log WHERE target_user_id=$1 AND action IN ('system.admin.grant','system.admin.revoke') AND actor_user_id=$2", [ids.staffB, ids.sa])).toBe(2);
    // Company-scoped administration has no way to set the global marker.
    expect((await q('SELECT is_system_admin FROM users WHERE id=$1', [ids.ownerA]))[0].is_system_admin).toBe(false);
  });

  // ── 4/5. Full Access wildcard and isolation ──────────────────────────────
  it('Full Access resolves every registered capability (invoice.* included) without role_capabilities rows, and a newly registered one automatically', async () => {
    const { MembershipRepository } = await import('../src/modules/memberships/membership.repository');
    const repo = new MembershipRepository(pool);
    expect(await n('SELECT count(*) n FROM role_capabilities WHERE role_id=$1', [roles['Full AccessA']])).toBe(0);
    const caps = (await repo.getActiveCapabilities(ids.ownerA!, ids.coA!)).sort();
    expect(caps).toEqual(await allCaps());
    for (const c of ['invoice.view', 'invoice.approve', 'invoice.adjust_approve', 'invoice.cancel', 'invoice.recurring', 'access.full_access.grant']) expect(caps).toContain(c);
    await q("INSERT INTO capabilities(id) VALUES('zz_future.capability')");
    expect(await repo.getActiveCapabilities(ids.ownerA!, ids.coA!)).toContain('zz_future.capability');
    expect(await repo.getActiveCapabilities(ids.sa!, ids.coA!)).toContain('zz_future.capability');
    expect(await repo.getActiveCapabilities(ids.staffA!, ids.coA!)).not.toContain('zz_future.capability');
    expect(await repo.getActiveCapabilities(ids.mgrA!, ids.coA!)).not.toContain('zz_future.capability');
    // The explicit-only exception cannot come back.
    await expect(q("INSERT INTO capabilities(id, implicit_full_access) VALUES('zz_excluded.capability', FALSE)")).rejects.toMatchObject({ code: '23514' });
    await q("DELETE FROM capabilities WHERE id='zz_future.capability'");
  });

  it('Full Access in Company A grants nothing in Company B (session, switcher and direct API)', async () => {
    const owner = clients.ownerA!;
    const session = await owner.login();
    expect(session.allowedCompanies.map((c: { id: string }) => c.id)).toEqual([ids.coA]);
    expect((await owner.req('POST', '/auth/switch-company', { companyId: ids.coB })).status).toBe(403);
    expect((await owner.req('GET', `/invoices/${ids.invoiceB}`)).status).toBe(404);
    const { MembershipRepository } = await import('../src/modules/memberships/membership.repository');
    expect(await new MembershipRepository(pool).getActiveCapabilities(ids.ownerA!, ids.coB!)).toEqual([]);
  });

  // ── 9. Same user, different roles per company ─────────────────────────────
  it('a user with memberships in A and B has a different role and capabilities in each; the switcher lists only those', async () => {
    const multi = clients.multi!;
    const session = await multi.login();
    expect(session.user.isSystemAdmin).toBe(false);
    expect(session.allowedCompanies.map((c: { id: string }) => c.id).sort()).toEqual([ids.coA, ids.coB].sort());
    const inA = await multi.use(ids.coA!);
    const inB = await multi.use(ids.coB!);
    expect(inA.capabilities).not.toContain('accounting.journal.create');
    expect(inB.capabilities).toContain('accounting.journal.create');
    expect((await multi.req('POST', '/journals', { fiscal_year_id: ids.fyA, accounting_date: '2026-02-01', description: 'x' })).status).not.toBe(403);
    await multi.use(ids.coA!);
    expect((await multi.req('POST', '/journals', { fiscal_year_id: ids.fyA, accounting_date: '2026-02-01', description: 'x' })).status).toBe(403);
  });

  // ── 7/8. Company Manager: ceilings, delegation, isolation ─────────────────
  it('Company Manager manages permitted staff in its own company, within the ceiling', async () => {
    const mgr = clients.mgrA!;
    const created = await mgr.req('POST', '/access/users', { email: email('newstaff'), password: 'Temporary-Pass-1', role_id: roles['ViewerA'] });
    expect(created.status).toBe(201);
    expect(created.json.company_id).toBe(ids.coA);
    const staffMembership = await membershipId(ids.staffA!, ids.coA!);
    expect((await mgr.req('PATCH', `/access/memberships/${staffMembership}/active`, { is_active: false })).status).toBe(200);
    expect((await mgr.req('PATCH', `/access/memberships/${staffMembership}/active`, { is_active: true })).status).toBe(200);
    const customRole = await mgr.req('POST', '/access/roles', { name: 'Sales clerk' });
    expect(customRole.status).toBe(201);
    expect((await mgr.req('POST', `/access/roles/${customRole.json.id}/capabilities/bulk`, { grants: ['invoice.view', 'invoice.create'] })).status).toBe(204);
    expect(await n("SELECT count(*) n FROM audit_log WHERE company_id=$1 AND actor_user_id=$2 AND action LIKE 'access.%'", [ids.coA, ids.mgrA])).toBeGreaterThanOrEqual(5);
  });

  it('Company Manager cannot escalate: no Full Access, no role beyond its ceiling, no capability it lacks, no more-privileged target', async () => {
    const mgr = clients.mgrA!;
    const staffMembership = await membershipId(ids.staffA!, ids.coA!);
    const fa = await mgr.req('PUT', `/access/memberships/${staffMembership}/role`, { role_id: roles['Full AccessA'] });
    expect(fa.status).toBe(403);
    expect(fa.json.code).toBe('ACCESS_ROLE_CEILING');
    expect((await mgr.req('PUT', `/access/memberships/${staffMembership}/role`, { role_id: roles['Finance ManagerA'] })).json.code).toBe('ACCESS_ROLE_CEILING');
    expect((await mgr.req('PUT', `/access/roles/${roles['ViewerA']}/capabilities/accounting.journal.post`)).json.code).toBe('ACCESS_ROLE_CEILING');
    expect((await mgr.req('PUT', `/access/roles/${roles['ViewerA']}/capabilities/access.full_access.grant`)).json.code).toBe('ACCESS_ROLE_CEILING');
    const ownerMembership = await membershipId(ids.ownerA!, ids.coA!);
    expect((await mgr.req('PATCH', `/access/memberships/${ownerMembership}/active`, { is_active: false })).json.code).toBe('ACCESS_TARGET_PRIVILEGE');
    expect((await mgr.req('PUT', `/access/memberships/${ownerMembership}/role`, { role_id: roles['ViewerA'] })).json.code).toBe('ACCESS_TARGET_PRIVILEGE');
    expect((await q('SELECT role_id FROM memberships WHERE id=$1', [staffMembership]))[0].role_id).toBe(roles['ViewerA']);
  });

  it('Company Manager in A cannot touch Company B memberships, roles or permissions', async () => {
    const mgr = clients.mgrA!;
    const bMembership = await membershipId(ids.staffB!, ids.coB!);
    expect((await mgr.req('PATCH', `/access/memberships/${bMembership}/active`, { is_active: false })).status).toBe(404);
    expect((await mgr.req('PUT', `/access/memberships/${bMembership}/role`, { role_id: roles['ViewerA'] })).status).toBe(404);
    expect((await mgr.req('PUT', `/access/roles/${roles['ViewerB']}/capabilities/invoice.view`)).status).toBe(404);
    expect((await mgr.req('POST', `/access/roles/${roles['ViewerB']}/capabilities/bulk`, { grants: ['invoice.view'] })).status).toBe(404);
    expect((await mgr.req('POST', '/auth/switch-company', { companyId: ids.coB })).status).toBe(403);
    const listed = (await mgr.req('GET', '/access/memberships')).json.memberships as Array<{ company_id: string }>;
    expect(listed.every((m) => m.company_id === ids.coA)).toBe(true);
    expect((await q('SELECT is_active FROM memberships WHERE id=$1', [bMembership]))[0].is_active).toBe(true);
  });

  it('Full Access holder delegates Full Access authority explicitly; the delegate grants it to others but not to itself, only in its company', async () => {
    const owner = clients.ownerA!;
    await owner.login();
    expect((await owner.req('PUT', `/access/roles/${roles['Company ManagerA']}/capabilities/access.full_access.grant`)).status).toBe(204);
    const mgr = clients.mgrA!;
    await mgr.login();
    const self = await mgr.req('PUT', `/access/memberships/${await membershipId(ids.mgrA!, ids.coA!)}/role`, { role_id: roles['Full AccessA'] });
    expect(self.status).toBe(403);
    expect(self.json.code).toBe('ACCESS_ROLE_CEILING');
    const staffMembership = await membershipId(ids.staffA!, ids.coA!);
    expect((await mgr.req('PUT', `/access/memberships/${staffMembership}/role`, { role_id: roles['Full AccessA'] })).status).toBe(200);
    expect((await mgr.req('PUT', `/access/memberships/${staffMembership}/role`, { role_id: roles['ViewerA'] })).status).toBe(200);
    expect((await mgr.req('PUT', `/access/memberships/${await membershipId(ids.staffB!, ids.coB!)}/role`, { role_id: roles['Full AccessB'] })).status).toBe(404);
    expect((await q('SELECT is_system_admin FROM users WHERE id=$1', [ids.mgrA]))[0].is_system_admin).toBe(false);
    expect((await owner.req('DELETE', `/access/roles/${roles['Company ManagerA']}/capabilities/access.full_access.grant`)).status).toBe(204);
  });

  it('the last active Full Access member cannot be disabled or demoted, by a company owner or a System Admin', async () => {
    const ownerB = clients.ownerB!;
    const own = await membershipId(ids.ownerB!, ids.coB!);
    expect((await ownerB.req('PUT', `/access/memberships/${own}/role`, { role_id: roles['ViewerB'] })).json.code).toBe('ACCESS_LAST_FULL_ACCESS');
    const sa = clients.sa!;
    expect((await sa.req('PATCH', `/admin/memberships/${own}/active`, { is_active: false })).json.code).toBe('ACCESS_LAST_FULL_ACCESS');
    expect((await sa.req('PUT', `/admin/memberships/${own}/role`, { role_id: roles['ViewerB'] })).json.code).toBe('ACCESS_LAST_FULL_ACCESS');
    expect((await sa.req('PATCH', `/admin/users/${ids.ownerB}/active`, { is_active: false })).json.code).toBe('ACCESS_LAST_FULL_ACCESS');
  });

  // ── 10. Multi-company administration through the API (no SQL) ────────────
  it('System Admin creates a user and assigns separate roles in A and B, changes and disables them, all audited', async () => {
    const sa = clients.sa!;
    const user = await sa.req('POST', '/admin/users', { email: email('crossco'), password: PASSWORD });
    expect(user.status).toBe(201);
    expect(await n("SELECT count(*) n FROM system_audit_log WHERE action='system.user.create' AND target_user_id=$1 AND actor_user_id=$2", [user.json.id, ids.sa])).toBe(1);
    const inA = await sa.req('POST', '/admin/memberships', { user_id: user.json.id, company_id: ids.coA, role_id: roles['ViewerA'] });
    const inB = await sa.req('POST', '/admin/memberships', { user_id: user.json.id, company_id: ids.coB, role_id: roles['AccountantB'] });
    expect([inA.status, inB.status]).toEqual([201, 201]);
    expect((await sa.req('POST', '/admin/memberships', { user_id: user.json.id, company_id: ids.coB, role_id: roles['ViewerB'] })).status).toBe(409);
    const list = (await sa.req('GET', `/admin/users/${user.json.id}/memberships`)).json.memberships as Array<{ company_id: string; role_name: string }>;
    expect(Object.fromEntries(list.map((m) => [m.company_id, m.role_name]))).toEqual({ [ids.coA!]: 'Viewer', [ids.coB!]: 'Accountant' });
    expect((await sa.req('PUT', `/admin/memberships/${inB.json.id}/role`, { role_id: roles['Company ManagerB'] })).status).toBe(200);
    expect((await sa.req('PATCH', `/admin/memberships/${inA.json.id}/active`, { is_active: false })).status).toBe(200);
    // A role from another company is never accepted for a membership.
    expect((await sa.req('PUT', `/admin/memberships/${inB.json.id}/role`, { role_id: roles['ViewerA'] })).status).toBe(404);
    const crossco = new Client(email('crossco'));
    const session = await crossco.login();
    expect(session.allowedCompanies.map((c: { id: string }) => c.id)).toEqual([ids.coB]);
    expect(session.capabilities).toContain('access.membership.create');
    expect(await n("SELECT count(*) n FROM audit_log WHERE actor_user_id=$1 AND company_id=$2 AND action IN ('access.membership.create','access.membership.role.assign')", [ids.sa, ids.coB])).toBeGreaterThanOrEqual(3);
    expect(await n("SELECT count(*) n FROM audit_log WHERE actor_user_id=$1 AND company_id=$2 AND action='access.membership.disable'", [ids.sa, ids.coA])).toBe(1);
    // Disabling the account ends its sessions immediately.
    expect((await sa.req('PATCH', `/admin/users/${user.json.id}/active`, { is_active: false })).status).toBe(200);
    expect((await crossco.req('GET', '/auth/session')).status).toBe(401);
  });

  it('System Admin manages companies globally (create, disable, enable) without a membership', async () => {
    const sa = clients.sa!;
    const created = await sa.req('POST', '/admin/companies', { slug: 'access-c', name: 'Access C' });
    expect(created.status).toBe(201);
    expect(await n('SELECT count(*) n FROM roles WHERE company_id=$1', [created.json.id])).toBe(5);
    expect((await sa.req('PATCH', `/admin/companies/${ids.coB}/active`, { is_active: false })).status).toBe(200);
    expect((await clients.ownerB!.req('GET', '/journals')).status).toBe(403);
    const listed = (await sa.req('GET', '/admin/companies')).json.companies as Array<{ id: string; is_active: boolean }>;
    expect(listed.find((c) => c.id === ids.coB)?.is_active).toBe(false);
    expect((await sa.req('PATCH', `/admin/companies/${ids.coB}/active`, { is_active: true })).status).toBe(200);
    expect(await n("SELECT count(*) n FROM audit_log WHERE company_id=$1 AND actor_user_id=$2 AND action IN ('company.disable','company.enable')", [ids.coB, ids.sa])).toBe(2);
  });

  // ── 12. Unauthorized direct API access ────────────────────────────────────
  it('direct API calls without the capability, company or System Admin status are refused server-side', async () => {
    const outsider = clients.outsider!;
    expect(outsider.session.allowedCompanies).toEqual([]);
    expect((await outsider.req('GET', '/invoices')).status).toBe(403);
    expect((await outsider.req('GET', '/admin/users')).status).toBe(403);
    expect((await outsider.req('POST', '/admin/memberships', { user_id: ids.outsider, company_id: ids.coA, role_id: roles['Full AccessA'] })).status).toBe(403);
    expect((await clients.staffA!.req('GET', '/access/memberships')).status).toBe(403);
    expect((await clients.staffA!.req('POST', '/access/users', { email: email('x'), password: 'Temporary-Pass-1' })).status).toBe(403);
    expect((await new Client(email('nobody')).req('GET', '/admin/companies')).status).toBe(401);
    expect((await clients.sa!.req('GET', '/admin/users', undefined, {})).status).toBe(200);
    expect((await clients.sa!.req('POST', '/admin/users', { email: email('evil'), password: 'Temporary-Pass-1' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(await n('SELECT count(*) n FROM memberships WHERE user_id=$1', [ids.outsider])).toBe(0);
  });

  // ── 13/15/16. Invoice approval without manual journal permissions ─────────
  it('an operational user with invoice.approve (no journal.create / obligation.confirm) approves their own invoice; effects are atomic and DRAFT; manual journals stay forbidden', async () => {
    const ops = clients.ops!;
    await ops.login();
    expect(ops.session.capabilities).not.toContain('accounting.journal.create');
    expect(ops.session.capabilities).not.toContain('obligation.confirm');
    const draft = (await ops.req('POST', '/invoices', {
      direction: 'sales', counterparty_id: ids.customerA, issue_date: '2026-10-01', tax_point_date: '2026-10-01',
      lines: [{ description: 'Service', quantity: '2', unit_price: '500.00', vat_rate: '15', vat_treatment: 'standard' }],
    })).json.invoice;
    const submitted = (await ops.req('POST', `/invoices/${draft.id}/submit`, { version: draft.version })).json.invoice;
    const approved = await ops.req('POST', `/invoices/${submitted.id}/approve`, { version: submitted.version });
    expect(approved.status).toBe(200);
    expect(approved.json.invoice).toMatchObject({ status: 'approved', approved_by_user_id: ids.ops, created_by_user_id: ids.ops });
    expect(await n("SELECT count(*) n FROM obligations WHERE id=$1 AND verification_status='confirmed' AND source_type='invoice'", [approved.json.obligation_id])).toBe(1);
    const journal = (await q<{ status: string; d: string; c: string }>(
      `SELECT j.status, SUM(l.debit)::text d, SUM(l.credit)::text c FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id
       WHERE j.id=$1 GROUP BY j.status`, [approved.json.journal_id]))[0]!;
    expect(journal).toEqual({ status: 'draft', d: '1150.00', c: '1150.00' });
    expect(await n('SELECT count(*) n FROM invoice_vat_reviews WHERE invoice_id=$1', [submitted.id])).toBe(1);
    expect(await n("SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action='invoice.approve' AND actor_user_id=$2", [submitted.id, ids.ops])).toBe(1);
    expect((await ops.req('POST', '/journals', { fiscal_year_id: ids.fyA, accounting_date: '2026-10-01', description: 'manual' })).status).toBe(403);
    expect((await ops.req('POST', `/journals/${approved.json.journal_id}/post`, {})).status).toBe(403);
  });
});
