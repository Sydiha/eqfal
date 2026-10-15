import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';

// Shared harness for real-HTTP + PostgreSQL suites (disposable DATABASE_URL only). Users log in through the real auth routes.
export const PASSWORD = 'Year-End-1!';

export async function startHarness() {
  const { default: pool } = await import('../../src/db/pool');
  const { default: app } = await import('../../src/app');
  const { CompanyManagementService } = await import('../../src/modules/companies/company.service');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const run = randomUUID().slice(0, 8);
  const hash = await bcrypt.hash(PASSWORD, 4);
  const db = pool as Pool;
  const q = async <T = Record<string, any>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];

  class Client {
    cookie = '';
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
    async login() { const r = await this.req('POST', '/auth/login', { email: this.email, password: PASSWORD }); if (r.status !== 200) throw new Error(`login failed: ${r.status}`); }
  }

  async function user(label: string) {
    const email = `ye-${label}-${run}@example.test`;
    const id = (await q<{ id: string }>('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email, hash]))[0]!.id;
    const client = new Client(email);
    return { id, email, client };
  }
  /** Company whose creator becomes its Full Access member (existing behaviour of company creation). */
  async function company(label: string, owner: string) {
    return (await new CompanyManagementService(db).create({ slug: `ye-${label}-${run}`, name: `YE-${label}-${run}`, name_ar: null }, owner)).id;
  }
  async function member(companyId: string, userId: string, caps: string[]) {
    const roleId = (await q<{ id: string }>('INSERT INTO roles(company_id,name) VALUES($1,$2) RETURNING id', [companyId, `r-${randomUUID().slice(0, 6)}`]))[0]!.id;
    for (const c of caps) await q('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [roleId, c]);
    await q('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [userId, companyId, roleId]);
  }
  async function account(companyId: string, code: string, type: string, category = 'unmapped') {
    return (await q<{ id: string }>('INSERT INTO accounts(company_id,code,name,account_type,statement_category) VALUES($1,$2,$2,$3,$4) RETURNING id', [companyId, code, type, category]))[0]!.id;
  }
  async function fiscalYear(companyId: string, name: string, start: string, end: string, status = 'open') {
    return (await q<{ id: string }>('INSERT INTO fiscal_years(company_id,name,start_date,end_date,status) VALUES($1,$2,$3,$4,$5) RETURNING id', [companyId, name, start, end, status]))[0]!.id;
  }
  /** Fixture journal inserted as draft then marked posted (bypasses service guards on purpose; the system under test is what is exercised afterwards). */
  async function postedJournal(companyId: string, fy: string, date: string, creator: string, lines: Array<[string, string, string]>, extra: { source_type?: string; source_id?: string; entry_type?: string; memo?: string } = {}) {
    const id = (await q<{ id: string }>(
      `INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,entry_type,source_type,source_id,created_by) VALUES($1,$2,$3,'fixture',$4,$5,$6,$7) RETURNING id`,
      [companyId, fy, date, extra.entry_type ?? 'standard', extra.source_type ?? null, extra.source_id ?? null, creator]))[0]!.id;
    let seq = 1;
    for (const [acc, debit, credit] of lines) await q('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,$4,$5,$6,$7)', [companyId, id, acc, debit, credit, extra.memo ?? null, seq++]);
    await q("UPDATE journal_entries SET status='posted',posted_by=$2,posted_at=NOW() WHERE id=$1", [id, creator]);
    return id;
  }
  const count = async (sql: string, p: unknown[] = []) => Number((await q<{ n: string }>(sql, p))[0]!.n);
  return { db, q, count, run, user, company, member, account, fiscalYear, postedJournal, close: () => server.close() };
}
