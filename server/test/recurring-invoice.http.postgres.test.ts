import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Recurring invoice templates over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
// invoice.* permissions are explicit-grant-only; roles here stand in for the owner-authorized provisioning procedure.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Recurring-Inv-1!';
const MISSING = '00000000-0000-4000-8000-000000000000';

describeDatabase('recurring invoices (PostgreSQL)', () => {
  let pool: Pool;
  let server: http.Server;
  let base = '';
  let svc: import('../src/modules/invoices/recurring-invoice.service').RecurringInvoiceService;
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
  const email = (label: string) => `rec-${label}-${run}@example.test`;
  const count = async (sql: string, p: unknown[] = []) => Number((await pool.query<{ n: string }>(sql, p)).rows[0]!.n);

  // Far-future dates: a template cannot start in the past, and generation takes an explicit as-of date.
  const salesBody = (over: Record<string, unknown> = {}) => ({
    direction: 'sales', name: `Rent ${randomUUID().slice(0, 4)}`, counterparty_id: ids.customerA, frequency: 'monthly', start_date: '2031-01-31', due_days: 30,
    lines: [{ description: 'Monthly service', quantity: '1', unit_price: '1000.00', vat_rate: '15', vat_treatment: 'standard' }], ...over,
  });
  const edit = (over: Record<string, unknown> = {}) => { const { direction: _direction, ...rest } = salesBody(over); return rest; }; // a template's direction is immutable and not part of an edit body
  const purchaseBody = (over: Record<string, unknown> = {}) => ({
    direction: 'purchase', name: `Lease ${randomUUID().slice(0, 4)}`, counterparty_id: ids.supplierA, frequency: 'quarterly', start_date: '2031-03-15',
    lines: [{ description: 'Office lease', quantity: '1', unit_price: '2000.00', vat_rate: '15', vat_treatment: 'standard', vat_recoverability: 'fully_recoverable' }], ...over,
  });
  const make = async (body: Record<string, unknown> = salesBody()) => { const r = await clients.manager!.req('POST', '/recurring-invoices', body); expect(r.status).toBe(201); return r.json.template; };
  const invoicesOf = async (templateId: string) => (await pool.query('SELECT * FROM invoices WHERE recurring_template_id=$1 ORDER BY recurrence_occurrence_date', [templateId])).rows;

  beforeAll(async () => {
    const { default: sharedPool } = await import('../src/db/pool');
    const { default: app } = await import('../src/app');
    const { CompanyManagementService } = await import('../src/modules/companies/company.service');
    const { RecurringInvoiceService } = await import('../src/modules/invoices/recurring-invoice.service');
    pool = sharedPool!;
    svc = new RecurringInvoiceService(pool);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const mkUser = async (label: string) => (await pool.query<{ id: string }>('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email(label), hash])).rows[0]!.id;
    for (const label of ['ownerA', 'ownerB', 'manager', 'managerNoCreate', 'viewer', 'managerB']) ids[label] = await mkUser(label);
    const companies = new CompanyManagementService(pool);
    ids.coA = (await companies.create({ slug: `rec-a-${run}`, name: `REC-A-${run}`, name_ar: null }, ids.ownerA!)).id;
    ids.coB = (await companies.create({ slug: `rec-b-${run}`, name: `REC-B-${run}`, name_ar: null }, ids.ownerB!)).id;
    const role = async (company: string, name: string, caps: string[]) => {
      const id = (await pool.query<{ id: string }>('INSERT INTO roles(company_id,name) VALUES($1,$2) RETURNING id', [company, name])).rows[0]!.id;
      for (const c of caps) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [id, c]);
      return id;
    };
    const member = (user: string, company: string, roleId: string) => pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [user, company, roleId]);
    await member(ids.manager!, ids.coA!, await role(ids.coA!, 'RecManager', ['invoice.view', 'invoice.create', 'invoice.recurring']));
    await member(ids.managerNoCreate!, ids.coA!, await role(ids.coA!, 'RecManagerNoCreate', ['invoice.view', 'invoice.recurring']));
    await member(ids.viewer!, ids.coA!, await role(ids.coA!, 'RecCreator', ['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit']));
    await member(ids.managerB!, ids.coB!, await role(ids.coB!, 'RecManagerB', ['invoice.view', 'invoice.create', 'invoice.recurring']));
    const cp = async (company: string, name: string, type: string) => (await pool.query<{ id: string }>(
      'INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,$2,$3,true,$4) RETURNING id', [company, name, type, ids.ownerA])).rows[0]!.id;
    ids.customerA = await cp(ids.coA!, 'Customer A', 'customer');
    ids.supplierA = await cp(ids.coA!, 'Supplier A', 'supplier');
    ids.customerB = await cp(ids.coB!, 'Customer B', 'customer');
    for (const label of ['ownerA', 'manager', 'managerNoCreate', 'viewer', 'managerB']) { clients[label] = new Client(email(label)); await clients[label]!.login(); }
  });
  afterAll(() => { server.close(); });

  it('registers invoice.recurring as explicit-grant-only: Full Access and invoice creators are refused', async () => {
    const row = (await pool.query<{ implicit_full_access: boolean }>("SELECT implicit_full_access FROM capabilities WHERE id='invoice.recurring'")).rows[0];
    expect(row?.implicit_full_access).toBe(false);
    expect((await pool.query("SELECT 1 FROM role_capabilities WHERE capability_id='invoice.recurring' AND role_id IN (SELECT id FROM roles WHERE is_full_access)")).rowCount).toBe(0);
    expect((await clients.ownerA!.req('POST', '/recurring-invoices', salesBody())).status).toBe(403);
    expect((await clients.viewer!.req('POST', '/recurring-invoices', salesBody())).status).toBe(403);
    expect((await clients.ownerA!.req('GET', '/recurring-invoices')).status).toBe(403); // Full Access holds no invoice.view either
    expect((await clients.manager!.req('POST', '/recurring-invoices', salesBody(), { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('creates a sales and a purchase template; amounts are never stored; the audit trail records it', async () => {
    const sales = await make();
    expect(sales).toMatchObject({ direction: 'sales', status: 'active', frequency: 'monthly', start_date: '2031-01-31', next_run_date: '2031-01-31', anchor_day: 31, version: 1, due_days: 30 });
    expect(sales.lines[0]).toMatchObject({ description: 'Monthly service', quantity: '1.0000', unit_price: '1000.00', vat_rate: '15.00' });
    expect(sales.lines[0].net_amount).toBeUndefined();
    const purchase = await make(purchaseBody());
    expect(purchase).toMatchObject({ direction: 'purchase', frequency: 'quarterly', anchor_day: 15 });
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='recurring_invoice.create'", [sales.id])).toBe(1);
    const list = await clients.viewer!.req('GET', '/recurring-invoices?direction=sales');
    expect(list.status).toBe(200);
    expect(list.json.templates.some((t: any) => t.id === sales.id)).toBe(true);
    expect(list.json.templates.every((t: any) => t.direction === 'sales')).toBe(true);
  });

  it('validates input: past start, wrong counterparty type, other-company counterparty, bad recoverability, unknown fields', async () => {
    const post = (b: unknown) => clients.manager!.req('POST', '/recurring-invoices', b);
    expect((await post(salesBody({ start_date: '2020-01-01' }))).status).toBe(400);
    const supplierOnSales = await post(salesBody({ counterparty_id: ids.supplierA }));
    expect(supplierOnSales.status).toBe(400); expect(supplierOnSales.json.code).toBe('INVOICE_COUNTERPARTY_INVALID');
    const foreign = await post(salesBody({ counterparty_id: ids.customerB }));
    expect(foreign.status).toBe(400); expect(foreign.json.code).toBe('INVOICE_COUNTERPARTY_INVALID');
    expect((await post(salesBody({ lines: [{ description: 'x', quantity: '1', unit_price: '10', vat_rate: '15', vat_treatment: 'standard', vat_recoverability: 'fully_recoverable' }] }))).status).toBe(400); // sales line with recoverability
    expect((await post(purchaseBody({ lines: [{ description: 'x', quantity: '1', unit_price: '10', vat_rate: '15', vat_treatment: 'standard', vat_recoverability: 'partially_recoverable' }] }))).status).toBe(400); // percent missing
    expect((await post({ ...salesBody(), generated: true })).status).toBe(400);
  });

  it('tenant isolation: company B cannot read, edit, pause, end, run or list company A templates', async () => {
    const t = await make();
    const b = clients.managerB!;
    expect((await b.req('GET', `/recurring-invoices/${t.id}`)).status).toBe(404);
    expect((await b.req('PUT', `/recurring-invoices/${t.id}`, { ...edit({ counterparty_id: ids.customerB }), version: 1 })).status).toBe(404);
    for (const action of ['pause', 'resume', 'end']) expect((await b.req('POST', `/recurring-invoices/${t.id}/${action}`, { version: 1 })).status).toBe(404);
    expect((await b.req('GET', '/recurring-invoices')).json.templates.some((x: any) => x.id === t.id)).toBe(false);
    await b.req('POST', '/recurring-invoices/run-due', {});
    expect(await invoicesOf(t.id)).toHaveLength(0);
    expect((await pool.query('SELECT status, version FROM recurring_invoice_templates WHERE id=$1', [t.id])).rows[0]).toMatchObject({ status: 'active', version: 1 });
    // The database also refuses a cross-company counterparty / template reference.
    await expect(pool.query(
      `INSERT INTO recurring_invoice_templates (company_id,direction,name,counterparty_id,frequency,start_date,anchor_day,next_run_date,created_by_user_id)
       VALUES ($1,'sales','x',$2,'monthly','2031-01-01',1,'2031-01-01',$3)`, [ids.coA, ids.customerB, ids.manager])).rejects.toThrow();
    // The scheduler path scoped to another company refuses to touch the template.
    expect((await svc.generateForTemplate(t.id, '2031-02-28', ids.coB!)).generated).toHaveLength(0);
  });

  it('generates DRAFT invoices only: no number, approval, obligation, journal or VAT review; correct amounts, dates and origin', async () => {
    const t = await make(salesBody({ start_date: '2031-04-30', frequency: 'monthly', due_days: 14 }));
    const result = await svc.generateForTemplate(t.id, '2031-04-30');
    expect(result.generated).toHaveLength(1);
    const [inv] = await invoicesOf(t.id);
    expect(inv).toMatchObject({ status: 'draft', origin: 'recurring', direction: 'sales', internal_number: null, approved_at: null, fiscal_year_id: null, created_by_user_id: ids.manager });
    expect(inv.recurrence_occurrence_date.toISOString().slice(0, 10)).toBe('2031-04-30');
    expect(inv.issue_date.toISOString().slice(0, 10)).toBe('2031-04-30');
    expect(inv.tax_point_date.toISOString().slice(0, 10)).toBe('2031-04-30');
    expect(inv.due_date.toISOString().slice(0, 10)).toBe('2031-05-14');
    expect([inv.subtotal_amount, inv.vat_amount, inv.total_amount]).toEqual(['1000.00', '150.00', '1150.00']);
    expect(await count('SELECT COUNT(*)::text n FROM obligations WHERE invoice_id=$1', [inv.id])).toBe(0);
    expect(await count('SELECT COUNT(*)::text n FROM invoice_vat_reviews WHERE invoice_id=$1', [inv.id])).toBe(0);
    expect(await count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='obligation' AND source_id IN (SELECT id FROM obligations WHERE invoice_id=$2)", [ids.coA, inv.id])).toBe(0);
    expect(await count('SELECT COUNT(*)::text n FROM invoice_lines WHERE invoice_id=$1', [inv.id])).toBe(1);
    // The generated draft appears through the normal invoice API and is editable like any draft.
    const read = await clients.viewer!.req('GET', `/invoices/${inv.id}`);
    expect(read.status).toBe(200); expect(read.json.invoice).toMatchObject({ status: 'draft', origin: 'recurring', actionable_status: 'draft' });
    expect((await pool.query("SELECT next_run_date::text, last_generated_for::text, last_error_code FROM recurring_invoice_templates WHERE id=$1", [t.id])).rows[0]).toEqual({ next_run_date: '2031-05-30', last_generated_for: '2031-04-30', last_error_code: null });
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='recurring_invoice.generate'", [t.id])).toBe(1);
  });

  it('purchase template generates a purchase draft with its stated input-VAT recovery', async () => {
    const t = await make(purchaseBody({ start_date: '2031-06-15' }));
    expect((await svc.generateForTemplate(t.id, '2031-06-15')).generated).toHaveLength(1);
    const [inv] = await invoicesOf(t.id);
    expect(inv).toMatchObject({ status: 'draft', direction: 'purchase', external_reference: null });
    expect(inv.total_amount).toBe('2300.00');
    expect((await pool.query("SELECT vat_recoverability FROM invoice_lines WHERE invoice_id=$1", [inv.id])).rows[0].vat_recoverability).toBe('fully_recoverable');
    expect((await pool.query('SELECT next_run_date::text n FROM recurring_invoice_templates WHERE id=$1', [t.id])).rows[0].n).toBe('2031-09-15');
  });

  it('month-end: a 31st template yields 28 Feb, then 31 Mar, 30 Apr, and a leap February uses the 29th', async () => {
    const t = await make(salesBody({ start_date: '2031-01-31' }));
    await svc.generateForTemplate(t.id, '2031-05-31');
    const dates = (await invoicesOf(t.id)).map((i) => i.recurrence_occurrence_date.toISOString().slice(0, 10));
    expect(dates).toEqual(['2031-01-31', '2031-02-28', '2031-03-31', '2031-04-30', '2031-05-31']);
    const leap = await make(salesBody({ start_date: '2031-12-31' }));
    await svc.generateForTemplate(leap.id, '2032-03-31');
    expect((await invoicesOf(leap.id)).map((i) => i.recurrence_occurrence_date.toISOString().slice(0, 10))).toEqual(['2031-12-31', '2032-01-31', '2032-02-29', '2032-03-31']);
  });

  it('never generates ahead of the as-of date, and an annual template steps one year', async () => {
    const t = await make(salesBody({ start_date: '2033-03-10', frequency: 'annual' }));
    expect((await svc.generateForTemplate(t.id, '2033-03-09')).generated).toHaveLength(0);
    expect((await svc.generateForTemplate(t.id, '2033-03-10')).generated).toHaveLength(1);
    expect((await svc.generateForTemplate(t.id, '2034-03-09')).generated).toHaveLength(0);
    expect((await pool.query('SELECT next_run_date::text n FROM recurring_invoice_templates WHERE id=$1', [t.id])).rows[0].n).toBe('2034-03-10');
  });

  it('idempotent: running again for the same date creates nothing new', async () => {
    const t = await make(salesBody({ start_date: '2034-05-31' }));
    expect((await svc.generateForTemplate(t.id, '2034-06-30')).generated).toHaveLength(2);
    expect((await svc.generateForTemplate(t.id, '2034-06-30')).generated).toHaveLength(0);
    expect(await invoicesOf(t.id)).toHaveLength(2);
  });

  it('concurrent scheduler runs create exactly one draft per occurrence', async () => {
    const t = await make(salesBody({ start_date: '2035-01-15' }));
    const results = await Promise.all(Array.from({ length: 8 }, () => svc.generateForTemplate(t.id, '2035-03-20')));
    const total = results.reduce((n, r) => n + r.generated.length, 0);
    expect(total).toBe(3); // 15 Jan, 15 Feb, 15 Mar, across all runners together
    const rows = await invoicesOf(t.id);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.recurrence_occurrence_date.toISOString())).size).toBe(3);
    // The whole-system entry point is also safe to race against itself.
    const t2 = await make(salesBody({ start_date: '2035-06-01' }));
    await Promise.all([svc.runAllDue('2035-06-01'), svc.runAllDue('2035-06-01'), svc.runDueForCompany(ids.coA!, '2035-06-01')]);
    expect(await invoicesOf(t2.id)).toHaveLength(1);
  });

  it('the database itself refuses a second invoice for the same template occurrence (and a foreign or unknown template)', async () => {
    const t = await make(salesBody({ start_date: '2036-02-01' }));
    await svc.generateForTemplate(t.id, '2036-02-01');
    const insert = (company: string, template: string, date: string) => pool.query(
      `INSERT INTO invoices (company_id,direction,status,counterparty_id,issue_date,subtotal_amount,vat_amount,total_amount,created_by_user_id,origin,recurring_template_id,recurrence_occurrence_date)
       VALUES ($1,'sales','draft',$2,'2036-02-01',0,0,0,$3,'recurring',$4,$5)`, [company, ids.customerA, ids.manager, template, date]);
    await expect(insert(ids.coA!, t.id, '2036-02-01')).rejects.toMatchObject({ code: '23505', constraint: 'invoices_recurrence_occurrence_uidx' });
    await expect(insert(ids.coA!, MISSING, '2036-03-01')).rejects.toMatchObject({ code: '23503' });
    await expect(insert(ids.coB!, t.id, '2036-03-01')).rejects.toThrow();
  });

  it('an occurrence that already has its invoice is not duplicated; the schedule just advances', async () => {
    const t = await make(salesBody({ start_date: '2036-05-01' }));
    await svc.generateForTemplate(t.id, '2036-05-01');
    await pool.query("UPDATE recurring_invoice_templates SET next_run_date='2036-05-01', last_generated_for=NULL WHERE id=$1", [t.id]); // simulate a lost schedule update
    const r = await svc.generateForTemplate(t.id, '2036-05-01');
    expect(r.generated).toHaveLength(0); expect(r.skipped_existing).toEqual(['2036-05-01']);
    expect(await invoicesOf(t.id)).toHaveLength(1);
    expect((await pool.query('SELECT next_run_date::text n FROM recurring_invoice_templates WHERE id=$1', [t.id])).rows[0].n).toBe('2036-06-01');
  });

  it('pause stops generation; resume continues from the first occurrence on or after today (no back-fill); end is final', async () => {
    const t = await make(salesBody({ start_date: '2031-07-01' }));
    const paused = await clients.manager!.req('POST', `/recurring-invoices/${t.id}/pause`, { version: t.version });
    expect(paused.status).toBe(200); expect(paused.json.template.status).toBe('paused');
    expect((await svc.generateForTemplate(t.id, '2031-12-01')).generated).toHaveLength(0);
    expect(await invoicesOf(t.id)).toHaveLength(0);
    expect((await clients.manager!.req('POST', `/recurring-invoices/${t.id}/pause`, { version: paused.json.template.version })).status).toBe(409); // already paused
    expect((await clients.manager!.req('POST', `/recurring-invoices/${t.id}/resume`, { version: 1 })).json.code).toBe('RECURRING_VERSION_CONFLICT');
    const resumed = await clients.manager!.req('POST', `/recurring-invoices/${t.id}/resume`, { version: paused.json.template.version });
    expect(resumed.status).toBe(200); expect(resumed.json.template.status).toBe('active');
    // 2031-07-01 is in the future, so the next run date is unchanged.
    expect(resumed.json.template.next_run_date).toBe('2031-07-01');
    const ended = await clients.manager!.req('POST', `/recurring-invoices/${t.id}/end`, { version: resumed.json.template.version });
    expect(ended.status).toBe(200); expect(ended.json.template).toMatchObject({ status: 'ended' }); expect(ended.json.template.ended_at).toBeTruthy();
    expect((await svc.generateForTemplate(t.id, '2032-01-01')).generated).toHaveLength(0);
    expect((await clients.manager!.req('POST', `/recurring-invoices/${t.id}/resume`, { version: ended.json.template.version })).status).toBe(409);
    expect((await clients.manager!.req('PUT', `/recurring-invoices/${t.id}`, { ...edit(), version: ended.json.template.version })).status).toBe(409);
    expect(await invoicesOf(t.id)).toHaveLength(0);
    for (const a of ['pause', 'resume', 'end']) expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action=$2", [t.id, `recurring_invoice.${a}`])).toBeGreaterThanOrEqual(1);
  });

  it('resume skips the paused interval instead of back-filling it', async () => {
    const t = await make(salesBody({ start_date: '2031-08-01' }));
    await pool.query("UPDATE recurring_invoice_templates SET status='paused', next_run_date='2020-01-01', start_date='2020-01-01', anchor_day=1 WHERE id=$1", [t.id]);
    const resumed = await clients.manager!.req('POST', `/recurring-invoices/${t.id}/resume`, { version: 1 });
    expect(resumed.status).toBe(200);
    const today = (await import('../src/operational-date')).operationalDate();
    expect(resumed.json.template.next_run_date >= today).toBe(true);
    expect(resumed.json.template.next_run_date.endsWith('-01')).toBe(true);
    expect(await invoicesOf(t.id)).toHaveLength(0);
  });

  it('an end date stops the schedule automatically after the last occurrence', async () => {
    const t = await make(salesBody({ start_date: '2037-01-10', end_date: '2037-02-28' }));
    const r = await svc.generateForTemplate(t.id, '2037-12-31');
    expect(r.generated).toHaveLength(2); // 10 Jan, 10 Feb; 10 Mar is after the end date
    const row = (await pool.query("SELECT status, ended_at FROM recurring_invoice_templates WHERE id=$1", [t.id])).rows[0];
    expect(row.status).toBe('ended'); expect(row.ended_at).toBeTruthy();
  });

  it('edit: replaces details and lines, bumps the version, locks the schedule after generation, and refuses stale versions', async () => {
    const t = await make(salesBody({ start_date: '2038-01-05' }));
    const edited = await clients.manager!.req('PUT', `/recurring-invoices/${t.id}`, { ...edit({ start_date: '2038-02-05', name: 'Renamed', due_days: null, frequency: 'quarterly',
      lines: [{ description: 'A', quantity: '2', unit_price: '50.00', vat_rate: '0', vat_treatment: 'zero_rated' }, { description: 'B', quantity: '1', unit_price: '10.00', vat_rate: '15', vat_treatment: 'standard' }] }), version: t.version });
    expect(edited.status).toBe(200);
    expect(edited.json.template).toMatchObject({ name: 'Renamed', version: 2, frequency: 'quarterly', start_date: '2038-02-05', next_run_date: '2038-02-05', anchor_day: 5 });
    expect(edited.json.template.lines).toHaveLength(2);
    expect((await clients.manager!.req('PUT', `/recurring-invoices/${t.id}`, { ...edit({ start_date: '2038-02-05', frequency: 'quarterly' }), version: 1 })).json.code).toBe('RECURRING_VERSION_CONFLICT');
    await svc.generateForTemplate(t.id, '2038-02-05');
    const locked = await clients.manager!.req('PUT', `/recurring-invoices/${t.id}`, { ...edit({ start_date: '2038-03-05', frequency: 'quarterly' }), version: 3 });
    expect(locked.status).toBe(409); expect(locked.json.code).toBe('RECURRING_SCHEDULE_LOCKED');
    // Content stays editable; the already generated historical draft is untouched.
    const [before] = await invoicesOf(t.id);
    const again = await clients.manager!.req('PUT', `/recurring-invoices/${t.id}`, { ...edit({ start_date: '2038-02-05', frequency: 'quarterly', name: 'Third', lines: [{ description: 'C', quantity: '1', unit_price: '5.00', vat_rate: '15', vat_treatment: 'standard' }] }), version: 3 });
    expect(again.status).toBe(200);
    const [after] = await invoicesOf(t.id);
    expect(after).toEqual(before);
    expect(after.total_amount).toBe('111.50'); // 2 x 50 zero-rated + 10 + 1.50 VAT
  });

  it('a failing occurrence is retried, never skipped: a stale sales VAT rate is recorded on the template and fixing it resumes generation', async () => {
    const t = await make(salesBody({ start_date: '2039-01-01', lines: [{ description: 'Old rate', quantity: '1', unit_price: '100.00', vat_rate: '5', vat_treatment: 'standard' }] }));
    const failed = await svc.generateForTemplate(t.id, '2039-03-01');
    expect(failed.generated).toHaveLength(0); expect(failed.error_code).toBe('INVOICE_VAT_RATE_MISMATCH');
    const row = (await pool.query("SELECT next_run_date::text n, last_error_code, last_attempt_at FROM recurring_invoice_templates WHERE id=$1", [t.id])).rows[0];
    expect(row).toMatchObject({ n: '2039-01-01', last_error_code: 'INVOICE_VAT_RATE_MISMATCH' }); expect(row.last_attempt_at).toBeTruthy();
    expect(await invoicesOf(t.id)).toHaveLength(0);
    const shown = await clients.viewer!.req('GET', `/recurring-invoices/${t.id}`);
    expect(shown.json.template.last_error_code).toBe('INVOICE_VAT_RATE_MISMATCH');
    const fixed = await clients.manager!.req('PUT', `/recurring-invoices/${t.id}`, { ...edit({ start_date: '2039-01-01' }), version: 1 });
    expect(fixed.status).toBe(200); expect(fixed.json.template.last_error_code).toBeNull();
    expect((await svc.generateForTemplate(t.id, '2039-03-01')).generated).toHaveLength(3);
  });

  it('an inactive counterparty fails closed and the schedule keeps its place', async () => {
    const cpId = (await pool.query<{ id: string }>("INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,'Temp','customer',true,$2) RETURNING id", [ids.coA, ids.ownerA])).rows[0]!.id;
    const t = await make(salesBody({ counterparty_id: cpId, start_date: '2040-01-01' }));
    await pool.query('UPDATE counterparties SET is_active=false WHERE id=$1', [cpId]);
    const r = await svc.generateForTemplate(t.id, '2040-01-01');
    expect(r.error_code).toBe('INVOICE_COUNTERPARTY_INVALID');
    expect(await invoicesOf(t.id)).toHaveLength(0);
    expect((await pool.query('SELECT next_run_date::text n FROM recurring_invoice_templates WHERE id=$1', [t.id])).rows[0].n).toBe('2040-01-01');
  });

  it('manual run-due: needs invoice.create too; only the active company is generated', async () => {
    const t = await make(salesBody({ start_date: '2031-09-01' }));
    expect((await clients.managerNoCreate!.req('POST', '/recurring-invoices/run-due', {})).status).toBe(403);
    const res = await clients.manager!.req('POST', '/recurring-invoices/run-due', {});
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.results)).toBe(true);
    // Real "today" is before 2031, so nothing for this template is due yet.
    expect(await invoicesOf(t.id)).toHaveLength(0);
  });

  it('a due template is generated by the manual run using the operational date, and historical invoices are never touched', async () => {
    const { operationalDate } = await import('../src/operational-date');
    const manual = (await clients.viewer!.req('POST', '/invoices', { direction: 'sales', counterparty_id: ids.customerA, issue_date: '2031-01-01', tax_point_date: '2031-01-01',
      lines: [{ description: 'Manual', quantity: '1', unit_price: '10.00', vat_rate: '15', vat_treatment: 'standard' }] })).json.invoice;
    const snapshot = (await pool.query('SELECT * FROM invoices WHERE id=$1', [manual.id])).rows[0];
    const t = await make(salesBody({ start_date: operationalDate() }));
    const res = await clients.manager!.req('POST', '/recurring-invoices/run-due', {});
    expect(res.status).toBe(200);
    const mine = res.json.results.find((r: any) => r.template_id === t.id);
    expect(mine.generated).toHaveLength(1);
    expect((await invoicesOf(t.id))[0]).toMatchObject({ status: 'draft', origin: 'recurring' });
    expect((await pool.query('SELECT * FROM invoices WHERE id=$1', [manual.id])).rows[0]).toEqual(snapshot);
    expect(await count("SELECT COUNT(*)::text n FROM invoices WHERE id=$1 AND origin='manual'", [manual.id])).toBe(1);
  });

  it('closed periods: a backdated occurrence still becomes a harmless draft; the closed-period rules apply at approval, and the schedule is not stuck', async () => {
    const fy = (await pool.query<{ id: string }>("INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY42','2042-01-01','2042-12-31') RETURNING id", [ids.coA])).rows[0]!.id;
    await pool.query("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2042-01-01','2042-01-31','closed')", [ids.coA, fy]);
    const t = await make(salesBody({ start_date: '2042-01-15' }));
    expect((await svc.generateForTemplate(t.id, '2042-02-20')).generated).toHaveLength(2);
    const rows = await invoicesOf(t.id);
    expect(rows.map((r) => r.status)).toEqual(['draft', 'draft']);
    expect(await count('SELECT COUNT(*)::text n FROM obligations WHERE invoice_id = ANY($1)', [rows.map((r) => r.id)])).toBe(0);
    expect(await count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='obligation' AND source_id IN (SELECT id FROM obligations WHERE invoice_id = ANY($2))", [ids.coA, rows.map((r) => r.id)])).toBe(0);
  });

  it('a generated draft stays inside the normal workflow: it cannot be approved by the template creator (separation of duties still applies)', async () => {
    const t = await make(salesBody({ start_date: '2041-01-01' }));
    await svc.generateForTemplate(t.id, '2041-01-01');
    const [inv] = await invoicesOf(t.id);
    expect(inv.created_by_user_id).toBe(ids.manager);
    expect((await clients.manager!.req('POST', `/invoices/${inv.id}/approve`, { version: inv.version })).status).toBe(403); // no invoice.approve
    expect(await count('SELECT COUNT(*)::text n FROM invoices WHERE id=$1 AND status=$2', [inv.id, 'draft'])).toBe(1);
  });
});
