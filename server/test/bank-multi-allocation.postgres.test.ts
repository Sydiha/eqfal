import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { UNRESOLVED_BANK_TRANSACTION_SQL } from '../src/modules/banking/bank-reconciliation-core';

// D2 / R9: one bank transaction settling several documents (migration 100) over real HTTP + PostgreSQL. Requires a disposable DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('one bank transaction, several document allocations (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());
  let rowNo = 0;

  async function setup(label: string, opts: { link?: boolean } = {}) {
    const owner = await h.user(`${label}-own`);
    const id = await h.company(label, owner.id);
    await owner.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    await h.db.query(
      `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,prepared_by_user_id,approved_by_user_id,approved_at)
       VALUES($1,1,'approved','IFRS','SAR','SAR','2025-01-01','not_registered','zakat_applicable','saudi_gcc_only','not_currently_applicable','no','2025-01-01',$2,$2,NOW())`, [id, owner.id]);
    const bankGl = await h.account(id, 'B-BANK', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [bankGl]);
    const otherCash = await h.account(id, 'B-OTHER', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [otherCash]);
    const ar = await h.account(id, 'AR', 'asset', 'current_asset');
    const ap = await h.account(id, 'AP', 'liability', 'current_liability');
    const bank = (await h.q<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const batch = (await h.q<{ id: string }>(
      "INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id",
      [id, bank, `k-${randomUUID()}`, owner.id]))[0]!.id;
    if (opts.link !== false) {
      const r = await owner.client.req('POST', '/bank-ledger-links', { bank_account_id: bank, account_id: bankGl, valid_from: '2026-01-01' });
      expect(r.status).toBe(201);
    }
    const counterparty = async (name: string) => (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,$2,'customer',$3) RETURNING id", [id, name, owner.id]))[0]!.id;
    const customer = await counterparty('Customer A');
    const otherCustomer = await counterparty('Customer B');
    return { id, owner, fy, bankGl, otherCash, ar, ap, bank, batch, customer, otherCustomer };
  }
  type Co = Awaited<ReturnType<typeof setup>>;

  async function bankTx(co: Co, date: string, amount: string) {
    rowNo += 1;
    return (await h.q<{ id: string }>(
      "INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,$4,$5,'SAR',$6,$7,'strong') RETURNING id",
      [co.id, co.bank, co.batch, date, amount, rowNo, `fp-${randomUUID()}`]))[0]!.id;
  }
  async function doc(co: Co, total: string, o: { type?: string; counterparty?: string | null } = {}) {
    return (await h.q<{ id: string }>(
      "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount,counterparty_id) VALUES($1,$2,'inv.pdf','application/pdf',10,$3,$4,'approved',$5,'2026-01-10',$6,$7) RETURNING id",
      [co.id, co.owner.id, `d-${randomUUID()}`, 'a'.repeat(64), o.type ?? 'sale', total, o.counterparty === undefined ? co.customer : o.counterparty]))[0]!.id;
  }
  const allocate = (co: Co, tx: string, allocations: Array<[string, string]>) =>
    co.owner.client.req('POST', `/bank-transactions/${tx}/allocations`, { allocations: allocations.map(([document_id, amount]) => ({ document_id, amount })) });
  const unresolved = async (co: Co, tx: string) =>
    (await h.count(`SELECT COUNT(*)::text n FROM bank_transactions t WHERE t.company_id=$1 AND t.id=$2 AND ${UNRESOLVED_BANK_TRANSACTION_SQL}`, [co.id, tx])) === 1;
  const settlementsOf = (tx: string) => h.q<{ id: string; document_id: string; amount: string }>('SELECT id,document_id,amount::text FROM document_settlements WHERE bank_transaction_id=$1 ORDER BY document_id', [tx]);
  const dbError = async (sql: string, p: unknown[] = []) => { try { await h.q(sql, p); return null; } catch (e) { return String((e as Error).message); } };

  async function settlementJournal(co: Co, settlementId: string, date: string, lines: Array<[string, string, string]>) {
    const created = await co.owner.client.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: date, description: 'Settlement', source_type: 'document_settlement', source_id: settlementId });
    expect(created.status).toBe(201);
    const put = await co.owner.client.req('PUT', `/journals/${created.json.id}/lines`, { lines: lines.map(([account_id, debit, credit]) => ({ account_id, debit, credit, memo: null })) }, { 'if-match': '1' });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    return created.json.id as string;
  }
  const post = (co: Co, journal: string) => co.owner.client.req('POST', `/journals/${journal}/post`, {});

  it('allocates one receipt to several invoices atomically, with one journal per allocation and no duplicate recognition', async () => {
    const co = await setup('multi');
    const a = await doc(co, '600.00');
    const b = await doc(co, '400.00');
    const tx = await bankTx(co, '2026-01-20', '1000.00');
    const r = await allocate(co, tx, [[a, '600.00'], [b, '400.00']]);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: 'matched', allocated_amount: '1000.00', unallocated_amount: '0.00' });
    expect((await settlementsOf(tx)).map(s => s.amount).sort()).toEqual(['400.00', '600.00']);
    expect(await h.count('SELECT COUNT(*)::text n FROM bank_transaction_matches WHERE bank_transaction_id=$1', [tx])).toBe(2);
    expect(await unresolved(co, tx)).toBe(false);
    const candidates = await co.owner.client.req('GET', `/bank-transactions/${tx}/match-candidates`);
    expect(candidates.json).toMatchObject({ allocated_amount: '1000.00', unallocated_amount: '0.00' });
    expect(candidates.json.matches).toHaveLength(2);

    // each allocation posts once, against the linked bank ledger account
    for (const s of await settlementsOf(tx)) {
      const j = await settlementJournal(co, s.id, '2026-01-20', [[co.bankGl, s.amount, '0'], [co.ar, '0', s.amount]]);
      expect((await post(co, j)).status).toBe(200);
      const dup = await co.owner.client.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: '2026-01-20', description: 'dup', source_type: 'document_settlement', source_id: s.id });
      expect(dup.status).toBe(409);
    }
    const bankNet = (await h.q<{ n: string }>("SELECT (SUM(l.debit)-SUM(l.credit))::text n FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE l.account_id=$1 AND j.status='posted'", [co.bankGl]))[0]!.n;
    expect(bankNet).toBe('1000.00');

    // reconciliation needs the full amount allocated, and reopening stays blocked while allocations exist
    expect((await co.owner.client.req('POST', `/bank-transactions/${tx}/reconciliation`, { status: 'reconciled' })).status).toBe(200);
    expect((await co.owner.client.req('POST', `/bank-transactions/${tx}/reconciliation`, { status: 'matched' })).status).toBe(409);
    // posted allocations are immutable
    expect(await dbError('DELETE FROM document_settlements WHERE bank_transaction_id=$1', [tx])).toMatch(/immutable/i);
  });

  it('keeps a partial allocation unresolved for closing and refuses to reconcile it', async () => {
    const co = await setup('partial');
    const a = await doc(co, '300.00');
    const b = await doc(co, '300.00');
    const tx = await bankTx(co, '2026-01-20', '1000.00');
    const r = await allocate(co, tx, [[a, '300.00'], [b, '200.00']]);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ allocated_amount: '500.00', unallocated_amount: '500.00' });
    expect(await unresolved(co, tx)).toBe(true);
    const rec = await co.owner.client.req('POST', `/bank-transactions/${tx}/reconciliation`, { status: 'reconciled' });
    expect(rec.status).toBe(409);
    expect(rec.json.error).toMatch(/not fully allocated/i);
    // the remainder is allocated later on the same transaction
    const c = await doc(co, '500.00');
    expect((await allocate(co, tx, [[c, '500.00']])).status).toBe(201);
    expect(await unresolved(co, tx)).toBe(false);
  });

  it('lists document remaining amounts, hides fully settled documents and rejects re-settlement via another bank row (UAT R9 limit)', async () => {
    const co = await setup('limit');
    const a = await doc(co, '60.00');
    const b = await doc(co, '40.00');
    const c = await doc(co, '50.00');
    const tx1 = await bankTx(co, '2026-01-20', '100.00');
    expect((await allocate(co, tx1, [[a, '60.00'], [b, '40.00']])).status).toBe(201);     // G: 60 + 40 against one 100 row
    expect((await allocate(co, tx1, [[c, '1.00']])).status).toBe(409);                    // F: above the bank row remaining
    const tx2 = await bankTx(co, '2026-01-21', '100.00');
    const part = await allocate(co, tx2, [[c, '20.00']]);
    expect(part.status).toBe(201);
    const list = (await co.owner.client.req('GET', `/bank-transactions/${tx2}/match-candidates`)).json.documents as Array<{ id: string; total_amount: string; settled_amount: string; remaining_amount: string }>;
    expect(list.find(d => d.id === c)).toMatchObject({ total_amount: '50.00', settled_amount: '20.00', remaining_amount: '30.00' });   // B
    expect(list.find(d => d.id === a)).toBeUndefined();                                    // C
    expect(list.find(d => d.id === b)).toBeUndefined();
    const d = await doc(co, '75.00');
    const tx3 = await bankTx(co, '2026-01-22', '100.00');
    const fresh = (await co.owner.client.req('GET', `/bank-transactions/${tx3}/match-candidates`)).json.documents as Array<{ id: string; remaining_amount: string }>;
    expect(fresh.find(x => x.id === d)?.remaining_amount).toBe('75.00');                  // A
    const before = await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1', [co.id]);
    const rej = await allocate(co, tx3, [[a, '1.00']]);                                    // D
    expect(rej.status).toBe(409);
    expect(await settlementsOf(tx3)).toHaveLength(0);                                      // E
    expect(await h.count('SELECT COUNT(*)::text n FROM bank_transaction_matches WHERE bank_transaction_id=$1', [tx3])).toBe(0);
    expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1', [co.id])).toBe(before);
  });

  it('prevents over-allocation of the bank transaction and of each document, in the service and in the database', async () => {
    const co = await setup('over');
    const a = await doc(co, '600.00');
    const b = await doc(co, '600.00');
    const tx = await bankTx(co, '2026-01-20', '1000.00');
    const over = await allocate(co, tx, [[a, '600.00'], [b, '500.00']]);
    expect(over.status).toBe(409);
    expect(over.json.error).toMatch(/exceed the bank transaction amount/i);
    expect(await settlementsOf(tx)).toHaveLength(0);
    expect(await h.count('SELECT COUNT(*)::text n FROM bank_transaction_matches WHERE bank_transaction_id=$1', [tx])).toBe(0);
    expect((await allocate(co, tx, [[a, '700.00']])).status).toBe(409);             // above the document remaining amount
    expect((await allocate(co, tx, [[a, '600.00']])).status).toBe(201);
    expect((await allocate(co, tx, [[a, '1.00']])).status).toBe(409);               // the same document twice on one bank row
    // the existing per-document endpoint is capped by the bank transaction too
    const legacy = await co.owner.client.req('POST', `/documents/${a}/settlements`, { bank_transaction_id: tx, amount: '1.00' });
    expect(legacy.status).toBe(409);
    // database backstop (deferred, migration 100)
    await h.q("INSERT INTO bank_transaction_matches(company_id,bank_transaction_id,document_id,match_type,matched_by_user_id) VALUES($1,$2,$3,'document',$4)", [co.id, tx, b, co.owner.id]);
    expect(await dbError('INSERT INTO document_settlements(company_id,document_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,500,$4)', [co.id, b, tx, co.owner.id])).toMatch(/exceed the bank transaction amount/i);
    expect(await dbError('INSERT INTO document_settlements(company_id,document_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,400,$4)', [co.id, b, tx, co.owner.id])).toBeNull();
  });

  it('requires one non-null counterparty, the transaction direction, and no custody relationship', async () => {
    const co = await setup('rules');
    const a = await doc(co, '100.00');
    const tx = await bankTx(co, '2026-01-20', '200.00');
    expect((await allocate(co, tx, [[a, '100.00'], [await doc(co, '100.00', { counterparty: co.otherCustomer }), '100.00']])).status).toBe(409);
    expect((await allocate(co, tx, [[a, '100.00'], [await doc(co, '100.00', { counterparty: null }), '100.00']])).status).toBe(409);
    expect((await allocate(co, tx, [[a, '100.00'], [await doc(co, '100.00', { type: 'purchase' }), '100.00']])).status).toBe(409);
    expect((await allocate(co, tx, [[a, '100.00']])).status).toBe(201);
    // a later allocation must keep the counterparty of the existing ones
    expect((await allocate(co, tx, [[await doc(co, '100.00', { counterparty: co.otherCustomer }), '100.00']])).status).toBe(409);
    // a document match and a custody relationship never share a bank row
    const custody = (await h.q<{ id: string }>('INSERT INTO custody_advances(company_id,holder_user_id,created_by_user_id) VALUES($1,$2,$2) RETURNING id', [co.id, co.owner.id]))[0]!.id;
    expect(await dbError("INSERT INTO bank_transaction_matches(company_id,bank_transaction_id,custody_id,match_type,matched_by_user_id) VALUES($1,$2,$3,'custody_funding',$4)", [co.id, tx, custody, co.owner.id])).toMatch(/already explained/i);
    expect((await co.owner.client.req('POST', `/bank-transactions/${tx}/allocations`, { allocations: [{ document_id: a, amount: '1.00' }, { document_id: a, amount: '1.00' }] })).status).toBe(400);
  });

  it('posts a document-settlement journal only against the linked bank ledger account, in the bank direction, for the allocation amount', async () => {
    const co = await setup('posting');
    const sale = await doc(co, '250.00');
    const receipt = await bankTx(co, '2026-01-20', '250.00');
    expect((await allocate(co, receipt, [[sale, '250.00']])).status).toBe(201);
    const [s] = await settlementsOf(receipt);
    const wrongAccount = await settlementJournal(co, s!.id, '2026-01-20', [[co.otherCash, '250.00', '0'], [co.ar, '0', '250.00']]);
    expect((await post(co, wrongAccount)).json.error).toMatch(/linked bank ledger account/i);
    await co.owner.client.req('PUT', `/journals/${wrongAccount}/lines`, { lines: [{ account_id: co.ar, debit: '250.00', credit: '0', memo: null }, { account_id: co.bankGl, debit: '0', credit: '250.00', memo: null }] }, { 'if-match': '2' });
    expect((await post(co, wrongAccount)).json.error).toMatch(/linked bank ledger account/i);  // wrong direction for a receipt
    await co.owner.client.req('PUT', `/journals/${wrongAccount}/lines`, { lines: [{ account_id: co.bankGl, debit: '250.00', credit: '0', memo: null }, { account_id: co.ar, debit: '0', credit: '250.00', memo: null }] }, { 'if-match': '3' });
    expect((await post(co, wrongAccount)).status).toBe(200);

    const purchase = await doc(co, '80.00', { type: 'purchase' });
    const payment = await bankTx(co, '2026-01-21', '-80.00');
    expect((await allocate(co, payment, [[purchase, '80.00']])).status).toBe(201);
    const [p] = await settlementsOf(payment);
    const pay = await settlementJournal(co, p!.id, '2026-01-21', [[co.ap, '80.00', '0'], [co.bankGl, '0', '80.00']]);
    expect((await post(co, pay)).status).toBe(200);

    // no ledger link on the transaction date: the posting is refused with a clear error
    const unlinked = await setup('posting-nolink', { link: false });
    const d = await doc(unlinked, '50.00');
    const t = await bankTx(unlinked, '2026-01-20', '50.00');
    expect((await allocate(unlinked, t, [[d, '50.00']])).status).toBe(201);
    const [u] = await settlementsOf(t);
    const j = await settlementJournal(unlinked, u!.id, '2026-01-20', [[unlinked.bankGl, '50.00', '0'], [unlinked.ar, '0', '50.00']]);
    const refused = await post(unlinked, j);
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/not linked to an active bank ledger account/i);
  });

  it('keeps the single-document match, reconcile and delete flow unchanged', async () => {
    const co = await setup('legacy');
    const a = await doc(co, '500.00');
    const tx = await bankTx(co, '2026-01-20', '500.00');
    expect((await co.owner.client.req('POST', `/bank-transactions/${tx}/match`, { document_id: a })).status).toBe(201);
    expect(await unresolved(co, tx)).toBe(true);
    expect((await co.owner.client.req('POST', `/bank-transactions/${tx}/reconciliation`, { status: 'reconciled' })).status).toBe(200);
    expect(await settlementsOf(tx)).toMatchObject([{ document_id: a, amount: '500.00' }]);
    expect(await unresolved(co, tx)).toBe(false);
    const [s] = await settlementsOf(tx);
    expect((await co.owner.client.req('DELETE', `/documents/${a}/settlements/${s!.id}`, { reason: 'wrong' })).status).toBe(200);
    expect(await unresolved(co, tx)).toBe(true);
    expect((await co.owner.client.req('POST', `/bank-transactions/${tx}/reconciliation`, { status: 'matched' })).status).toBe(200);
    expect((await co.owner.client.req('DELETE', `/bank-transactions/${tx}/match`)).status).toBe(200);
    // the unmatch audit records the document matches that existed before deletion
    const audit = await h.q<{ before_data: { document_ids: string[] } }>("SELECT before_data FROM audit_log WHERE company_id=$1 AND action='bank_transaction.unmatch' AND entity_id=$2", [co.id, tx]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before_data.document_ids).toEqual([a]);
  });

  it('serializes concurrent allocations and mixed legacy/new writes without deadlocks or over-allocation', async () => {
    const co = await setup('race');
    const tx = await bankTx(co, '2026-01-20', '100.00');
    const docs = await Promise.all(Array.from({ length: 6 }, () => doc(co, '40.00')));
    const results = await Promise.all(docs.map(d => allocate(co, tx, [[d, '40.00']])));
    expect(results.every(r => r.status === 201 || r.status === 409)).toBe(true);
    expect(results.filter(r => r.status === 201)).toHaveLength(2);
    expect((await h.q<{ n: string }>('SELECT SUM(amount)::text n FROM document_settlements WHERE bank_transaction_id=$1', [tx]))[0]!.n).toBe('80.00');

    // the per-document endpoint and reconciliation used to lock in opposite orders; both now lock the bank transaction first
    for (let i = 0; i < 8; i += 1) {
      const d = await doc(co, '30.00');
      const t = await bankTx(co, '2026-01-20', '30.00');
      expect((await co.owner.client.req('POST', `/bank-transactions/${t}/match`, { document_id: d })).status).toBe(201);
      const [settle, reconcile] = await Promise.all([
        co.owner.client.req('POST', `/documents/${d}/settlements`, { bank_transaction_id: t, amount: '30.00' }),
        co.owner.client.req('POST', `/bank-transactions/${t}/reconciliation`, { status: 'reconciled' }),
      ]);
      expect([settle.status, reconcile.status].some(s => s >= 500)).toBe(false);
      expect((await h.q<{ n: string }>('SELECT COALESCE(SUM(amount),0)::text n FROM document_settlements WHERE bank_transaction_id=$1', [t]))[0]!.n).toBe('30.00');
    }
  });

  it('aggregates the allocation journals of one bank row into one reconciliation evidence item', async () => {
    const co = await setup('evidence');
    await h.postedJournal(co.id, co.fy, '2026-01-05', co.owner.id, [[co.bankGl, '1000.00', '0'], [co.ar, '0', '1000.00']]);
    const a = await doc(co, '150.00', { type: 'purchase' });
    const b = await doc(co, '100.00', { type: 'purchase' });
    const later = await bankTx(co, '2026-02-03', '-250.00');
    expect((await allocate(co, later, [[a, '150.00'], [b, '100.00']])).status).toBe(201);
    // fixture journals dated inside January for a bank row that cleared in February (timing difference)
    for (const s of await settlementsOf(later)) {
      await h.postedJournal(co.id, co.fy, '2026-01-31', co.owner.id, [[co.ap, s.amount, '0'], [co.bankGl, '0', s.amount]], { source_type: 'document_settlement', source_id: s.id });
    }
    const draft = await co.owner.client.req('POST', '/bank-statements', { bank_account_id: co.bank, statement_ref: 'JAN', period_start: '2026-01-01', period_end: '2026-01-31', opening_balance: '0.00', closing_balance: '1000.00' });
    expect(draft.status).toBe(201);
    expect((await co.owner.client.req('POST', `/bank-statements/${draft.json.id}/confirm`, { version: draft.json.version })).status).toBe(200);
    const result = (await co.owner.client.req('GET', `/bank-reconciliation/preview?bank_account_id=${co.bank}&period_end=2026-01-31`)).json.accounts[0];
    expect(result.rejected_evidence).toEqual([]);
    expect(result.outstanding_items).toHaveLength(1);
    expect(result.outstanding_items[0].journal_entry_ids).toHaveLength(2);
    expect(result).toMatchObject({ outstanding_payments: '250.00', difference: '0.00', reconciled: true });
  });

  it('preserves pre-existing single settlements and journals across migration 100', async () => {
    // the schema change keeps existing rows: every earlier pair (one match, one settlement per bank row) is still valid and unchanged
    const constraints = await h.q<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conrelid IN ('document_settlements'::regclass,'bank_transaction_matches'::regclass) AND contype='u'");
    const names = constraints.map(c => c.conname);
    expect(names).toContain('document_settlements_tx_document_uidx');
    expect(names).not.toContain('document_settlements_bank_transaction_id_key');
    expect(names).not.toContain('bank_transaction_matches_bank_transaction_id_key');
    expect(await h.count("SELECT COUNT(*)::text n FROM pg_indexes WHERE indexname='bank_transaction_matches_custody_one_uidx'")).toBe(1);
    // the migration only changes constraints, indexes and triggers; it never rewrites or deletes data
    const sql = readFileSync(new URL('../migrations/100_multi_document_bank_allocations.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|TRUNCATE|INSERT)\s/im);
  });
});
