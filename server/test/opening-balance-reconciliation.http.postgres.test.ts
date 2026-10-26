import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { ACCOUNTANT_CAPABILITIES, FINANCE_MANAGER_CAPABILITIES } from '../src/modules/memberships/default-role-capabilities';

// C4-P2a: opening balance reconciliation gate over real HTTP + PostgreSQL. Requires a disposable DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;
const BLOCKED = 'OPENING_BALANCE_RECONCILIATION_BLOCKED';

describeDatabase('opening balance reconciliation gate (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  async function setup(label: string) {
    const owner = await h.user(`${label}-own`);
    const accountant = await h.user(`${label}-acc`);
    const manager = await h.user(`${label}-fm`);
    const viewer = await h.user(`${label}-view`);
    const noCap = await h.user(`${label}-none`);
    const id = await h.company(label, owner.id);
    await h.member(id, accountant.id, [...ACCOUNTANT_CAPABILITIES]);
    await h.member(id, manager.id, [...FINANCE_MANAGER_CAPABILITIES]);
    await h.member(id, viewer.id, ['opening_balance.view']);
    await h.member(id, noCap.id, ['obligation.view']);
    for (const u of [owner, accountant, manager, viewer, noCap]) await u.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    await h.q(
      `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,prepared_by_user_id,approved_by_user_id,approved_at)
       VALUES($1,1,'approved','IFRS','SAR','SAR','2025-01-01','not_registered','zakat_applicable','saudi_gcc_only','not_currently_applicable','no','2025-01-01',$2,$2,NOW())`, [id, owner.id]);
    const bankGl = await h.account(id, 'OB-BANK', 'asset', 'current_asset');
    const bankGl2 = await h.account(id, 'OB-BANK2', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=ANY($1::uuid[])", [[bankGl, bankGl2]]);
    const ar = await h.account(id, 'OB-AR', 'asset', 'current_asset');
    const arChild = await h.account(id, 'OB-AR-1', 'asset', 'current_asset');
    await h.q('UPDATE accounts SET parent_account_id=$2 WHERE id=$1', [arChild, ar]);
    const ap = await h.account(id, 'OB-AP', 'liability', 'current_liability');
    const equity = await h.account(id, 'OB-EQ', 'equity', 'equity');
    const other = await h.account(id, 'OB-OTHER', 'asset', 'current_asset');
    for (const [key, acc] of [['receivable', ar], ['payable', ap]] as const) {
      await h.q('INSERT INTO invoice_account_mappings(company_id,mapping_key,account_id,updated_by_user_id) VALUES($1,$2,$3,$4)', [id, key, acc, owner.id]);
    }
    const mkBank = async (name: string, currency = 'SAR') =>
      (await h.q<{ id: string }>('INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,$2,$3,$4) RETURNING id', [id, name, currency, owner.id]))[0]!.id;
    const bank = await mkBank('Main');
    const cp = (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Customer A','customer',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const cp2 = (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Supplier B','supplier',$2) RETURNING id", [id, owner.id]))[0]!.id;
    return { id, fy, owner, accountant, manager, viewer, noCap, bankGl, bankGl2, ar, arChild, ap, equity, other, bank, cp, cp2, mkBank };
  }
  type Co = Awaited<ReturnType<typeof setup>>;

  const link = (co: Co, bank = co.bank, account = co.bankGl, from = '2025-01-01') =>
    h.q('INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,$4,$5)', [co.id, bank, account, from, co.owner.id]);
  const statement = (co: Co, closing: string, bank = co.bank, end = '2025-12-31', status = 'confirmed') =>
    h.q(`INSERT INTO bank_statement_balances(company_id,bank_account_id,currency_code,statement_ref,period_start,period_end,closing_balance,status,confirmed_by,confirmed_at,created_by)
         VALUES($1,$2,'SAR',$3,'2025-12-01',$4,$5,$6,$7,CASE WHEN $6='confirmed' THEN NOW() END,$8)`, [co.id, bank, `S-${randomUUID().slice(0, 6)}`, end, closing, status, status === 'confirmed' ? co.owner.id : null, co.owner.id]);
  const obligation = async (co: Co, direction: 'receivable' | 'payable', amount: string, counterparty = direction === 'receivable' ? co.cp : co.cp2, o: { source_type?: string; recognized_on?: string } = {}) =>
    (await h.q<{ id: string }>(
      `INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,$2,$3,$4,$5,'confirmed',$6,$7) RETURNING id`,
      [co.id, direction, counterparty, amount, o.recognized_on ?? '2026-01-01', o.source_type ?? 'opening_balance', co.owner.id]))[0]!.id;
  const addItem = async (co: Co, body: Record<string, unknown>) => {
    const r = await co.accountant.client.req('POST', `/opening-balances/${co.fy}/items`, { source_type: 'original_document', confidence: 'high', ...body });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.item as { id: string; version: number };
  };
  const bankItem = (co: Co, amount: string, o: Record<string, unknown> = {}) => addItem(co, { category: 'bank', account_id: co.bankGl, amount, balance_side: 'debit', bank_account_id: co.bank, ...o });
  const arItem = (co: Co, amount: string, obligation_id: string | null, o: Record<string, unknown> = {}) =>
    addItem(co, { category: 'receivable', account_id: co.ar, amount, balance_side: 'debit', ...(obligation_id ? { obligation_id, counterparty_id: co.cp } : {}), ...o });
  const balance = (co: Co, amount: string) => addItem(co, { category: 'equity', account_id: co.equity, amount, balance_side: 'credit' });
  /** The real trial-balance import path (the only source of genuine aggregate rows). */
  const importTb = async (co: Co, rows: Array<{ account: string; category: string; debit?: string; credit?: string }>) => {
    const r = await co.accountant.client.req('POST', `/opening-balances/${co.fy}/import`, {
      confirm: true, file_name: 'tb.csv',
      items: rows.map((x, i) => ({ row: i + 1, account_id: x.account, debit: x.debit ?? '0.00', credit: x.credit ?? '0.00', category: x.category })),
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.items as Array<{ id: string; version: number }>;
  };
  const patch = (co: Co, it: { id: string; version: number }, body: Record<string, unknown>) =>
    co.accountant.client.req('PATCH', `/opening-balances/${co.fy}/items/${it.id}`, { version: it.version, ...body });
  const submit = (co: Co) => co.manager.client.req('POST', `/opening-balances/${co.fy}/submit-review`, {});
  const approve = (co: Co) => co.manager.client.req('POST', `/opening-balances/${co.fy}/approve`, {});
  const report = (co: Co) => co.viewer.client.req('GET', `/opening-balances/${co.fy}/reconciliation`);
  const reviewStatus = async (co: Co) => (await h.q<{ status: string }>('SELECT status FROM opening_balance_reviews WHERE company_id=$1', [co.id]))[0]?.status;
  const journals = (co: Co) => h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1', [co.id]);
  const issueCodes = (r: { json: any }) => (r.json.issues as Array<{ code: string }>).map((i) => i.code);

  it('serves a read-only report to opening_balance.view holders only, and writes nothing', async () => {
    const co = await setup('rep');
    await link(co); await statement(co, '1000.00');
    await bankItem(co, '1000.00'); await balance(co, '1000.00');
    const before = [await h.count('SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1', [co.id]), await journals(co), await h.count('SELECT COUNT(*)::text n FROM opening_balance_items WHERE company_id=$1', [co.id])];
    const r = await report(co);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'verified', blocking: false, as_of_date: '2026-01-01', review_status: 'draft' });
    expect(r.json.sections.bank).toMatchObject({ status: 'verified', item_count: 1, gl_total: '1000.00' });
    expect((await co.noCap.client.req('GET', `/opening-balances/${co.fy}/reconciliation`)).status).toBe(403);
    expect([await h.count('SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1', [co.id]), await journals(co), await h.count('SELECT COUNT(*)::text n FROM opening_balance_items WHERE company_id=$1', [co.id])]).toEqual(before);
  });

  it('verified path: allocated bank, several obligations for one counterparty and a child control account submit and approve into one journal', async () => {
    const co = await setup('ok');
    await link(co); await statement(co, '5000.00');
    const o1 = await obligation(co, 'receivable', '100.00'), o2 = await obligation(co, 'receivable', '250.50'), o3 = await obligation(co, 'payable', '40.00');
    await bankItem(co, '5000.00');
    await arItem(co, '100.00', o1); await arItem(co, '250.50', o2, { account_id: co.arChild });
    await addItem(co, { category: 'payable', account_id: co.ap, amount: '40.00', balance_side: 'credit', obligation_id: o3, counterparty_id: co.cp2 });
    await balance(co, '5310.50');
    const rep = await report(co);
    expect(rep.json.status, JSON.stringify(rep.json.issues)).toBe('verified');
    expect(rep.json.sections.receivable).toMatchObject({ gl_total: '350.50', subledger_total: '350.50' });
    expect((await submit(co)).status).toBe(200);
    expect((await approve(co)).status).toBe(200);
    expect(await reviewStatus(co)).toBe('approved');
    expect(await journals(co)).toBe(1);
  });

  it('aggregate-only trial balance items stay supported: reported as incomplete evidence, never blocking', async () => {
    const co = await setup('agg');
    await importTb(co, [
      { account: co.bankGl, category: 'bank', debit: '700.00' }, { account: co.ar, category: 'receivable', debit: '300.00' }, { account: co.equity, category: 'equity', credit: '1000.00' },
    ]);
    await obligation(co, 'receivable', '50.00'); // a live opening obligation exists but the rows are aggregate-only
    const rep = await report(co);
    expect(rep.json.status).toBe('incomplete_evidence');
    expect(rep.json.blocking).toBe(false);
    expect(issueCodes(rep)).toEqual(expect.arrayContaining(['OB_BANK_AGGREGATE_ONLY', 'OB_SUBLEDGER_AGGREGATE_ONLY', 'OB_SUBLEDGER_UNLINKED_OBLIGATION', 'OB_SUBLEDGER_TOTAL_DIFFERENCE']));
    expect(issueCodes(rep)).not.toContain('OB_REFERENCE_MISSING');
    expect((await submit(co)).status).toBe(200);
    expect((await approve(co)).status).toBe(200);
    expect(await journals(co)).toBe(1);
  });

  it('blocks submission on a one-halala bank mismatch with stable issue details, then allows it once corrected', async () => {
    const co = await setup('cent');
    await link(co); await statement(co, '1000.00');
    const b = await bankItem(co, '1000.01'); await balance(co, '1000.01');
    const r = await submit(co);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: BLOCKED, status: 'mismatch' });
    expect(r.json.issues[0]).toMatchObject({ code: 'OB_BANK_AMOUNT_MISMATCH', class: 'mismatch', section: 'bank', item_id: b.id, detail: { expected: '1000.00', actual: '1000.01', difference: '0.01' } });
    expect(await reviewStatus(co)).toBe('draft');
    expect(await journals(co)).toBe(0);
    const fix = await co.accountant.client.req('PATCH', `/opening-balances/${co.fy}/items/${b.id}`, { version: b.version, amount: '1000.00' });
    expect(fix.status).toBe(200);
    const eq = (await h.q<{ id: string; version: number }>("SELECT id,version FROM opening_balance_items WHERE company_id=$1 AND category='equity'", [co.id]))[0]!;
    expect((await co.accountant.client.req('PATCH', `/opening-balances/${co.fy}/items/${eq.id}`, { version: eq.version, amount: '1000.00' })).status).toBe(200);
    expect((await submit(co)).status).toBe(200);
  });

  it('blocks duplicate bank references and duplicate obligation references', async () => {
    const co = await setup('dup');
    await link(co); await statement(co, '100.00');
    await bankItem(co, '100.00'); await bankItem(co, '100.00');
    const o = await obligation(co, 'receivable', '100.00');
    await arItem(co, '100.00', o); await arItem(co, '100.00', o);
    await balance(co, '400.00');
    const r = await submit(co);
    expect(r.status).toBe(409);
    expect(r.json.status).toBe('blocked');
    const codes = issueCodes(r);
    expect(codes.filter((c) => c === 'OB_BANK_DUPLICATE')).toHaveLength(2);
    expect(codes.filter((c) => c === 'OB_OBLIGATION_DUPLICATE')).toHaveLength(2);
  });

  it('validates the bank-to-GL link on the fiscal year start date', async () => {
    const none = await setup('lnk0');
    await bankItem(none, '10.00'); await balance(none, '10.00');
    expect(issueCodes(await submit(none))).toContain('OB_BANK_LEDGER_LINK_MISSING');
    const wrong = await setup('lnk1');
    await link(wrong, wrong.bank, wrong.bankGl2);
    await bankItem(wrong, '10.00'); await balance(wrong, '10.00');
    expect(issueCodes(await submit(wrong))).toContain('OB_BANK_ACCOUNT_GL_MISMATCH');
    const late = await setup('lnk2');
    await link(late, late.bank, late.bankGl, '2026-01-02');
    await bankItem(late, '10.00'); await balance(late, '10.00');
    expect(issueCodes(await submit(late))).toContain('OB_BANK_LEDGER_LINK_MISSING');
    expect(await journals(late)).toBe(0);
  });

  it('validates obligation ownership, status, direction, counterparty and control account', async () => {
    const co = await setup('obl');
    const other = await setup('obl-x');
    const foreign = await obligation(other, 'receivable', '10.00');
    // the item API itself rejects another company's obligation
    const cross = await co.accountant.client.req('POST', `/opening-balances/${co.fy}/items`, { category: 'receivable', account_id: co.ar, amount: '10.00', balance_side: 'debit', obligation_id: foreign, source_type: 'original_document', confidence: 'high' });
    expect(cross.status).toBe(400);
    const cancelled = await obligation(co, 'receivable', '10.00');
    const docBased = await obligation(co, 'receivable', '20.00', co.cp, { source_type: 'manual' });
    const wrongDir = await obligation(co, 'payable', '30.00');
    const good = await obligation(co, 'receivable', '40.00');
    await arItem(co, '10.00', cancelled); await arItem(co, '20.00', docBased); await arItem(co, '30.00', wrongDir);
    await arItem(co, '40.00', good, { counterparty_id: co.cp2 });
    await arItem(co, '40.00', null, { obligation_id: good, counterparty_id: null, account_id: co.other });
    await h.q('UPDATE obligations SET is_cancelled=true WHERE id=$1', [cancelled]);
    const rep = await report(co);
    expect(rep.json.status).toBe('blocked');
    expect(issueCodes(rep)).toEqual(expect.arrayContaining(['OB_OBLIGATION_INVALID', 'OB_OBLIGATION_NOT_OPENING', 'OB_OBLIGATION_DIRECTION_MISMATCH', 'OB_COUNTERPARTY_MISMATCH', 'OB_CONTROL_ACCOUNT_MISMATCH', 'OB_OBLIGATION_DUPLICATE']));
    expect((await submit(co)).status).toBe(409);
    expect(await reviewStatus(co)).toBe('draft');
  });

  it('reports a one-halala receivable difference and an obligation left out of the review', async () => {
    const co = await setup('arcent');
    const o1 = await obligation(co, 'receivable', '100.00'), o2 = await obligation(co, 'receivable', '30.00');
    await arItem(co, '99.99', o1); await balance(co, '99.99');
    const rep = await report(co);
    expect(rep.json.status).toBe('mismatch');
    expect(issueCodes(rep)).toEqual(expect.arrayContaining(['OB_OBLIGATION_AMOUNT_MISMATCH', 'OB_SUBLEDGER_TOTAL_DIFFERENCE', 'OB_SUBLEDGER_UNLINKED_OBLIGATION']));
    const total = rep.json.issues.find((i: any) => i.code === 'OB_SUBLEDGER_TOTAL_DIFFERENCE');
    expect(total.class).toBe('incomplete_evidence');
    expect(total.detail).toEqual({ gl_total: '99.99', subledger_total: '130.00', difference: '-30.01' });
    expect(o2).toBeTruthy();
    expect((await submit(co)).json.code).toBe(BLOCKED);
  });

  it('a removed obligation reference neither becomes an aggregate nor hides an amount difference', async () => {
    const co = await setup('rmref');
    const o1 = await obligation(co, 'receivable', '100.00');
    const o2 = await obligation(co, 'receivable', '250.00', co.cp2);
    const a = await arItem(co, '100.00', o1);
    const b = await addItem(co, { category: 'receivable', account_id: co.ar, amount: '250.00', balance_side: 'debit', obligation_id: o2, counterparty_id: co.cp2 });
    await balance(co, '350.00');
    expect((await report(co)).json.status).toBe('verified');
    // strip the reference only: the item is a missing reference (incomplete), not a legitimate aggregate, and the section cannot be verified
    const stripped = await patch(co, b, { obligation_id: null });
    expect(stripped.status).toBe(200);
    const rep = await report(co);
    expect(rep.json.status).toBe('incomplete_evidence');
    expect(rep.json.sections.receivable.status).toBe('incomplete_evidence');
    expect(issueCodes(rep)).toContain('OB_REFERENCE_MISSING');
    expect(issueCodes(rep)).not.toContain('OB_SUBLEDGER_AGGREGATE_ONLY');
    // strip the reference and change the amount: the implied pairing still exposes the one-halala difference and blocks
    const both = await patch(co, { id: b.id, version: stripped.json.item?.version ?? stripped.json.version }, { amount: '250.01' });
    expect(both.status).toBe(200);
    await balance(co, '0.01');
    const blocked = await submit(co);
    expect(blocked.status).toBe(409);
    expect(blocked.json).toMatchObject({ code: BLOCKED, status: 'mismatch' });
    expect(blocked.json.issues.find((i: any) => i.code === 'OB_OBLIGATION_AMOUNT_MISMATCH')).toMatchObject({ item_id: b.id, detail: { expected: '250.00', actual: '250.01', difference: '0.01', inferred: 'true' } });
    expect(await reviewStatus(co)).toBe('draft');
    expect(a.id).toBeTruthy();
  });

  it('a removed bank account reference keeps the statement comparison through the linked GL account', async () => {
    const co = await setup('rmbank');
    await link(co); await statement(co, '1000.00');
    const b = await bankItem(co, '1000.00'); await balance(co, '1000.00');
    const stripped = await patch(co, b, { bank_account_id: null, amount: '1000.01' });
    expect(stripped.status).toBe(200);
    const rep = await report(co);
    expect(rep.json.status).toBe('mismatch');
    expect(issueCodes(rep)).toEqual(expect.arrayContaining(['OB_REFERENCE_MISSING', 'OB_BANK_AMOUNT_MISMATCH']));
    expect(issueCodes(rep)).not.toContain('OB_BANK_AGGREGATE_ONLY');
    expect((await submit(co)).status).toBe(409);
  });

  it('only an untouched import row is an aggregate: an edited row, or a hand-entered item copying the import text, is not', async () => {
    const co = await setup('prov');
    await link(co); await statement(co, '1000.00');
    const rows = await importTb(co, [
      { account: co.bankGl, category: 'bank', debit: '1000.00' }, { account: co.equity, category: 'equity', credit: '1000.00' },
    ]);
    const clean = await report(co);
    expect(issueCodes(clean)).toEqual(['OB_BANK_AGGREGATE_ONLY']);
    // an edit raises the version and removes the aggregate standing; the wrong amount is now compared against the statement
    expect((await patch(co, rows[0]!, { amount: '1000.01' })).status).toBe(200);
    const edited = await report(co);
    expect(issueCodes(edited)).toEqual(expect.arrayContaining(['OB_REFERENCE_MISSING', 'OB_BANK_AMOUNT_MISMATCH']));
    expect(issueCodes(edited)).not.toContain('OB_BANK_AGGREGATE_ONLY');

    const forged = await setup('prov2');
    await link(forged); await statement(forged, '1000.00');
    await addItem(forged, { category: 'bank', account_id: forged.bankGl, amount: '1000.01', balance_side: 'debit', source_type: 'internal_ledger', confidence: 'medium', source_reference: 'import:tb.csv:row 1' });
    await balance(forged, '1000.01');
    const f = await report(forged);
    expect(f.json.status).toBe('mismatch');
    expect(issueCodes(f)).not.toContain('OB_BANK_AGGREGATE_ONLY');
  });

  it('a category with no items is incomplete evidence, never a confirmed mismatch', async () => {
    const co = await setup('zero');
    await obligation(co, 'receivable', '100.00');
    await addItem(co, { category: 'other_asset', account_id: co.other, amount: '10.00', balance_side: 'debit' }); await balance(co, '10.00');
    const rep = await report(co);
    expect(rep.json.status).toBe('incomplete_evidence');
    expect(rep.json.blocking).toBe(false);
    expect(issueCodes(rep)).toEqual(expect.arrayContaining(['OB_SUBLEDGER_TOTAL_DIFFERENCE', 'OB_SUBLEDGER_UNLINKED_OBLIGATION']));
    expect((await submit(co)).status).toBe(200);
  });

  it('does not compare a bank account in another currency, and never treats a running balance as the opening balance', async () => {
    const co = await setup('fx');
    const usd = await co.mkBank('Dollar', 'USD');
    await link(co, usd);
    await h.q(`INSERT INTO bank_statement_balances(company_id,bank_account_id,currency_code,statement_ref,period_start,period_end,closing_balance,status,confirmed_by,confirmed_at,created_by)
               VALUES($1,$2,'USD','S-USD','2025-12-01','2025-12-31',250.00,'confirmed',$3,NOW(),$3)`, [co.id, usd, co.owner.id]);
    await bankItem(co, '900.00', { bank_account_id: usd }); await balance(co, '900.00');
    const rep = await report(co);
    expect(rep.json.status).toBe('incomplete_evidence');
    expect(issueCodes(rep)).toEqual(['OB_BANK_CURRENCY_NOT_COMPARABLE']);
    expect((await submit(co)).status).toBe(200);

    const run = await setup('run');
    await link(run);
    const batch = (await h.q<{ id: string }>(
      "INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id",
      [run.id, run.bank, `k-${randomUUID()}`, run.owner.id]))[0]!.id;
    await h.q(`INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength,running_balance)
               VALUES($1,$2,$3,'2026-01-01',10,'SAR',1,$4,'strong',500.00)`, [run.id, run.bank, batch, `fp-${randomUUID()}`]);
    await bankItem(run, '500.00'); await balance(run, '500.00');
    const r2 = await report(run);
    expect(r2.json.status).toBe('incomplete_evidence');
    expect(issueCodes(r2)).toEqual(['OB_BANK_EVIDENCE_MISSING']);
    // a draft or superseded statement, or one that does not end the day before the start date, is not evidence either
    await statement(run, '500.00', run.bank, '2025-12-30'); await statement(run, '500.00', run.bank, '2025-12-31', 'draft');
    expect(issueCodes(await report(run))).toEqual(['OB_BANK_EVIDENCE_MISSING']);
  });

  it('revalidates at approval: data changed after submission stops the approval without any posting', async () => {
    const co = await setup('reval');
    const o = await obligation(co, 'receivable', '100.00');
    await arItem(co, '100.00', o); await balance(co, '100.00');
    expect((await submit(co)).status).toBe(200);
    await h.q('UPDATE obligations SET is_cancelled=true WHERE id=$1', [o]);
    const r = await approve(co);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: BLOCKED, status: 'blocked' });
    expect(issueCodes(r)).toContain('OB_OBLIGATION_INVALID');
    expect(await reviewStatus(co)).toBe('in_review');
    expect(await journals(co)).toBe(0);
  });

  it('leaves existing guards untouched: a closed fiscal year still stops approval, and an approved review stays immutable', async () => {
    const closed = await setup('closed');
    await bankItem(closed, '10.00', { bank_account_id: null }); await balance(closed, '10.00');
    expect((await submit(closed)).status).toBe(200);
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [closed.fy]);
    const r = await approve(closed);
    expect(r.status).toBe(409);
    expect(r.json.code).not.toBe(BLOCKED);
    expect(await journals(closed)).toBe(0);

    const ok = await setup('immut');
    await bankItem(ok, '10.00', { bank_account_id: null }); await balance(ok, '10.00');
    expect((await submit(ok)).status).toBe(200);
    expect((await approve(ok)).status).toBe(200);
    const snapshot = await h.q('SELECT id,amount,version FROM opening_balance_items WHERE company_id=$1 ORDER BY id', [ok.id]);
    const rep = await report(ok);
    expect(rep.status).toBe(200);
    expect(rep.json.review_status).toBe('approved');
    expect(await h.q('SELECT id,amount,version FROM opening_balance_items WHERE company_id=$1 ORDER BY id', [ok.id])).toEqual(snapshot);
    expect(await journals(ok)).toBe(1);
  });

  it('concurrent approvals produce exactly one journal', async () => {
    const co = await setup('conc');
    await link(co); await statement(co, '300.00');
    const o = await obligation(co, 'receivable', '70.00');
    await bankItem(co, '300.00'); await arItem(co, '70.00', o); await balance(co, '370.00');
    expect((await submit(co)).status).toBe(200);
    const results = await Promise.all([approve(co), approve(co), approve(co)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await journals(co)).toBe(1);
    expect(await reviewStatus(co)).toBe('approved');
  });
});
