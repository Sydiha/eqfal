import bcrypt from 'bcrypt';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Complements tenant-isolation.http.postgres.test.ts: company A (a Full Access user) replays mutations against
// company B's ids on routes that suite does not cover. Each attempt must be refused (403/404) and company B's rows,
// across every table that carries company_id, must be byte-identical afterwards.
const databaseUrl = process.env['DATABASE_URL'];
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eqfal-tamper-'));
process.env['DOCUMENT_STORAGE_DIR'] = path.join(storageRoot, 'documents');
process.env['BANK_STORAGE_DIR'] = path.join(storageRoot, 'bank-imports');

const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Tenant-Tamper-1!';
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(64)]);
const UUID_RE = /^[0-9a-f-]{36}$/;
const MISSING = '00000000-0000-4000-8000-000000000000';

describeDatabase('Cross-company ID tampering on mutation routes (PostgreSQL)', () => {
  let pool: Pool;
  let server: http.Server;
  let base = '';
  const run = randomUUID().slice(0, 8);
  const ids = { userA: '', userB: '', coA: '', coB: '' };
  const b: Record<string, string> = {};

  class Client {
    cookie = '';
    constructor(private readonly email: string) {}
    async req(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
      const headers: Record<string, string> = { origin: base, ...extra };
      if (this.cookie) headers['cookie'] = this.cookie;
      let payload: Buffer | string | undefined;
      if (body !== undefined) {
        if (Buffer.isBuffer(body)) payload = body;
        else { headers['content-type'] ??= 'application/json'; payload = JSON.stringify(body); }
      }
      const res = await fetch(`${base}/api${url}`, { method, headers, body: payload, redirect: 'manual' });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';')[0]!;
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* empty or binary */ }
      return { status: res.status, json, text };
    }
    async login() {
      const res = await this.req('POST', '/auth/login', { email: this.email, password: PASSWORD });
      if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    }
  }
  let A: Client;
  let B: Client;

  /** md5 over every row of company B in every company-scoped table (plus role_capabilities of B's roles). */
  async function snapshotB(): Promise<Record<string, string>> {
    const tables = (await pool.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'company_id' ORDER BY table_name`)).rows.map((r: { table_name: string }) => r.table_name);
    const out: Record<string, string> = {};
    for (const table of tables) {
      const { rows } = await pool.query(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM "${table}" t WHERE company_id = $1`, [ids.coB]);
      out[table] = rows[0].h;
    }
    out['companies'] = (await pool.query(`SELECT md5(t::text) AS h FROM companies t WHERE id = $1`, [ids.coB])).rows[0].h;
    out['role_capabilities'] = (await pool.query(
      `SELECT md5(coalesce(string_agg(rc::text, '|' ORDER BY rc::text), '')) AS h FROM role_capabilities rc JOIN roles r ON r.id = rc.role_id WHERE r.company_id = $1`, [ids.coB])).rows[0].h;
    return out;
  }

  beforeAll(async () => {
    const { default: sharedPool } = await import('../src/db/pool');
    const { default: app } = await import('../src/app');
    const { CompanyManagementService } = await import('../src/modules/companies/company.service');
    pool = sharedPool!;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const hash = await bcrypt.hash(PASSWORD, 4);
    const mkUser = async (label: string): Promise<string> => (await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [`tamper-${label}-${run}@example.test`, hash])).rows[0].id;
    ids.userA = await mkUser('a');
    ids.userB = await mkUser('b');
    const service = new CompanyManagementService(pool);
    ids.coA = (await service.create({ slug: `tamper-a-${run}`, name: `TAMPER-A-${run}`, name_ar: null }, ids.userA)).id;
    ids.coB = (await service.create({ slug: `tamper-b-${run}`, name: `TAMPER-B-${run}`, name_ar: null }, ids.userB)).id;
    A = new Client(`tamper-a-${run}@example.test`);
    B = new Client(`tamper-b-${run}@example.test`);
    await A.login();
    await B.login();

    // Company B fixtures, created through its own API session where possible.
    let r = await B.req('POST', '/fiscal-years', { name: 'FY B', start_date: '2026-01-01', end_date: '2026-12-31' });
    b['fy'] = r.json?.fiscalYear?.id;
    const accounts: string[] = [];
    for (const [code, type] of [['1000', 'asset'], ['4000', 'revenue']] as const) {
      r = await B.req('POST', '/accounts', { code: `${code}-B${run}`, name_en: `Acc ${code}`, name_ar: `ح ${code}`, account_type: type });
      accounts.push(r.json?.id);
    }
    b['account'] = accounts[0]!;
    r = await B.req('POST', '/journals', { fiscal_year_id: b['fy'], accounting_date: '2026-03-10', description: 'JE B' });
    b['journal'] = r.json?.id ?? r.json?.journal?.id;
    await B.req('PUT', `/journals/${b['journal']}/lines`, { lines: [
      { account_id: accounts[0], debit: '100.00', credit: '0.00' },
      { account_id: accounts[1], debit: '0.00', credit: '100.00' },
    ] });
    r = await B.req('POST', '/documents', PNG, { 'content-type': 'image/png', 'x-file-name': 'b-secret.png' });
    b['document'] = r.json?.document?.id;
    r = await B.req('POST', '/bank-accounts', { display_name: 'Bank B', bank_name: 'X', currency_code: 'SAR' });
    b['bank'] = r.json?.account?.id;
    const csv = (tag: string) => Buffer.from(`Date,Description,Amount\n2026-02-01,TAMPER-${tag},1234.50\n`);
    for (const tag of ['ONE', 'TWO']) {
      r = await B.req('POST', '/bank-import-batches', csv(tag), { 'content-type': 'text/csv', 'x-file-name': `t-${tag}.csv`, 'x-bank-account-id': b['bank']! });
      b[`batch${tag}`] = r.json?.batch?.id ?? r.json?.id;
    }
    await B.req('POST', `/bank-import-batches/${b['batchONE']}/confirm`, {});
    b['bankTxn'] = (await pool.query('SELECT id FROM bank_transactions WHERE company_id = $1 LIMIT 1', [ids.coB])).rows[0]?.id;
    r = await B.req('POST', '/partners', { name: 'Partner B' });
    b['partner'] = r.json?.id;
    r = await B.req('POST', '/counterparties', { name: 'CP B', type: 'supplier' });
    b['counterparty'] = r.json?.id;

    b['monthlyClose'] = (await pool.query('SELECT id FROM monthly_close_periods WHERE company_id = $1 ORDER BY period_start LIMIT 1', [ids.coB])).rows[0]?.id;
    b['membership'] = (await pool.query('SELECT id FROM memberships WHERE company_id = $1 AND user_id = $2', [ids.coB, ids.userB])).rows[0]?.id;
    const roles = (await pool.query('SELECT id, name, is_full_access FROM roles WHERE company_id = $1', [ids.coB])).rows;
    b['roleFull'] = roles.find((x: { is_full_access: boolean }) => x.is_full_access)?.id;
    b['roleViewer'] = roles.find((x: { name: string }) => x.name === 'Viewer')?.id;
    b['vatPeriod'] = (await pool.query(
      `INSERT INTO vat_periods (company_id, fiscal_year_id, period_start, period_end, status)
       VALUES ($1, $2, '2026-01-01', '2026-03-31', 'open') RETURNING id`, [ids.coB, b['fy']])).rows[0].id;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    fs.rmSync(storageRoot, { recursive: true, force: true });
    if (pool && ids.coA) {
      for (const companyId of [ids.coA, ids.coB]) await pool.query('DELETE FROM companies WHERE id = $1', [companyId]).catch(() => undefined);
    }
  });

  it('seeded every company B resource the attempts target (guards against a vacuous run)', () => {
    for (const key of ['fy', 'account', 'journal', 'document', 'bank', 'batchONE', 'batchTWO', 'bankTxn', 'partner', 'counterparty', 'monthlyClose', 'membership', 'roleFull', 'roleViewer', 'vatPeriod']) {
      expect(String(b[key]), key).toMatch(UUID_RE);
    }
  });

  it('control: A is a Full Access user in its own company (so refusals below are about tenancy, not missing capabilities)', async () => {
    const own = await A.req('POST', '/accounts', { code: `OWN-${run}`, name_en: 'own', name_ar: 'م', account_type: 'asset' });
    expect(own.status).toBe(201);
    expect((await A.req('GET', '/access/roles')).status).toBe(200);
  });

  const attempts = (): Array<[string, string, unknown, Record<string, string>?]> => [
    ['PATCH', `/fiscal-years/${b['fy']}`, { name: 'hacked' }],
    ['POST', `/fiscal-years/${b['fy']}/close`, {}],
    ['PATCH', `/accounts/${b['account']}`, { name_en: 'hacked' }],
    ['PATCH', `/accounts/${b['account']}/classification`, { statement_category: 'current_asset', is_contra: false, cash_role: 'non_cash', cash_flow_category: 'operating' }],
    ['PATCH', `/journals/${b['journal']}`, { description: 'hacked' }],
    ['POST', `/journals/${b['journal']}/post`, {}],
    ['POST', `/monthly-close-periods/${b['monthlyClose']}/close`, {}],
    ['POST', `/monthly-close-periods/${b['monthlyClose']}/reopen`, { reason: 'tamper' }],
    ['POST', `/vat-periods/${b['vatPeriod']}/close`, {}],
    ['POST', `/vat-periods/${b['vatPeriod']}/reopen`, { reason: 'tamper' }],
    ['PUT', `/documents/${b['document']}/vat-review`, { tax_date: '2026-03-10', review_status: 'reviewed', treatment: 'standard', taxable_amount: '100.00', vat_amount: '15.00' }],
    ['POST', `/documents/${b['document']}/submit-review`, {}],
    ['POST', `/documents/${b['document']}/settlements`, { bank_transaction_id: b['bankTxn'], amount: '1.00' }],
    ['PATCH', `/bank-import-batches/${b['batchTWO']}/mapping`, { amount_mode: 'signed', date_format: 'YYYY-MM-DD', transaction_date: { index: 0 }, amount: { index: 2 }, description: { index: 1 } }],
    ['POST', `/bank-import-batches/${b['batchTWO']}/confirm`, {}],
    ['POST', `/bank-transactions/${b['bankTxn']}/reconciliation`, { status: 'reconciled' }],
    ['POST', `/bank-transactions/${b['bankTxn']}/match`, { document_id: b['document'] }],
    ['DELETE', `/bank-transactions/${b['bankTxn']}/match`, undefined],
    ['POST', `/partners/${b['partner']}/ownership`, { ownership_percentage: '50', effective_from: '2026-01-01', verification_status: 'unconfirmed' }],
    ['POST', `/opening-balances/${b['fy']}/items`, { category: 'other_asset', account_id: b['account'], amount: '1.00', balance_side: 'debit', source_type: 'manual_unverified', confidence: 'low' }],
    ['POST', `/opening-balances/${b['fy']}/submit-review`, {}],
    ['POST', `/tax-working-papers/${b['fy']}`, {}],
    ['POST', `/wht-reviews/${b['fy']}`, { source_type: 'document', source_id: b['document'], non_resident_assessment: 'unknown', payment_service_category: 'consulting', basis_reference: 'tamper probe', professional_review_required: false }],
    ['POST', `/annual-closing/${b['fy']}/package`, {}],
    ['PATCH', `/access/memberships/${b['membership']}/active`, { is_active: false }],
    ['PUT', `/access/memberships/${b['membership']}/role`, { role_id: b['roleViewer'] }],
    ['PUT', `/access/roles/${b['roleViewer']}/capabilities/journal.view`, undefined],
    ['DELETE', `/access/roles/${b['roleViewer']}/capabilities/journal.view`, undefined],
    ['POST', `/access/roles/${b['roleViewer']}/capabilities/bulk`, { grants: ['journal.view'] }],
    ['PUT', `/access/memberships/${b['membership']}/role`, { role_id: b['roleFull'] }],
  ];

  it('A replaying mutations with company B ids is refused and B data is unchanged', async () => {
    const before = await snapshotB();
    for (const [method, url, body, extra] of attempts()) {
      const res = await A.req(method, url, body, extra);
      expect(res.status, `${method} ${url}: ${res.text.slice(0, 160)}`).toBeLessThan(500);
      // 404 (hidden) or 403 (forbidden) only: a 400/409 would mean the request was rejected on its shape or state, proving nothing about tenancy.
      // WHT reviews answer a foreign fiscal year / source with this explicit tenancy message (400); any other 400 is a shape error.
      const tenancyRefusal = res.status === 400 && res.text.includes('Invalid company source or fiscal year');
      if (!tenancyRefusal) expect([403, 404], `${method} ${url}: ${res.text.slice(0, 160)}`).toContain(res.status);
    }
    expect(await snapshotB()).toEqual(before);
  });

  it('body-supplied company ids never redirect a write to company B', async () => {
    const before = await snapshotB();
    for (const [method, url, body] of [
      ['POST', '/accounts', { code: `X-${run}`, name_en: 'x', name_ar: 'س', account_type: 'asset', company_id: ids.coB }],
      ['POST', '/partners', { name: `PX-${run}`, company_id: ids.coB }],
      ['POST', '/counterparties', { name: `CX-${run}`, type: 'supplier', company_id: ids.coB }],
      ['POST', '/fiscal-years', { name: 'FY X', start_date: '2027-01-01', end_date: '2027-12-31', company_id: ids.coB }],
    ] as const) {
      const res = await A.req(method, url, body);
      expect(res.status, `${method} ${url}`).toBeLessThan(500);
    }
    expect(await snapshotB()).toEqual(before);
    const stray = await pool.query(`SELECT count(*)::int AS n FROM accounts WHERE code = $1 AND company_id = $2`, [`X-${run}`, ids.coB]);
    expect(stray.rows[0].n).toBe(0);
  });

  it('switch-company to a company A does not belong to is refused and the session keeps its company', async () => {
    const res = await A.req('POST', '/auth/switch-company', { companyId: ids.coB });
    expect(res.status).toBe(403);
    expect((await A.req('GET', '/auth/session')).json?.activeCompanyId).toBe(ids.coA);
  });

  it('control: the same B session CAN mutate B (the refusals above are not a broken route)', async () => {
    expect((await B.req('PATCH', `/fiscal-years/${b['fy']}`, { name: 'FY B renamed' })).status).toBe(200);
  });

  it('unknown ids on the same routes behave like another tenant\'s ids (no existence oracle)', async () => {
    const cross = await A.req('PATCH', `/accounts/${b['account']}`, { name_en: 'x' });
    const unknown = await A.req('PATCH', `/accounts/${MISSING}`, { name_en: 'x' });
    expect(cross.status).toBe(unknown.status);
  });
});
