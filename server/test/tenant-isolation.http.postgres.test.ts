import bcrypt from 'bcrypt';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Storage directories are read when the app module loads, so point them at a throwaway folder first.
const databaseUrl = process.env['DATABASE_URL'];
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eqfal-tenant-'));
process.env['DOCUMENT_STORAGE_DIR'] = path.join(storageRoot, 'documents');
process.env['BANK_STORAGE_DIR'] = path.join(storageRoot, 'bank-imports');

const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Tenant-Isolation-1!';
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(64)]);

interface Res { status: number; json: any; text: string; headers: Headers }

describeDatabase('Tenant isolation over HTTP (two companies, two users, PostgreSQL)', () => {
  let pool: Pool;
  let server: http.Server;
  let base = '';
  const run = randomUUID().slice(0, 8);
  const ids = { userA: '', userB: '', coA: '', coB: '' };
  const seedA: Record<string, string> = {};
  const seedB: Record<string, string> = {};
  const markers = { name: `ISO-B-${run}` };

  class Client {
    cookie = '';
    constructor(private readonly email: string) {}
    async req(method: string, url: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
      const headers: Record<string, string> = { ...extra };
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
      try { json = JSON.parse(text); } catch { /* binary or empty body */ }
      return { status: res.status, json, text, headers: res.headers };
    }
    async login(): Promise<void> {
      const res = await this.req('POST', '/auth/login', { email: this.email, password: PASSWORD });
      if (res.status !== 200) throw new Error(`login failed for ${this.email}: ${res.status}`);
    }
  }
  let A: Client;
  let B: Client;

  const companyIdOf = (out: Record<string, string>): string => (out === seedA ? ids.coA : ids.coB);

  async function seed(client: Client, tag: string, out: Record<string, string>): Promise<void> {
    let r = await client.req('POST', '/fiscal-years', { name: `FY ${tag}`, start_date: '2026-01-01', end_date: '2026-12-31' });
    out['fy'] = r.json?.fiscalYear?.id;
    const accountIds: string[] = [];
    for (const [code, type] of [['1000', 'asset'], ['2000', 'liability'], ['4000', 'revenue']] as const) {
      r = await client.req('POST', '/accounts', { code: `${code}-${tag}`, name_en: `Acc ${code} ${tag}`, name_ar: `ح ${code}`, account_type: type });
      accountIds.push(r.json?.id);
    }
    out['accountDebit'] = accountIds[0]!;
    out['accountCredit'] = accountIds[2]!;
    r = await client.req('POST', '/journals', { fiscal_year_id: out['fy'], accounting_date: '2026-03-10', description: `JE ${tag}` });
    out['journal'] = r.json?.id ?? r.json?.journal?.id;
    await client.req('PUT', `/journals/${out['journal']}/lines`, { lines: [
      { account_id: accountIds[0], debit: '100.00', credit: '0.00' },
      { account_id: accountIds[2], debit: '0.00', credit: '100.00' },
    ] });
    r = await client.req('POST', '/counterparties', { name: `CP ${tag}`, type: 'supplier' });
    out['counterparty'] = r.json?.id;
    r = await client.req('POST', '/documents', PNG, { 'content-type': 'image/png', 'x-file-name': `secret-${tag}.png` });
    out['document'] = r.json?.document?.id;
    r = await client.req('POST', '/bank-accounts', { display_name: `Bank ${tag}`, bank_name: 'X', currency_code: 'SAR' });
    out['bank'] = r.json?.account?.id;
    r = await client.req('POST', '/obligations', { direction: 'payable', counterparty_id: out['counterparty'], original_amount: '250.00', recognized_on: '2026-02-01', verification_status: 'unconfirmed', source_type: 'manual', source_note: 'x' });
    out['obligation'] = r.json?.id;
    r = await client.req('POST', '/partners', { name: `Partner ${tag}` });
    out['partner'] = r.json?.id;
    // The API refuses VAT periods without an approved accounting profile; a plain fixture row is enough for isolation checks.
    await pool.query(
      `INSERT INTO company_accounting_profiles
         (company_id, version_no, workflow_status, accounting_framework, functional_currency, reporting_currency,
          first_live_accounting_date, vat_status, tax_treatment, ownership_context, wht_profile, has_non_resident_dealings,
          effective_from, prepared_by_user_id, reviewed_by_user_id, reviewed_at, approved_by_user_id, approved_at, change_reason)
       VALUES ($1, 1, 'approved', 'IFRS', 'SAR', 'SAR', '2026-01-01', 'not_registered', 'zakat_applicable',
               'saudi_gcc_only', 'not_currently_applicable', 'no', '2026-01-01', $2, $2, now(), $2, now(), 'test fixture')`,
      [companyIdOf(out), out === seedA ? ids.userA : ids.userB],
    );
    out['vatPeriod'] = (await pool.query(
      `INSERT INTO vat_periods (company_id, fiscal_year_id, period_start, period_end, status)
       VALUES ($1, $2, '2026-01-01', '2026-03-31', 'closed') RETURNING id`, [companyIdOf(out), out['fy']],
    )).rows[0].id;
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
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [`iso-${label}-${run}@example.test`, hash],
    )).rows[0].id;
    ids.userA = await mkUser('a');
    ids.userB = await mkUser('b');
    const service = new CompanyManagementService(pool);
    ids.coA = (await service.create({ slug: `iso-a-${run}`, name: `ISO-A-${run}`, name_ar: null }, ids.userA)).id;
    ids.coB = (await service.create({ slug: `iso-b-${run}`, name: markers.name, name_ar: null }, ids.userB)).id;

    A = new Client(`iso-a-${run}@example.test`);
    B = new Client(`iso-b-${run}@example.test`);
    await A.login();
    await B.login();
    await seed(A, `A${run}`, seedA);
    await seed(B, `B${run}`, seedB);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    fs.rmSync(storageRoot, { recursive: true, force: true });
    // Fixtures are scoped to the two unique companies/users created above; other suites are untouched.
    if (pool && ids.coA) {
      for (const companyId of [ids.coA, ids.coB]) {
        await pool.query('DELETE FROM companies WHERE id = $1', [companyId]).catch(() => undefined);
      }
    }
  });

  it('seeded every resource for both companies (guards against a vacuous run)', () => {
    for (const seeded of [seedA, seedB]) {
      for (const key of ['fy', 'accountDebit', 'journal', 'counterparty', 'document', 'bank', 'obligation', 'partner', 'vatPeriod']) {
        expect(String(seeded[key]), key).toMatch(/^[0-9a-f-]{36}$/);
      }
    }
    expect(seedA['document']).not.toBe(seedB['document']);
  });

  const detailRoutes = (s: Record<string, string>): string[] => [
    `/journals/${s['journal']}`,
    `/vat-periods/${s['vatPeriod']}`,
    `/vat-periods/${s['vatPeriod']}/report`,
  ];

  it('control: owner of B can read B detail routes the isolation checks target', async () => {
    const statuses: Array<[string, number]> = [];
    for (const url of detailRoutes(seedB)) statuses.push([url, (await B.req('GET', url)).status]);
    // Every route used by the isolation checks must work for its owner, otherwise a 404 for A proves nothing.
    expect(statuses.filter(([, status]) => status !== 200)).toEqual([]);
    expect((await B.req('GET', `/documents/${seedB['document']}/file`)).status).toBe(200);
  });

  it('cross-company READ: A cannot fetch any B resource by id', async () => {
    for (const url of detailRoutes(seedB)) {
      const res = await A.req('GET', url);
      expect(res.status, url).toBeGreaterThanOrEqual(400);
      expect(res.status, url).toBeLessThan(500);
      expect(res.text, url).not.toContain(markers.name);
      expect(res.text, url).not.toContain(seedB['journal']! + '"');
    }
  });

  it('list endpoints for A never contain B data', async () => {
    const lists = ['/journals', '/counterparties', '/documents', '/obligations', '/partners', '/accounts', '/bank-accounts', '/fiscal-years', '/vat-periods', '/audit-log'];
    for (const url of lists) {
      const res = await A.req('GET', url);
      expect(res.status, url).toBeLessThan(500);
      for (const needle of [`B${run}`, seedB['journal']!, seedB['document']!, seedB['counterparty']!, seedB['obligation']!, seedB['partner']!, seedB['bank']!, ids.coB]) {
        expect(res.text, `${url} leaked ${needle}`).not.toContain(needle);
      }
    }
    // Control: B's own list does show B's data.
    expect((await B.req('GET', '/counterparties')).text).toContain(seedB['counterparty']);
  });

  it('cross-company WRITE: A cannot modify or delete B resources, and B rows are unchanged', async () => {
    const before = await snapshotB();
    const attempts: Array<[string, string, unknown]> = [
      ['PATCH', `/partners/${seedB['partner']}`, { name: 'hacked', version: 1 }],
      ['PATCH', `/counterparties/${seedB['counterparty']}`, { name: 'hacked', version: 1 }],
      ['PATCH', `/obligations/${seedB['obligation']}`, { original_amount: '1.00', version: 1 }],
      ['PATCH', `/documents/${seedB['document']}/intake`, { intake_note: 'hacked' }],
      ['POST', `/documents/${seedB['document']}/review`, { decision: 'approved' }],
      ['PUT', `/journals/${seedB['journal']}/lines`, { lines: [] }],
      ['PATCH', `/companies/${ids.coB}`, { name: 'HACKED' }],
      ['PATCH', `/companies/${ids.coB}/active`, { is_active: false }],
      ['DELETE', `/companies/${ids.coB}/logo`, undefined],
      ['PUT', `/companies/${ids.coB}/logo`, PNG],
    ];
    for (const [method, url, body] of attempts) {
      const extra = Buffer.isBuffer(body) ? { 'content-type': 'image/png' } : {};
      const res = await A.req(method, url, body, extra);
      expect(res.status, `${method} ${url}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${method} ${url}`).toBeLessThan(500);
    }
    expect(await snapshotB()).toEqual(before);
  });

  it('ID tampering: A cannot attach B ids or force a company_id on its own writes', async () => {
    // B's counterparty / accounts / fiscal year referenced from A's requests must be rejected.
    const ob = await A.req('POST', '/obligations', { direction: 'payable', counterparty_id: seedB['counterparty'], original_amount: '5.00', recognized_on: '2026-02-01', verification_status: 'unconfirmed', source_type: 'manual', source_note: 'x' });
    expect(ob.status).toBeGreaterThanOrEqual(400);
    expect(ob.status).toBeLessThan(500);

    const je = await A.req('POST', '/journals', { fiscal_year_id: seedB['fy'], accounting_date: '2026-03-11', description: 'tamper' });
    expect(je.status).toBeGreaterThanOrEqual(400);
    expect(je.status).toBeLessThan(500);

    const lines = await A.req('PUT', `/journals/${seedA['journal']}/lines`, { lines: [
      { account_id: seedB['accountDebit'], debit: '10.00', credit: '0.00' },
      { account_id: seedB['accountCredit'], debit: '0.00', credit: '10.00' },
    ] });
    expect(lines.status).toBeGreaterThanOrEqual(400);
    expect(lines.status).toBeLessThan(500);

    // Mass assignment: a body company_id is ignored; the row lands in A's company.
    const forced = await A.req('POST', '/accounts', { code: `MA-${run}`, name_en: 'mass', name_ar: 'م', account_type: 'asset', company_id: ids.coB });
    expect(forced.status).toBeLessThan(500);
    const { rows } = await pool.query('SELECT company_id FROM accounts WHERE code = $1', [`MA-${run}`]);
    expect(rows.every((row: { company_id: string }) => row.company_id === ids.coA)).toBe(true);

    // No journal line of A may reference a B account, and vice versa.
    const cross = await pool.query(
      `SELECT count(*)::int AS n FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         JOIN accounts ac ON ac.id = jl.account_id
        WHERE je.company_id <> ac.company_id`);
    expect(cross.rows[0].n).toBe(0);
  });

  it('FILE access: A cannot download B documents or logos, B still can', async () => {
    const stolen = await A.req('GET', `/documents/${seedB['document']}/file`);
    expect(stolen.status).toBe(404);
    expect(stolen.text).not.toContain('secret-B');
    expect((await A.req('GET', `/companies/${ids.coB}/logo`)).status).toBe(404);
    // A downloads only its own file, with its own bytes.
    const own = await A.req('GET', `/documents/${seedA['document']}/file`);
    expect(own.status).toBe(200);
    expect(own.headers.get('content-disposition') ?? '').toContain(`secret-A${run}`);
    expect((await B.req('GET', `/documents/${seedB['document']}/file`)).status).toBe(200);
    // Malformed ids never reach the filesystem.
    for (const bad of ['not-a-uuid', '..%2F..%2Fetc%2Fpasswd']) {
      // Known low-severity issue L1 (security audit): malformed ids currently answer 500, not 4xx.
      // Out of scope here; what matters for isolation is that no file is ever served.
      const res = await A.req('GET', `/documents/${bad}/file`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get('content-type') ?? '').not.toMatch(/image|pdf/);
    }
  });

  it('EXPORT paths: A cannot export B data (VAT working paper, annual package, bank import preview)', async () => {
    const own = await A.req('GET', `/vat-periods/${seedA['vatPeriod']}/working-paper.xlsx`);
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type') ?? '').toContain('spreadsheetml');

    const xlsx = await A.req('GET', `/vat-periods/${seedB['vatPeriod']}/working-paper.xlsx`);
    expect(xlsx.status).toBeGreaterThanOrEqual(400);
    expect(xlsx.status).toBeLessThan(500);
    expect(xlsx.headers.get('content-type') ?? '').not.toContain('spreadsheetml');

    const pkg = await A.req('GET', `/annual-closing/${seedB['fy']}/package`);
    expect(pkg.status).toBeGreaterThanOrEqual(400);
    expect(pkg.status).toBeLessThan(500);
    expect(pkg.text).not.toContain(markers.name);

    const preview = await A.req('GET', `/bank-import-batches/${randomUUID()}/preview`);
    expect(preview.status).toBeGreaterThanOrEqual(400);
    expect(preview.status).toBeLessThan(500);
  });

  it('unauthenticated callers get 401 on the same read, file and export routes', async () => {
    const anon = new Client('anonymous');
    for (const url of [`/documents/${seedB['document']}/file`, `/vat-periods/${seedB['vatPeriod']}/working-paper.xlsx`, '/journals']) {
      expect((await anon.req('GET', url)).status, url).toBe(401);
    }
  });

  async function snapshotB(): Promise<unknown> {
    const companies = await pool.query('SELECT name, is_active FROM companies WHERE id = $1', [ids.coB]);
    const partner = await pool.query('SELECT name, version FROM partners WHERE id = $1', [seedB['partner']]);
    const cp = await pool.query('SELECT name, version FROM counterparties WHERE id = $1', [seedB['counterparty']]);
    const ob = await pool.query('SELECT original_amount::text, version FROM obligations WHERE id = $1', [seedB['obligation']]);
    const doc = await pool.query('SELECT status, reviewed_by_user_id FROM documents WHERE id = $1', [seedB['document']]);
    const lines = await pool.query('SELECT count(*)::int AS n FROM journal_lines WHERE journal_entry_id = $1', [seedB['journal']]);
    const logo = await pool.query('SELECT count(*)::int AS n FROM company_logos WHERE company_id = $1', [ids.coB]);
    return [companies.rows, partner.rows, cp.rows, ob.rows, doc.rows, lines.rows, logo.rows];
  }
});
