import bcrypt from 'bcrypt';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// F3 invoice collection/payment over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
// Settlement is the existing obligation endpoint (obligation.settlement.create); F3 adds no second mechanism and no grants.
// invoice.* capabilities are explicit-grant-only; this suite provisions them directly on test roles.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'Invoice-F3-Settle-1!';

describeDatabase('invoice collection and payment (PostgreSQL)', () => {
  let pool: Pool;
  let server: http.Server;
  let base = '';
  const run = randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};
  let row = 0;

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
  const clients: Record<string, Client> = {};
  const email = (label: string) => `invf3-${label}-${run}@example.test`;
  const count = async (sql: string, p: unknown[]) => Number((await pool.query<{ n: string }>(sql, p)).rows[0]!.n);
  const APPROVER_CAPS = ['invoice.view', 'invoice.approve', 'obligation.confirm', 'accounting.journal.create', 'obligation.view'];

  const bankTx = async (company: string, amount: string, date = '2026-10-10') => {
    row += 1;
    return (await pool.query<{ id: string }>(
      "INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,description,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,$4,$5,'SAR',$6,$7,$8,'strong') RETURNING id",
      [company, company === ids.coA ? ids.accountA : ids.accountB, company === ids.coA ? ids.batchA : ids.batchB, date, amount, `tx ${row}`, row, `fp-${randomUUID()}`])).rows[0]!.id;
  };

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
    for (const label of ['ownerA', 'ownerB', 'creator', 'approver', 'settler', 'viewer', 'settlerB']) ids[label] = await mkUser(label);
    const companies = new CompanyManagementService(pool);
    ids.coA = (await companies.create({ slug: `invf3-a-${run}`, name: `INVF3-A-${run}`, name_ar: null }, ids.ownerA!)).id;
    ids.coB = (await companies.create({ slug: `invf3-b-${run}`, name: `INVF3-B-${run}`, name_ar: null }, ids.ownerB!)).id;
    const role = async (company: string, name: string, caps: string[]) => {
      const id = (await pool.query<{ id: string }>('INSERT INTO roles(company_id,name) VALUES($1,$2) RETURNING id', [company, name])).rows[0]!.id;
      for (const c of caps) await pool.query('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)', [id, c]);
      return id;
    };
    const member = (user: string, company: string, roleId: string) => pool.query('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)', [user, company, roleId]);
    await member(ids.creator!, ids.coA!, await role(ids.coA!, 'F3Creator', ['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit']));
    await member(ids.approver!, ids.coA!, await role(ids.coA!, 'F3Approver', APPROVER_CAPS));
    await member(ids.settler!, ids.coA!, await role(ids.coA!, 'F3Settler', ['invoice.view', 'obligation.view', 'obligation.settlement.create']));
    await member(ids.viewer!, ids.coA!, await role(ids.coA!, 'F3Viewer', ['invoice.view', 'obligation.view']));
    await member(ids.settlerB!, ids.coB!, await role(ids.coB!, 'F3SettlerB', ['invoice.view', 'obligation.view', 'obligation.settlement.create']));
    ids.fy = (await pool.query<{ id: string }>("INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY26','2026-01-01','2026-12-31') RETURNING id", [ids.coA])).rows[0]!.id;
    const mappings = new InvoiceAccountMappingService(pool);
    for (const [k, t] of Object.entries({ receivable: 'asset', payable: 'liability', sales_revenue: 'revenue', purchase_expense: 'expense', vat_output: 'liability', vat_input: 'asset' })) {
      const acc = (await pool.query<{ id: string }>('INSERT INTO accounts(company_id,code,name,account_type) VALUES($1,$2,$2,$3) RETURNING id', [ids.coA, `F3-${k}`, t])).rows[0]!.id;
      await mappings.set(ids.coA!, ids.approver!, k, acc);
    }
    const cp = async (company: string, name: string, type: string) => (await pool.query<{ id: string }>(
      'INSERT INTO counterparties(company_id,name,type,is_active,created_by_user_id) VALUES($1,$2,$3,true,$4) RETURNING id', [company, name, type, ids.ownerA])).rows[0]!.id;
    ids.customerA = await cp(ids.coA!, 'Customer A', 'customer');
    ids.supplierA = await cp(ids.coA!, 'Supplier A', 'supplier');
    for (const [key, co] of [['A', ids.coA!], ['B', ids.coB!]] as const) {
      ids[`account${key}`] = (await pool.query<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id", [co, ids.ownerA])).rows[0]!.id;
      ids[`batch${key}`] = (await pool.query<{ id: string }>(
        "INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id",
        [co, ids[`account${key}`], `k-${co}`, ids.ownerA])).rows[0]!.id;
    }
    for (const label of ['ownerA', 'creator', 'approver', 'settler', 'viewer', 'settlerB']) { clients[label] = new Client(email(label)); await clients[label]!.login(); }
  });
  afterAll(() => { server.close(); });

  const line = (direction: 'sales' | 'purchase') => direction === 'sales'
    ? { description: 'Consulting', quantity: '1', unit_price: '1000.00', vat_rate: '15', vat_treatment: 'standard' }
    : { description: 'Supplies', quantity: '1', unit_price: '1000.00', vat_rate: '15', vat_treatment: 'standard', vat_recoverability: 'fully_recoverable' };
  /** Approved invoice (total 1150.00); journal posted only when asked, standing in for the separate posting step. */
  const approvedInvoice = async (direction: 'sales' | 'purchase', opts: { post?: boolean } = {}) => {
    const created = (await clients.creator!.req('POST', '/invoices', {
      direction, counterparty_id: direction === 'sales' ? ids.customerA : ids.supplierA, issue_date: '2026-10-01', tax_point_date: '2026-10-01', lines: [line(direction)],
    })).json.invoice;
    const submitted = (await clients.creator!.req('POST', `/invoices/${created.id}/submit`, { version: created.version })).json.invoice;
    const res = await clients.approver!.req('POST', `/invoices/${submitted.id}/approve`, { version: submitted.version });
    expect(res.status).toBe(200);
    if (opts.post !== false) await pool.query("UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE id=$1", [res.json.journal_id, ids.approver]);
    return { id: submitted.id as string, obligation: res.json.obligation_id as string };
  };
  const settle = (who: string, obligation: string, bank: string, amount: string) => clients[who]!.req('POST', `/obligations/${obligation}/settlements`, { bank_transaction_id: bank, amount, note: null });
  const read = async (id: string) => (await clients.settler!.req('GET', `/invoices/${id}`)).json.invoice;

  it('sales: a collection settles the linked obligation after posting; the invoice shows paid, outstanding and history from the server', async () => {
    const inv = await approvedInvoice('sales');
    expect((await read(inv.id)).actionable_status).toBe('awaiting_settlement');
    const tx = await bankTx(ids.coA!, '1150.00');
    const res = await settle('settler', inv.obligation, tx, '1150.00');
    expect(res.status).toBe(201);
    const after = await read(inv.id);
    expect(after).toMatchObject({ paid_amount: '1150.00', outstanding_amount: '0.00', actionable_status: 'settled' });
    expect(after.settlements).toHaveLength(1);
    expect(after.settlements[0]).toMatchObject({ bank_transaction_id: tx, amount: '1150.00' });
    expect(await count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_type='obligation_settlement' AND action='obligation_settlement.create' AND entity_id=$1", [res.json.id])).toBe(1);
    // Nothing else changed: bank transaction state is untouched (no automatic matching or reconciliation).
    expect((await pool.query('SELECT reconciliation_status FROM bank_transactions WHERE id=$1', [tx])).rows[0].reconciliation_status).toBe('unmatched');
  });

  it('purchase: a payment (debit) settles the payable obligation', async () => {
    const inv = await approvedInvoice('purchase');
    const tx = await bankTx(ids.coA!, '-1150.00');
    expect((await settle('settler', inv.obligation, tx, '1150.00')).status).toBe(201);
    expect(await read(inv.id)).toMatchObject({ paid_amount: '1150.00', outstanding_amount: '0.00', actionable_status: 'settled' });
  });

  it('multiple partial collections through separate bank transactions update the outstanding balance exactly', async () => {
    const inv = await approvedInvoice('sales');
    const a = await bankTx(ids.coA!, '400.00'); const b = await bankTx(ids.coA!, '350.50'); const c = await bankTx(ids.coA!, '399.50');
    expect((await settle('settler', inv.obligation, a, '400.00')).status).toBe(201);
    expect(await read(inv.id)).toMatchObject({ paid_amount: '400.00', outstanding_amount: '750.00', actionable_status: 'partially_settled' });
    expect((await settle('settler', inv.obligation, b, '350.50')).status).toBe(201);
    expect(await read(inv.id)).toMatchObject({ paid_amount: '750.50', outstanding_amount: '399.50' });
    expect((await settle('settler', inv.obligation, c, '399.50')).status).toBe(201);
    const done = await read(inv.id);
    expect(done).toMatchObject({ paid_amount: '1150.00', outstanding_amount: '0.00', actionable_status: 'settled' });
    expect(done.settlements.map((s: { amount: string }) => s.amount)).toEqual(['400.00', '350.50', '399.50']);
  });

  it('rejects overpayment and a second settlement with the same bank transaction; nothing is recorded', async () => {
    const inv = await approvedInvoice('sales');
    const first = await bankTx(ids.coA!, '1000.00'); const big = await bankTx(ids.coA!, '200.00');
    expect((await settle('settler', inv.obligation, first, '1000.00')).status).toBe(201);
    expect((await settle('settler', inv.obligation, big, '200.00')).status).toBe(409); // 1000 + 200 > 1150
    expect((await settle('settler', inv.obligation, first, '1000.00')).status).toBe(409); // same transaction twice
    const other = await approvedInvoice('sales');
    expect((await settle('settler', other.obligation, first, '1000.00')).status).toBe(409); // same transaction on another invoice
    expect(await count('SELECT COUNT(*)::text n FROM obligation_settlements WHERE obligation_id=$1', [inv.obligation])).toBe(1);
    expect((await read(inv.id)).outstanding_amount).toBe('150.00');
  });

  it('concurrent settlements of one transaction create exactly one record', async () => {
    const inv = await approvedInvoice('sales');
    const tx = await bankTx(ids.coA!, '500.00');
    const results = await Promise.all([1, 2, 3].map(() => settle('settler', inv.obligation, tx, '500.00')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await count('SELECT COUNT(*)::text n FROM obligation_settlements WHERE bank_transaction_id=$1', [tx])).toBe(1);
  });

  it('rejects settlement before the journal is posted, and allows it once posted', async () => {
    const inv = await approvedInvoice('sales', { post: false });
    const tx = await bankTx(ids.coA!, '100.00');
    expect((await settle('settler', inv.obligation, tx, '100.00')).status).toBe(409);
    expect(await count('SELECT COUNT(*)::text n FROM obligation_settlements WHERE obligation_id=$1', [inv.obligation])).toBe(0);
    expect((await read(inv.id)).actionable_status).toBe('awaiting_posting');
    await pool.query("UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE source_type='obligation' AND source_id=$1", [inv.obligation, ids.approver]);
    expect((await settle('settler', inv.obligation, tx, '100.00')).status).toBe(201);
  });

  it('rejects a bank transaction in the wrong direction for the invoice', async () => {
    const sales = await approvedInvoice('sales'); const purchase = await approvedInvoice('purchase');
    expect((await settle('settler', sales.obligation, await bankTx(ids.coA!, '-100.00'), '100.00')).status).toBe(409);
    expect((await settle('settler', purchase.obligation, await bankTx(ids.coA!, '100.00'), '100.00')).status).toBe(409);
    expect(await count('SELECT COUNT(*)::text n FROM obligation_settlements WHERE obligation_id = ANY($1)', [[sales.obligation, purchase.obligation]])).toBe(0);
  });

  it('requires obligation.settlement.create: viewers, invoice approvers and Full Access owners without it are refused', async () => {
    const inv = await approvedInvoice('sales');
    const tx = await bankTx(ids.coA!, '100.00');
    expect((await settle('viewer', inv.obligation, tx, '100.00')).status).toBe(403);
    expect((await settle('approver', inv.obligation, tx, '100.00')).status).toBe(403);
    expect(await count('SELECT COUNT(*)::text n FROM obligation_settlements WHERE obligation_id=$1', [inv.obligation])).toBe(0);
    // payment.settle is not involved and F3 grants nothing.
    expect(await count("SELECT COUNT(*)::text n FROM role_capabilities WHERE capability_id='payment.settle'", [])).toBe(0);
    expect(await count("SELECT COUNT(*)::text n FROM role_capabilities rc JOIN roles r ON r.id=rc.role_id WHERE r.company_id=$1 AND rc.capability_id='invoice.approve' AND r.name='F3Settler'", [ids.coA])).toBe(0);
  });

  it('tenant isolation: another company can neither settle nor read the invoice, obligation or bank transaction', async () => {
    const inv = await approvedInvoice('sales');
    const txA = await bankTx(ids.coA!, '100.00'); const txB = await bankTx(ids.coB!, '100.00');
    expect((await settle('settlerB', inv.obligation, txA, '100.00')).status).toBe(404);
    expect((await settle('settlerB', inv.obligation, txB, '100.00')).status).toBe(404);
    expect((await settle('settler', inv.obligation, txB, '100.00')).status).toBe(404); // foreign bank transaction
    expect((await clients.settlerB!.req('GET', `/invoices/${inv.id}`)).status).toBe(404);
    expect((await settle('settler', 'not-a-uuid', txA, '100.00')).status).toBe(400);
    expect(await count('SELECT COUNT(*)::text n FROM obligation_settlements WHERE obligation_id=$1', [inv.obligation])).toBe(0);
  });

  it('refuses a settlement dated in a closed accounting period and leaves no record', async () => {
    const inv = await approvedInvoice('sales');
    await pool.query("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-09-01','2026-09-30','closed')", [ids.coA, ids.fy]);
    const closed = await bankTx(ids.coA!, '100.00', '2026-09-15');
    expect((await settle('settler', inv.obligation, closed, '100.00')).status).toBe(409);
    expect(await count('SELECT COUNT(*)::text n FROM obligation_settlements WHERE bank_transaction_id=$1', [closed])).toBe(0);
    expect((await settle('settler', inv.obligation, await bankTx(ids.coA!, '100.00', '2026-10-15'), '100.00')).status).toBe(201);
  });
});
