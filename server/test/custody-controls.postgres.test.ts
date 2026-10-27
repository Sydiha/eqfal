import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { UNRESOLVED_BANK_TRANSACTION_SQL } from '../src/modules/banking/bank-reconciliation-core';

// D4/Q5: custody ledger account mapping, journal posting controls, actual recipient and funding unlink (migration 101) over real HTTP + PostgreSQL.
// Requires a disposable DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('custody accounting controls (PostgreSQL)', () => {
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
  const mapAccount = (co: Co, account_id: string) => co.owner.client.req('PUT', '/custody/account-mapping', { account_id });
  const newCustody = (co: Co, tx: string, recipient = co.recipient.id) => co.owner.client.req('POST', '/custodies', { bank_transaction_id: tx, purpose: 'ops', recipient_user_id: recipient });
  const matchOf = async (tx: string, type = 'custody_funding') => (await h.q<{ id: string }>('SELECT id FROM bank_transaction_matches WHERE bank_transaction_id=$1 AND match_type=$2', [tx, type]))[0]!.id;
  async function journal(co: Co, type: string, sourceId: string, date: string, lines: Array<[string, string, string]>) {
    const created = await co.owner.client.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: date, description: 'Custody', source_type: type, source_id: sourceId });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const put = await co.owner.client.req('PUT', `/journals/${created.json.id}/lines`, { lines: lines.map(([account_id, debit, credit]) => ({ account_id, debit, credit, memo: null })) });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    return created.json.id as string;
  }
  const post = (co: Co, j: string) => co.owner.client.req('POST', `/journals/${j}/post`, {});

  it('records the actual selected recipient, separately from the creator, and rejects non-members', async () => {
    const co = await setup('rcp');
    const tx = await bankTx(co, '2026-02-01', '-1000.00');
    expect((await co.owner.client.req('POST', '/custodies', { bank_transaction_id: tx, purpose: 'x' })).status).toBe(400);
    expect((await newCustody(co, tx, co.outsider.id)).status).toBe(400);
    expect(await h.count('SELECT COUNT(*)::text n FROM custody_advances WHERE company_id=$1', [co.id])).toBe(0);
    const ok = await newCustody(co, tx);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.custody.recipient_user_id).toBe(co.recipient.id);
    expect(ok.json.custody.holder_user_id).toBe(co.recipient.id);
    expect(ok.json.custody.created_by_user_id).toBe(co.owner.id);
    expect(ok.json.custody.recipient_email).toBe(co.recipient.email);
    const audit = await h.q<{ after_data: Record<string, unknown> }>("SELECT after_data FROM audit_log WHERE company_id=$1 AND action='custody.create'", [co.id]);
    expect(audit[0]!.after_data).toMatchObject({ recipient_user_id: co.recipient.id, created_by_user_id: co.owner.id });
    // a recipient from another company is never accepted
    const other = await setup('rcp-b');
    const tx2 = await bankTx(co, '2026-02-02', '-50.00');
    expect((await newCustody(co, tx2, other.recipient.id)).status).toBe(400);
  });

  it('leaves existing custody rows without a guessed recipient', async () => {
    const co = await setup('legacy');
    const tx = await bankTx(co, '2026-02-01', '-100.00');
    const c = (await h.q<{ id: string }>("INSERT INTO custody_advances(company_id,holder_user_id,purpose,created_by_user_id) VALUES($1,$2,'old',$2) RETURNING id", [co.id, co.owner.id]))[0]!.id;
    await h.q("INSERT INTO bank_transaction_matches(company_id,bank_transaction_id,custody_id,match_type,matched_by_user_id) VALUES($1,$2,$3,'custody_funding',$4)", [co.id, tx, c, co.owner.id]);
    const detail = await co.owner.client.req('GET', `/custodies/${c}`);
    expect(detail.status).toBe(200);
    expect(detail.json.custody.recipient_user_id).toBeNull();
    expect(detail.json.custody.holder_user_id).toBe(co.owner.id);
  });

  it('configures only an eligible current-asset custody account, and only with custody.close', async () => {
    const co = await setup('map');
    expect((await co.owner.client.req('GET', '/custody/account-mapping')).json.mapping).toBeNull();
    for (const bad of [co.expense, co.payable, co.fixedAssetGl, co.bankGl, randomUUID()]) expect((await mapAccount(co, bad)).status).toBe(400);
    const other = await setup('map-b');
    expect((await mapAccount(co, other.custodyGl)).status).toBe(400);
    expect((await co.recipient.client.req('PUT', '/custody/account-mapping', { account_id: co.custodyGl })).status).toBe(401);
    await co.recipient.client.login();
    expect((await co.recipient.client.req('PUT', '/custody/account-mapping', { account_id: co.custodyGl })).status).toBe(403);
    const ok = await mapAccount(co, co.custodyGl);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.mapping).toMatchObject({ account_id: co.custodyGl, valid: true });
    const read = await co.owner.client.req('GET', '/custody/account-mapping');
    expect(read.json.accounts.map((a: { id: string }) => a.id)).toContain(co.custodyGl);
    expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='custody.account_mapping.set'", [co.id])).toBe(1);
    // no mapping leaks across companies
    expect((await other.owner.client.req('GET', '/custody/account-mapping')).json.mapping).toBeNull();
  });

  it('posts funding, allocation and return journals only with the configured accounts, directions and exact amounts', async () => {
    const co = await setup('post');
    const out = await bankTx(co, '2026-02-01', '-1000.00');
    const back = await bankTx(co, '2026-03-01', '300.00');
    const created = await newCustody(co, out);
    const custodyId = created.json.custody.id as string;
    const fundingMatch = await matchOf(out);
    // before any mapping, nothing posts
    const unmapped = await journal(co, 'custody_funding', fundingMatch, '2026-02-01', [[co.custodyGl, '1000.00', '0'], [co.bankGl, '0', '1000.00']]);
    const r0 = await post(co, unmapped);
    expect(r0.status).toBe(400);
    expect(JSON.stringify(r0.json)).toContain('Custody ledger account is not configured');
    await h.q("DELETE FROM journal_lines WHERE journal_entry_id=$1", [unmapped]);
    await h.q('DELETE FROM journal_entries WHERE id=$1', [unmapped]);
    expect((await mapAccount(co, co.custodyGl)).status).toBe(200);

    // funding: expense debit, reversed direction, wrong bank account, wrong custody account are all refused
    for (const lines of [
      [[co.expense, '1000.00', '0'], [co.bankGl, '0', '1000.00']],
      [[co.bankGl, '1000.00', '0'], [co.custodyGl, '0', '1000.00']],
      [[co.custodyGl, '1000.00', '0'], [co.otherBankGl, '0', '1000.00']],
      [[co.fixedAssetGl, '1000.00', '0'], [co.bankGl, '0', '1000.00']],
      [[co.custodyGl, '1000.00', '0'], [co.bankGl, '0', '900.00'], [co.expense, '0', '100.00']],
    ] as Array<Array<[string, string, string]>>) {
      const j = await journal(co, 'custody_funding', fundingMatch, '2026-02-01', lines);
      const refused = await post(co, j);
      expect(refused.status, JSON.stringify(lines)).toBe(400);
      expect(JSON.stringify(refused.json)).toMatch(/Custody funding journal|Journal total|not linked/);
      await h.q('DELETE FROM journal_lines WHERE journal_entry_id=$1', [j]);
      await h.q('DELETE FROM journal_entries WHERE id=$1', [j]);
    }

    const fundJ = await journal(co, 'custody_funding', fundingMatch, '2026-02-01', [[co.custodyGl, '1000.00', '0'], [co.bankGl, '0', '1000.00']]);
    expect((await post(co, fundJ)).status).toBe(200);

    // allocation: must credit the custody account by exactly the amount; the other side is the expense
    const doc = await expenseDoc(co, '400.00');
    const alloc = await co.owner.client.req('POST', `/custodies/${custodyId}/documents`, { document_id: doc, amount: '400.00' });
    expect(alloc.status, JSON.stringify(alloc.json)).toBe(201);
    const allocationId = alloc.json.allocations[0].id as string;
    const bad = await journal(co, 'custody_allocation', allocationId, '2026-02-10', [[co.expense, '400.00', '0'], [co.bankGl, '0', '400.00']]);
    const rb = await post(co, bad);
    expect(rb.status).toBe(400);
    expect(JSON.stringify(rb.json)).toContain('credit the custody ledger account');
    await h.q('DELETE FROM journal_lines WHERE journal_entry_id=$1', [bad]);
    await h.q('DELETE FROM journal_entries WHERE id=$1', [bad]);
    const split = await journal(co, 'custody_allocation', allocationId, '2026-02-10', [[co.expense, '400.00', '0'], [co.custodyGl, '0', '300.00'], [co.payable, '0', '100.00']]);
    expect((await post(co, split)).status).toBe(400);
    await h.q('DELETE FROM journal_lines WHERE journal_entry_id=$1', [split]);
    await h.q('DELETE FROM journal_entries WHERE id=$1', [split]);
    const good = await journal(co, 'custody_allocation', allocationId, '2026-02-10', [[co.expense, '400.00', '0'], [co.custodyGl, '0', '400.00']]);
    expect((await post(co, good)).status).toBe(200);

    // return: Dr bank / Cr custody only
    const ret = await co.owner.client.req('POST', `/custodies/${custodyId}/returns`, { bank_transaction_id: back });
    expect(ret.status, JSON.stringify(ret.json)).toBe(201);
    const returnMatch = await matchOf(back, 'custody_return');
    const reversed = await journal(co, 'custody_return', returnMatch, '2026-03-01', [[co.custodyGl, '300.00', '0'], [co.bankGl, '0', '300.00']]);
    expect((await post(co, reversed)).status).toBe(400);
    await h.q('DELETE FROM journal_lines WHERE journal_entry_id=$1', [reversed]);
    await h.q('DELETE FROM journal_entries WHERE id=$1', [reversed]);
    const retJ = await journal(co, 'custody_return', returnMatch, '2026-03-01', [[co.bankGl, '300.00', '0'], [co.custodyGl, '0', '300.00']]);
    expect((await post(co, retJ)).status).toBe(200);

    // custody account balance equals the outstanding custody balance: 1000 - 400 - 300 = 300
    const bal = (await h.q<{ n: string }>("SELECT COALESCE(SUM(l.debit-l.credit),0)::text n FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE l.account_id=$1 AND j.status='posted'", [co.custodyGl]))[0]!.n;
    expect(Number(bal)).toBe(300);
    const detail = await co.owner.client.req('GET', `/custodies/${custodyId}`);
    expect(detail.json.remaining_amount).toBe('300.00');
    // posted journals are never rewritten when the mapping is later touched; changing it after posting is refused
    expect((await mapAccount(co, co.custodyGl)).status).toBe(200);
    const spare = await h.account(co.id, 'post-CUST2', 'asset', 'current_asset');
    expect((await mapAccount(co, spare)).status).toBe(409);
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND status='posted' AND source_type LIKE 'custody_%'", [co.id])).toBe(3);
  });

  it('does not re-check or alter custody journals posted before the controls existed', async () => {
    const co = await setup('hist');
    const tx = await bankTx(co, '2026-02-01', '-100.00');
    const c = await newCustody(co, tx);
    const m = await matchOf(tx);
    // historic fixture: posted against arbitrary accounts, no custody mapping configured
    const jid = await h.postedJournal(co.id, co.fy, '2026-02-01', co.owner.id, [[co.expense, '100.00', '0'], [co.bankGl, '0', '100.00']], { source_type: 'custody_funding', source_id: m });
    await mapAccount(co, co.custodyGl);
    const lines = await h.q('SELECT account_id,debit::text,credit::text FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence', [jid]);
    expect(lines.map((l) => l.account_id)).toEqual([co.expense, co.bankGl]);
    expect((await h.q<{ status: string }>('SELECT status FROM journal_entries WHERE id=$1', [jid]))[0]!.status).toBe('posted');
    expect(c.status).toBe(201);
  });

  it('unlinks an incorrectly linked funding only while nothing depends on it, with authorization, reason and audit', async () => {
    const co = await setup('unl');
    await mapAccount(co, co.custodyGl);
    const tx = await bankTx(co, '2026-02-01', '-500.00');
    const c = (await newCustody(co, tx)).json.custody.id as string;
    expect(await h.count(`SELECT COUNT(*)::text n FROM bank_transactions t WHERE t.id=$1 AND ${UNRESOLVED_BANK_TRANSACTION_SQL}`, [tx])).toBe(0);
    await co.recipient.client.login();
    expect((await co.recipient.client.req('DELETE', `/custodies/${c}/funding`, { reason: 'wrong' })).status).toBe(403);
    expect((await co.owner.client.req('DELETE', `/custodies/${c}/funding`, {})).status).toBe(400);
    // dependent allocation blocks
    const doc = await expenseDoc(co, '100.00');
    const alloc = await co.owner.client.req('POST', `/custodies/${c}/documents`, { document_id: doc, amount: '100.00' });
    expect((await co.owner.client.req('DELETE', `/custodies/${c}/funding`, { reason: 'wrong' })).status).toBe(409);
    await co.owner.client.req('DELETE', `/custodies/${c}/documents/${alloc.json.allocations[0].id}`, { reason: 'undo' });
    // a journal of any status blocks
    const j = await journal(co, 'custody_funding', await matchOf(tx), '2026-02-01', [[co.custodyGl, '500.00', '0'], [co.bankGl, '0', '500.00']]);
    expect((await co.owner.client.req('DELETE', `/custodies/${c}/funding`, { reason: 'wrong' })).status).toBe(409);
    await h.q('DELETE FROM journal_lines WHERE journal_entry_id=$1', [j]);
    await h.q('DELETE FROM journal_entries WHERE id=$1', [j]);
    // a reconciled bank row blocks
    await h.q("UPDATE bank_transactions SET reconciliation_status='reconciled',reconciled_by_user_id=$2,reconciled_at=NOW() WHERE id=$1", [tx, co.owner.id]);
    expect((await co.owner.client.req('DELETE', `/custodies/${c}/funding`, { reason: 'wrong' })).status).toBe(409);
    await h.q("UPDATE bank_transactions SET reconciliation_status='matched',reconciled_by_user_id=NULL,reconciled_at=NULL WHERE id=$1", [tx]);
    // another company cannot touch it
    const other = await setup('unl-b');
    expect((await other.owner.client.req('DELETE', `/custodies/${c}/funding`, { reason: 'wrong' })).status).toBe(404);
    // the correction itself
    const ok = await co.owner.client.req('DELETE', `/custodies/${c}/funding`, { reason: 'linked to the wrong transfer' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await h.count('SELECT COUNT(*)::text n FROM custody_advances WHERE id=$1', [c])).toBe(0);
    expect(await h.count('SELECT COUNT(*)::text n FROM bank_transaction_matches WHERE bank_transaction_id=$1', [tx])).toBe(0);
    expect((await h.q<{ s: string }>('SELECT reconciliation_status s FROM bank_transactions WHERE id=$1', [tx]))[0]!.s).toBe('unmatched');
    // the transfer is unexplained again (blocks closing) until a correct workflow explains it
    expect(await h.count(`SELECT COUNT(*)::text n FROM bank_transactions t WHERE t.id=$1 AND ${UNRESOLVED_BANK_TRANSACTION_SQL}`, [tx])).toBe(1);
    expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='custody.funding.unlink'", [co.id])).toBe(1);
    // a second unlink finds nothing; the freed transfer can be re-used
    expect((await co.owner.client.req('DELETE', `/custodies/${c}/funding`, { reason: 'again' })).status).toBe(404);
    expect((await newCustody(co, tx)).status).toBe(201);
  });

  it('serializes concurrent unlinks and an unlink racing an allocation', async () => {
    const co = await setup('race');
    const tx = await bankTx(co, '2026-02-01', '-500.00');
    const c = (await newCustody(co, tx)).json.custody.id as string;
    const results = await Promise.all([1, 2, 3].map(() => co.owner.client.req('DELETE', `/custodies/${c}/funding`, { reason: 'wrong' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(2);

    const tx2 = await bankTx(co, '2026-02-02', '-500.00');
    const c2 = (await newCustody(co, tx2)).json.custody.id as string;
    const doc = await expenseDoc(co, '100.00');
    const [a, u] = await Promise.all([
      co.owner.client.req('POST', `/custodies/${c2}/documents`, { document_id: doc, amount: '100.00' }),
      co.owner.client.req('DELETE', `/custodies/${c2}/funding`, { reason: 'wrong' }),
    ]);
    const custodyExists = await h.count('SELECT COUNT(*)::text n FROM custody_advances WHERE id=$1', [c2]);
    const allocations = await h.count('SELECT COUNT(*)::text n FROM custody_document_allocations WHERE custody_id=$1', [c2]);
    // either the allocation won (unlink refused, custody intact) or the unlink won (no custody, no orphan allocation); never both
    expect(allocations === 0 || custodyExists === 1).toBe(true);
    if (u.status === 200) expect([404, 409]).toContain(a.status); else expect(u.status).toBe(409);
  });
});
