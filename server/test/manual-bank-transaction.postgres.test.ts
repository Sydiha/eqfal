import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { UNRESOLVED_BANK_TRANSACTION_SQL } from '../src/modules/banking/bank-reconciliation-core';

// Manual bank transactions (migration 106) over real HTTP + PostgreSQL. Requires a disposable DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('manual bank transactions (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  async function setup(label: string) {
    const owner = await h.user(`${label}-own`);
    const id = await h.company(label, owner.id);
    await owner.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const bank = (await h.q<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const bank2 = (await h.q<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Second','SAR',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const customer = (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Cust','customer',$2) RETURNING id", [id, owner.id]))[0]!.id;
    return { id, owner, fy, bank, bank2, customer };
  }
  type Co = Awaited<ReturnType<typeof setup>>;
  const body = (co: Co, o: Record<string, unknown> = {}) => ({ bank_account_id: co.bank, transaction_date: '2026-03-10', direction: 'incoming', category: 'customer_receipt', amount: '250.50', description: 'Cash from customer', ...o });
  const create = (co: Co, o: Record<string, unknown> = {}) => co.owner.client.req('POST', '/bank-transactions/manual', body(co, o));
  const doc = async (co: Co, type: string, total: string) => (await h.q<{ id: string }>(
    "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount,counterparty_id) VALUES($1,$2,'inv.pdf','application/pdf',10,$3,$4,'approved',$5,'2026-03-01',$6,$7) RETURNING id",
    [co.id, co.owner.id, `d-${randomUUID()}`, 'a'.repeat(64), type, total, co.customer]))[0]!.id;
  const unresolved = async (co: Co, tx: string) => (await h.count(`SELECT COUNT(*)::text n FROM bank_transactions t WHERE t.company_id=$1 AND t.id=$2 AND ${UNRESOLVED_BANK_TRANSACTION_SQL}`, [co.id, tx])) === 1;
  const dbError = async (sql: string, p: unknown[] = []) => { try { await h.q(sql, p); return null; } catch (e) { return String((e as Error).message); } };

  it('creates a manual row marked manual, signed by direction, with audit and no journal', async () => {
    const co = await setup('mk');
    const r = await create(co, { reference: 'REF-1', counterparty: 'ACME' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.transaction).toMatchObject({ source_kind: 'manual', manual_category: 'customer_receipt', amount: '250.50', import_batch_id: null, running_balance: null, reconciliation_status: 'unmatched', created_by_user_id: co.owner.id });
    const out = await create(co, { direction: 'outgoing', category: 'supplier_payment', description: 'Pay', amount: 100 });
    expect(out.json.transaction.amount).toBe('-100.00');
    const list = await co.owner.client.req('GET', '/bank-transactions');
    expect(list.json.transactions.filter((t: any) => t.source_kind === 'manual')).toHaveLength(2);
    const audit = await h.q<any>("SELECT action,after_data FROM audit_log WHERE company_id=$1 AND action='bank_transaction.manual_create' AND entity_id=$2", [co.id, r.json.transaction.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].after_data).toMatchObject({ source: 'manual', category: 'customer_receipt', amount: '250.50' });
    expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1', [co.id])).toBe(0);
    expect(await unresolved(co, r.json.transaction.id)).toBe(true);
  });

  it('validates direction against category, amount, account, document and the deferred transfer type', async () => {
    const co = await setup('val');
    expect((await create(co, { direction: 'outgoing' })).json.code).toBe('DIRECTION_CATEGORY_MISMATCH');
    expect((await create(co, { category: 'bank_fees' })).json.code).toBe('DIRECTION_CATEGORY_MISMATCH');
    const deferred = await create(co, { category: 'inter_account_transfer' });
    expect(deferred.status).toBe(422);
    expect(deferred.json.code).toBe('PAIRED_TRANSFER_DEFERRED');
    for (const amount of ['0', '-5', 'abc', '1.234']) expect((await create(co, { amount })).status).toBe(400);
    expect((await create(co, { description: '  ' })).status).toBe(400);
    expect((await create(co, { transaction_date: '2026-02-30' })).status).toBe(400);
    expect((await create(co, { extra: 1 })).status).toBe(400);
    expect((await create(co, { bank_account_id: randomUUID() })).status).toBe(404);
    expect((await create(co, { supporting_document_id: randomUUID() })).status).toBe(404);
    expect(await h.count("SELECT COUNT(*)::text n FROM bank_transactions WHERE company_id=$1", [co.id])).toBe(0);
    expect((await create(co, { direction: 'outgoing', category: 'refund' })).status).toBe(201);
  });

  it('enforces permission, tenant isolation and the DB shape rules', async () => {
    const co = await setup('perm'); const other = await setup('perm2');
    const viewer = await h.user('perm-viewer');
    await h.member(co.id, viewer.id, ['bank.view', 'bank.import', 'bank.match']);
    await viewer.client.login();
    expect((await viewer.client.req('POST', '/bank-transactions/manual', body(co))).status).toBe(403);
    // other company's bank account and document are invisible
    expect((await create(co, { bank_account_id: other.bank })).status).toBe(404);
    const otherDoc = await doc(other, 'sale', '10.00');
    expect((await create(co, { supporting_document_id: otherDoc })).status).toBe(404);
    const mine = await doc(co, 'sale', '10.00');
    expect((await create(co, { supporting_document_id: mine })).status).toBe(201);
    // DB rules
    expect(await dbError("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id) VALUES($1,$2,'2026-03-01',-5,'SAR','x','weak','manual','customer_receipt',$3)", [co.id, co.bank, co.owner.id])).toMatch(/manual_category_check/);
    expect(await dbError("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id) VALUES($1,$2,'2026-03-01',5,'SAR','y','weak','manual','inter_account_transfer',$3)", [co.id, co.bank, co.owner.id])).toMatch(/manual_category_check/);
    expect(await dbError("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,fingerprint,fingerprint_strength) VALUES($1,$2,'2026-03-01',5,'SAR','z','weak')", [co.id, co.bank])).toMatch(/source_shape_check/);
    const id = (await create(co, { description: 'immutable', amount: '3.33' })).json.transaction.id;
    expect(await dbError('UPDATE bank_transactions SET amount=1 WHERE id=$1', [id])).toMatch(/immutable/);
    expect(await dbError("UPDATE bank_transactions SET source_kind='import' WHERE id=$1", [id])).toMatch(/source cannot change/);
    expect(await dbError('DELETE FROM bank_transactions WHERE id=$1', [id])).toMatch(/cannot be deleted/);
  });

  it('handles duplicates: hard by reference, soft by date and amount, confirmed on purpose', async () => {
    const co = await setup('dup');
    expect((await create(co, { reference: 'R9' })).status).toBe(201);
    const same = await create(co, { reference: 'r9' });
    expect(same.status).toBe(409); expect(same.json.code).toBe('MANUAL_BANK_DUPLICATE');
    const soft = await create(co, { description: 'Other text' });
    expect(soft.status).toBe(409); expect(soft.json.code).toBe('MANUAL_BANK_POSSIBLE_DUPLICATE');
    expect(soft.json.candidates).toHaveLength(1);
    expect((await create(co, { description: 'Other text', confirm_duplicate: true })).status).toBe(201);
    expect((await create(co, { bank_account_id: co.bank2 })).status).toBe(201);
    // an imported row on the same account/date/amount is also surfaced
    const batch = (await h.q<{ id: string }>("INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id", [co.id, co.bank, `k-${randomUUID()}`, co.owner.id]))[0]!.id;
    await h.q("INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,'2026-04-01',77.00,'SAR',1,'imp1','strong')", [co.id, co.bank, batch]);
    const vs = await create(co, { transaction_date: '2026-04-01', amount: '77.00' });
    expect(vs.json.code).toBe('MANUAL_BANK_POSSIBLE_DUPLICATE');
    expect(await h.count("SELECT COUNT(*)::text n FROM bank_transactions WHERE company_id=$1 AND source_kind='import'", [co.id])).toBe(1);
  });


  it('flags a later import row that matches a manual entry as a possible duplicate, never suppressing it', async () => {
    const co = await setup('imp');
    expect((await create(co, { transaction_date: '2026-03-15', amount: '90.00', reference: 'M-1' })).status).toBe(201);
    const csv = 'date,amount,ref\n2026-03-15,90.00,BANK-77\n2026-03-16,10.00,BANK-78\n';
    const up = await fetch(`${h.base}/api/bank-import-batches`, { method: 'POST', headers: { origin: h.base, cookie: co.owner.client.cookie, 'content-type': 'text/csv', 'x-file-name': 'st.csv', 'x-bank-account-id': co.bank }, body: csv });
    expect(up.status).toBe(201);
    const batch = (await up.json()).batch.id;
    const map = await co.owner.client.req('PATCH', `/bank-import-batches/${batch}/mapping`, { amount_mode: 'signed', date_format: 'YYYY-MM-DD', transaction_date: { index: 0 }, amount: { index: 1 }, bank_reference: { index: 2 } });
    expect(map.status, JSON.stringify(map.json)).toBe(200);
    const statuses = map.json.preview.rows.map((r: any) => r.status);
    expect(statuses).toEqual(['possible_duplicate', 'valid']);
    expect((await co.owner.client.req('POST', `/bank-import-batches/${batch}/confirm`, {})).status).toBe(200);
    expect(await h.count("SELECT COUNT(*)::text n FROM bank_transactions WHERE company_id=$1", [co.id])).toBe(3);
    expect(await h.count("SELECT COUNT(*)::text n FROM bank_transactions WHERE company_id=$1 AND source_kind='import'", [co.id])).toBe(2);
  });

  it('blocks closed periods and closed fiscal years', async () => {
    const co = await setup('cls');
    await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-03-01','2026-03-31','closed')", [co.id, co.fy]);
    const r = await create(co);
    expect(r.status).toBe(409); expect(r.json.code).toBe('ACCOUNTING_PERIOD_CLOSED');
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [co.fy]).catch(() => undefined);
    expect(await h.count('SELECT COUNT(*)::text n FROM bank_transactions WHERE company_id=$1', [co.id])).toBe(0);
  });

  it('lets eligible manual rows use existing matching, but never turns transfers, cash or fees into revenue/expense', async () => {
    const co = await setup('mat');
    const sale = await doc(co, 'sale', '250.50');
    const ok = (await create(co)).json.transaction.id;
    const m = await co.owner.client.req('POST', `/bank-transactions/${ok}/match`, { document_id: sale });
    expect(m.status, JSON.stringify(m.json)).toBe(201);
    const again = await co.owner.client.req('POST', `/bank-transactions/${ok}/match`, { document_id: sale });
    expect(again.status).toBe(409);
    let n = 0;
    for (const [cat, dir] of [['cash_deposit', 'incoming'], ['incoming_transfer', 'incoming'], ['cash_withdrawal', 'outgoing'], ['bank_fees', 'outgoing'], ['outgoing_transfer', 'outgoing']] as const) {
      n += 1; const amt = `${12 + n}.00`;
      const tx = (await create(co, { category: cat, direction: dir, amount: amt, description: cat, transaction_date: '2026-03-11' })).json.transaction.id;
      const d = await doc(co, dir === 'incoming' ? 'sale' : 'purchase', amt);
      const r = await co.owner.client.req('POST', `/bank-transactions/${tx}/match`, { document_id: d });
      expect(r.status, cat).toBe(409); expect(r.json.code).toBe('MANUAL_CATEGORY_NOT_SETTLEABLE');
      const a = await co.owner.client.req('POST', `/bank-transactions/${tx}/allocations`, { allocations: [{ document_id: d, amount: amt }] });
      expect(a.status, cat).toBe(409);
      expect(await dbError("INSERT INTO bank_transaction_matches(company_id,bank_transaction_id,document_id,match_type,matched_by_user_id) VALUES($1,$2,$3,'document',$4)", [co.id, tx, d, co.owner.id])).toMatch(/cannot settle/);
      expect(await unresolved(co, tx)).toBe(true);
    }
  });
});
