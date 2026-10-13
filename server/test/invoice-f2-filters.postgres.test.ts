import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvoiceDraftService, parseListQuery } from '../src/modules/invoices/invoice.service';

// F2 read filters (free-text q, supplier picker) against real PostgreSQL. Requires an isolated, disposable database.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('invoice list filters and pickers (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const service = new InvoiceDraftService(pool);
  const user = randomUUID(), coA = randomUUID(), coB = randomUUID();
  const customer = randomUUID(), supplier = randomUUID(), inactiveSupplier = randomUUID(), other = randomUUID(), foreign = randomUUID();
  const list = (companyId: string, query: Record<string, string>) => service.list(companyId, parseListQuery(query));

  async function invoice(company: string, cp: string, direction: string, status: string, ref: string | null, total: string, issue = '2026-10-01') {
    await pool.query(
      `INSERT INTO invoices(company_id,direction,status,counterparty_id,external_reference,issue_date,subtotal_amount,vat_amount,total_amount,created_by_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,0,$7,$8)`, [company, direction, status, cp, ref, issue, total, user]);
  }

  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'x')", [user, `${user}@example.test`]);
    for (const id of [coA, coB]) await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'C')", [id, `f2-${id}`]);
    const cp = (id: string, company: string, name: string, type: string, active = true) =>
      pool.query('INSERT INTO counterparties(id,company_id,name,type,is_active,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6)', [id, company, name, type, active, user]);
    await cp(customer, coA, 'Alpha Trading', 'customer');
    await cp(supplier, coA, 'Gulf Supplies', 'supplier');
    await cp(inactiveSupplier, coA, 'Dormant Supplier', 'supplier', false);
    await cp(other, coA, 'Municipality', 'government');
    await cp(foreign, coB, 'Gulf Supplies Foreign', 'supplier');
    await invoice(coA, customer, 'sales', 'draft', 'SO-100', '115.00', '2026-10-01');
    await invoice(coA, customer, 'sales', 'submitted', '50%_OFF', '230.50', '2026-10-05');
    await invoice(coA, supplier, 'purchase', 'draft', 'BILL-7', '999.99', '2026-10-09');
    await invoice(coA, supplier, 'purchase', 'submitted', null, '10.00', '2026-11-01');
    await invoice(coB, foreign, 'purchase', 'draft', 'BILL-7', '999.99', '2026-10-09');
  });
  afterAll(async () => {
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[coA, coB]]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
    await pool.end();
  });

  it('searches reference, counterparty name and total, case-insensitively, within the company only', async () => {
    expect((await list(coA, { q: 'bill-7' })).invoices.map((i) => i.external_reference)).toEqual(['BILL-7']);
    expect((await list(coA, { q: 'gulf' })).total).toBe(2);
    expect((await list(coA, { q: '230.5' })).invoices.map((i) => i.external_reference)).toEqual(['50%_OFF']);
    expect((await list(coB, { q: 'bill-7' })).total).toBe(1);
    expect((await list(coB, { q: 'alpha' })).total).toBe(0);
  });

  it('treats LIKE wildcards in the search text literally', async () => {
    expect((await list(coA, { q: '%' })).invoices.map((i) => i.external_reference)).toEqual(['50%_OFF']);
    expect((await list(coA, { q: '_OFF' })).total).toBe(1);
    expect((await list(coA, { q: 'S_-100' })).total).toBe(0);
    expect((await list(coA, { q: '\\' })).total).toBe(0);
  });

  it('combines direction, status, counterparty, dates and q, and keeps total consistent with the rows', async () => {
    const all = await list(coA, { direction: 'purchase' });
    expect(all.total).toBe(2);
    const filtered = await list(coA, { direction: 'purchase', status: 'draft', counterparty_id: supplier, from: '2026-10-01', to: '2026-10-31', q: 'bill' });
    expect(filtered.total).toBe(1);
    expect(filtered.invoices.map((i) => i.external_reference)).toEqual(['BILL-7']);
    expect((await list(coA, { direction: 'purchase', to: '2026-10-31' })).total).toBe(1);
    const paged = await list(coA, { limit: '1', offset: '1' });
    expect(paged.total).toBe(4);
    expect(paged.invoices).toHaveLength(1);
  });

  it('serves suppliers (not customers, inactive or foreign counterparties) for the purchase picker', async () => {
    const { suppliers } = await service.listSuppliers(coA);
    expect(suppliers.map((s) => s.name)).toEqual(['Gulf Supplies', 'Municipality']);
    const { customers } = await service.listCustomers(coA);
    expect(customers.map((c) => c.name)).toEqual(['Alpha Trading', 'Municipality']);
  });
});
