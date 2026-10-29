import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// Eligible-document picker query for custody allocation, over real HTTP + PostgreSQL. Requires a disposable DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('custody eligible documents (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());
  let rowNo = 0;

  async function setup(label: string) {
    const owner = await h.user(`${label}-own`);
    const id = await h.company(label, owner.id);
    await owner.client.login();
    const recipient = await h.user(`${label}-rcp`);
    await h.member(id, recipient.id, ['custody.view']);
    const outsider = await h.user(`${label}-out`);
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    await h.db.query(
      `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,prepared_by_user_id,approved_by_user_id,approved_at)
       VALUES($1,1,'approved','IFRS','SAR','SAR','2025-01-01','not_registered','zakat_applicable','saudi_gcc_only','not_currently_applicable','no','2025-01-01',$2,$2,NOW())`, [id, owner.id]);
    const bankGl = await h.account(id, `${label}-BANK`, 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [bankGl]);
    const otherBankGl = await h.account(id, `${label}-BANK2`, 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [otherBankGl]);
    const custodyGl = await h.account(id, `${label}-CUST`, 'asset', 'current_asset');
    const fixedAssetGl = await h.account(id, `${label}-FA`, 'asset', 'non_current_asset');
    const expense = await h.account(id, `${label}-EXP`, 'expense');
    const payable = await h.account(id, `${label}-AP`, 'liability', 'current_liability');
    const bank = (await h.q<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const batch = (await h.q<{ id: string }>(
      "INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id",
      [id, bank, `k-${randomUUID()}`, owner.id]))[0]!.id;
    expect((await owner.client.req('POST', '/bank-ledger-links', { bank_account_id: bank, account_id: bankGl, valid_from: '2026-01-01' })).status).toBe(201);
    return { id, owner, recipient, outsider, fy, bankGl, otherBankGl, custodyGl, fixedAssetGl, expense, payable, bank, batch };
  }
  type Co = Awaited<ReturnType<typeof setup>>;

  async function bankTx(co: Co, date: string, amount: string) {
    rowNo += 1;
    return (await h.q<{ id: string }>(
      "INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,$4,$5,'SAR',$6,$7,'strong') RETURNING id",
      [co.id, co.bank, co.batch, date, amount, rowNo, `fp-${randomUUID()}`]))[0]!.id;
  }
  async function expenseDoc(co: Co, total: string) {
    return (await h.q<{ id: string }>(
      "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount) VALUES($1,$2,'exp.pdf','application/pdf',10,$3,$4,'approved','expense','2026-02-10',$5) RETURNING id",
      [co.id, co.owner.id, `d-${randomUUID()}`, 'b'.repeat(64), total]))[0]!.id;
  }
  type Doc = { status?: string; type?: string | null; total?: string | null; ref?: string | null; supplier?: string | null; file?: string };
  async function doc(co: Co, o: Doc = {}) {
    return (await h.q<{ id: string }>(
      "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount,reference_number,counterparty_name) VALUES($1,$2,$3,'application/pdf',10,$4,$5,$6,$7,'2026-02-10',$8,$9,$10) RETURNING id",
      [co.id, co.owner.id, o.file ?? 'f.pdf', `d-${randomUUID()}`, 'b'.repeat(64), o.status ?? 'approved', o.type === undefined ? 'expense' : o.type, o.total === undefined ? '100.00' : o.total, o.ref ?? null, o.supplier ?? null]))[0]!.id;
  }
  const search = async (co: Co, custody: string, q = '', client = co.owner.client) => {
    const r = await client.req('GET', `/custodies/${custody}/eligible-documents?q=${encodeURIComponent(q)}`);
    return { status: r.status, ids: ((r.json?.documents ?? []) as Array<{ id: string }>).map(d => d.id).sort(), body: r.json };
  };
  async function openCustody(co: Co, amount = '-1000.00') {
    const t = await bankTx(co, '2026-02-01', amount);
    const r = await co.owner.client.req('POST', '/custodies', { bank_transaction_id: t, purpose: 'ops', recipient_user_id: co.recipient.id });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.custody.id as string;
  }

  it('lists only eligible documents and applies every exclusion, with the remaining balance as ceiling', async () => {
    const co = await setup('elig');
    const custody = await openCustody(co);
    const good = await doc(co, { total: '250.00', ref: 'INV-1', supplier: 'Acme' });
    const atCeiling = await doc(co, { total: '1000.00' });
    await doc(co, { total: '1000.01' });
    await doc(co, { status: 'needs_review' });
    await doc(co, { status: 'rejected' });
    await doc(co, { type: 'purchase' });
    await doc(co, { type: null });
    await doc(co, { total: null });
    const withObligation = await doc(co, { total: '10.00' });
    const cp = (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Sup','supplier',$2) RETURNING id", [co.id, co.owner.id]))[0]!.id;
    await h.q("INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,$3,10,'2026-02-10','confirmed','document',$4)", [co.id, cp, withObligation, co.owner.id]);
    const cancelled = await doc(co, { total: '11.00' });
    await h.q("INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,is_cancelled,created_by_user_id) VALUES($1,'payable',$2,$3,11,'2026-02-10','confirmed','document',true,$4)", [co.id, cp, cancelled, co.owner.id]);
    const unconfirmed = await doc(co, { total: '12.00' });
    await h.q("INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,$3,12,'2026-02-10','unconfirmed','document',$4)", [co.id, cp, unconfirmed, co.owner.id]);
    const settled = await doc(co, { total: '20.00' });
    const stx = await bankTx(co, '2026-02-02', '-20.00');
    await h.q("INSERT INTO bank_transaction_matches(company_id,bank_transaction_id,document_id,match_type,matched_by_user_id) VALUES($1,$2,$3,'document',$4)", [co.id, stx, settled, co.owner.id]);
    await h.q("INSERT INTO document_settlements(company_id,document_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,20,$4)", [co.id, settled, stx, co.owner.id]);
    const linked = await doc(co, { total: '30.00' });
    const al = await co.owner.client.req('POST', `/custodies/${custody}/documents`, { document_id: linked, amount: '30.00' });
    expect(al.status, JSON.stringify(al.json)).toBe(201);

    const r = await search(co, custody);
    expect(r.status).toBe(200);
    // remaining is now 970.00, so the 1000.00 document no longer fits; cancelled and unconfirmed obligations do not exclude.
    expect(r.ids).toEqual([good, cancelled, unconfirmed].sort());
    expect(atCeiling).toBeTruthy();
    const row = r.body.documents.find((d: { id: string }) => d.id === good);
    expect(row).toMatchObject({ reference_number: 'INV-1', counterparty_name: 'Acme', total_amount: '250.00', document_date: '2026-02-10' });
  });

  it('includes a document equal to the remaining balance', async () => {
    const co = await setup('ceil');
    const custody = await openCustody(co, '-500.00');
    const exact = await doc(co, { total: '500.00' });
    await doc(co, { total: '500.01' });
    expect((await search(co, custody)).ids).toEqual([exact]);
  });

  it('treats %, _, backslash and quotes in the search text literally', async () => {
    const co = await setup('spec');
    const custody = await openCustody(co);
    const pct = await doc(co, { ref: '50%-OFF' });
    const under = await doc(co, { ref: 'A_B' });
    const plain = await doc(co, { ref: 'AXB' });
    const back = await doc(co, { ref: 'C\\D' });
    const quote = await doc(co, { supplier: "O'Brien; DROP TABLE documents;--" });
    expect((await search(co, custody, '%')).ids).toEqual([pct]);
    expect((await search(co, custody, 'A_B')).ids).toEqual([under]);
    expect((await search(co, custody, '\\')).ids).toEqual([back]);
    expect((await search(co, custody, "O'Brien; DROP")).ids).toEqual([quote]);
    expect((await search(co, custody, 'axb')).ids).toEqual([plain]);
    expect(await h.count('SELECT COUNT(*)::text n FROM documents WHERE company_id=$1', [co.id])).toBe(5);
  });

  it('searches by reference, supplier (document name or counterparty record), file name and amount', async () => {
    const co = await setup('fld');
    const custody = await openCustody(co);
    const byRef = await doc(co, { ref: 'REF-777', total: '11.11' });
    const bySup = await doc(co, { supplier: 'Zeta Trading', total: '22.22' });
    const cp = (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Omega Co','supplier',$2) RETURNING id", [co.id, co.owner.id]))[0]!.id;
    const byCp = await doc(co, { total: '33.33' });
    await h.q('UPDATE documents SET counterparty_id=$2 WHERE id=$1', [byCp, cp]);
    const byFile = await doc(co, { file: 'receipt-hotel.pdf', total: '44.44' });
    expect((await search(co, custody, 'ref-777')).ids).toEqual([byRef]);
    expect((await search(co, custody, 'zeta')).ids).toEqual([bySup]);
    expect((await search(co, custody, 'omega')).ids).toEqual([byCp]);
    expect((await search(co, custody, 'hotel')).ids).toEqual([byFile]);
    expect((await search(co, custody, '22.22')).ids).toEqual([bySup]);
    expect((await search(co, custody, 'no-such-thing')).ids).toEqual([]);
  });

  it('never exposes another company documents or custody, and enforces authorization', async () => {
    const a = await setup('isoa');
    const b = await setup('isob');
    const custodyA = await openCustody(a);
    const custodyB = await openCustody(b);
    const docA = await doc(a, { ref: 'SHARED-REF' });
    const docB = await doc(b, { ref: 'SHARED-REF' });
    expect((await search(a, custodyA, 'SHARED-REF')).ids).toEqual([docA]);
    expect((await search(b, custodyB, 'SHARED-REF')).ids).toEqual([docB]);
    // company A user cannot read company B custody even with a valid id (no existence leak: 404)
    expect((await search(a, custodyB)).status).toBe(404);
    // a member of A without custody.manage (view-only) is refused; unauthenticated is refused
    expect((await search(a, custodyA, '', a.recipient.client)).status).toBe(401);
    await a.recipient.client.login();
    expect((await search(a, custodyA, '', a.recipient.client)).status).toBe(403);
    // allocation of a foreign document through the API is still refused by allocate()
    const foreign = await a.owner.client.req('POST', `/custodies/${custodyA}/documents`, { document_id: docB, amount: '100.00' });
    expect(foreign.status).toBe(404);
  });

  it('refuses a closed custody', async () => {
    const co = await setup('cls');
    const custody = await openCustody(co, '-100.00');
    const d = await doc(co, { total: '100.00' });
    expect((await co.owner.client.req('POST', `/custodies/${custody}/documents`, { document_id: d, amount: '100.00' })).status).toBe(201);
    const closed = await co.owner.client.req('POST', `/custodies/${custody}/close`, {});
    expect(closed.status, JSON.stringify(closed.json)).toBe(200);
    expect((await search(co, custody)).status).toBe(409);
  });
});
