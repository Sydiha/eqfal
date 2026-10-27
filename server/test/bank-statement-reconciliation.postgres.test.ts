import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// T2 / G3 bank statement ending-balance reconciliation over real HTTP + PostgreSQL (migration 088). Requires a disposable DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('bank statement reconciliation (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  let rowNo = 0;

  async function setup(label: string, opts: { currency?: string } = {}) {
    const owner = await h.user(`${label}-own`);
    const clerk = await h.user(`${label}-clerk`);       // prepares statements, cannot confirm
    const approver = await h.user(`${label}-appr`);     // confirms, cannot prepare
    const viewer = await h.user(`${label}-view`);
    const id = await h.company(label, owner.id);
    await h.member(id, clerk.id, ['bank.view', 'bank.statement.manage']);
    await h.member(id, approver.id, ['bank.view', 'bank.statement.confirm']);
    await h.member(id, viewer.id, ['bank.view']);
    for (const u of [owner, clerk, approver, viewer]) await u.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    await h.db.query(
      `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,prepared_by_user_id,approved_by_user_id,approved_at)
       VALUES($1,1,'approved','IFRS','SAR','SAR','2025-01-01','not_registered','zakat_applicable','saudi_gcc_only','not_currently_applicable','no','2025-01-01',$2,$2,NOW())`, [id, owner.id]);
    const bankGl = await h.account(id, 'B-BANK', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [bankGl]);
    const otherGl = await h.account(id, 'B-OTHER', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [otherGl]);
    const nonCash = await h.account(id, 'B-AR', 'asset', 'current_asset');
    const equity = await h.account(id, 'E-CAP', 'equity', 'equity');
    const bank = (await h.q<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main',$2,$3) RETURNING id", [id, opts.currency ?? 'SAR', owner.id]))[0]!.id;
    const batch = (await h.q<{ id: string }>(
      "INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id",
      [id, bank, `k-${randomUUID()}`, owner.id]))[0]!.id;
    return { id, owner, clerk, approver, viewer, fy, bankGl, otherGl, nonCash, equity, bank, batch };
  }
  type Co = Awaited<ReturnType<typeof setup>>;

  async function bankTx(co: Co, date: string, amount: string) {
    rowNo += 1;
    return (await h.q<{ id: string }>(
      "INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,$4,$5,'SAR',$6,$7,'strong') RETURNING id",
      [co.id, co.bank, co.batch, date, amount, rowNo, `fp-${randomUUID()}`]))[0]!.id;
  }
  async function link(co: Co, from = '2026-01-01') {
    const r = await co.owner.client.req('POST', '/bank-ledger-links', { bank_account_id: co.bank, account_id: co.bankGl, valid_from: from });
    expect(r.status).toBe(201);
    return r.json.id as string;
  }
  /** GL receipt (debit bank) or payment (credit bank), optionally tied to an imported bank row through a document settlement. */
  async function glEntry(co: Co, date: string, amount: string, direction: 'in' | 'out', settlementBankTx?: string) {
    let source: { source_type?: string; source_id?: string } = {};
    if (settlementBankTx) {
      const doc = (await h.q<{ id: string }>(
        "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount) VALUES($1,$2,'inv.pdf','application/pdf',10,$3,$4,'approved',$5,$6,$7) RETURNING id",
        [co.id, co.owner.id, `d-${randomUUID()}`, 'a'.repeat(64), direction === 'in' ? 'sale' : 'purchase', date, amount]))[0]!.id;
      await h.q("INSERT INTO bank_transaction_matches(company_id,bank_transaction_id,document_id,match_type,matched_by_user_id) VALUES($1,$2,$3,'document',$4)", [co.id, settlementBankTx, doc, co.owner.id]);
      const settlement = (await h.q<{ id: string }>(
        'INSERT INTO document_settlements(company_id,document_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [co.id, doc, settlementBankTx, amount, co.owner.id]))[0]!.id;
      source = { source_type: 'document_settlement', source_id: settlement };
    }
    const lines: Array<[string, string, string]> = direction === 'in' ? [[co.bankGl, amount, '0'], [co.equity, '0', amount]] : [[co.equity, amount, '0'], [co.bankGl, '0', amount]];
    return h.postedJournal(co.id, co.fy, date, co.owner.id, lines, source);
  }
  const stmtBody = (co: Co, o: Record<string, unknown> = {}) => ({
    bank_account_id: co.bank, statement_ref: `JAN-${randomUUID().slice(0, 6)}`, period_start: '2026-01-01', period_end: '2026-01-31', opening_balance: '0.00', closing_balance: '1000.00', ...o,
  });
  async function confirmedStatement(co: Co, closing = '1000.00', o: Record<string, unknown> = {}) {
    const d = await co.clerk.client.req('POST', '/bank-statements', stmtBody(co, { closing_balance: closing, ...o }));
    expect(d.status).toBe(201);
    const c = await co.approver.client.req('POST', `/bank-statements/${d.json.id}/confirm`, { version: d.json.version });
    expect(c.status).toBe(200);
    return c.json as { id: string; version: number };
  }
  const preview = async (co: Co, end = '2026-01-31') => (await co.viewer.client.req('GET', `/bank-reconciliation/preview?bank_account_id=${co.bank}&period_end=${end}`)).json.accounts[0];
  async function monthPeriod(co: Co, start: string, end: string) {
    const r = await co.owner.client.req('POST', '/monthly-close-periods', { fiscal_year_id: co.fy, period_start: start, period_end: end });
    expect(r.status).toBe(201);
    return r.json.id as string;
  }
  async function setMode(co: Co, mode: 'off' | 'warn' | 'enforce', from: string | null = null) {
    const cur = await co.owner.client.req('GET', '/bank-reconciliation/settings');
    const r = await co.owner.client.req('PUT', '/bank-reconciliation/settings', { mode, enforce_from: from, version: cur.json.version });
    expect(r.status).toBe(200);
  }
  const dbError = async (sql: string, p: unknown[] = []) => { try { await h.q(sql, p); return null; } catch (e) { return String((e as Error).message); } };

  /* ---------------------------------------------------------------- database guards */
  it('registers capabilities without default grants and keeps confirmed financial values immutable', async () => {
    expect(await h.count("SELECT COUNT(*)::text n FROM capabilities WHERE id IN ('bank.statement.manage','bank.statement.confirm','bank.reconciliation.settings')")).toBe(3);
    expect(await h.count("SELECT COUNT(*)::text n FROM role_capabilities WHERE capability_id IN ('bank.statement.manage','bank.statement.confirm','bank.reconciliation.settings') AND role_id IN (SELECT id FROM roles WHERE is_full_access = FALSE AND name IN ('Viewer','Accountant','Finance Manager','Operations'))")).toBe(0);
    const co = await setup('guard');
    const s = await confirmedStatement(co);
    expect(await dbError('UPDATE bank_statement_balances SET closing_balance=5 WHERE id=$1', [s.id])).toMatch(/confirmed bank statement balance/i);
    expect(await dbError('DELETE FROM bank_statement_balances WHERE id=$1', [s.id])).toMatch(/draft/i);
    expect(await dbError("UPDATE bank_statement_balances SET status='draft' WHERE id=$1", [s.id])).toMatch(/superseded/i);
    expect(await dbError("INSERT INTO bank_statement_balances(company_id,bank_account_id,currency_code,statement_ref,period_start,period_end,closing_balance,created_by) VALUES($1,$2,'USD','X','2026-02-01','2026-02-28',1,$3)", [co.id, co.bank, co.owner.id])).toMatch(/currency/i);
    const sid = await link(co);
    expect(await dbError('DELETE FROM bank_account_ledger_links WHERE id=$1', [sid])).toMatch(/cannot be deleted/i);
    expect(await dbError('UPDATE bank_account_ledger_links SET account_id=$2 WHERE id=$1', [sid, co.otherGl])).toMatch(/immutable/i);
    await co.viewer.client.req('GET', '/bank-reconciliation/settings');
    const snapshotId = randomUUID();
    await h.q("INSERT INTO bank_reconciliation_snapshots(id,company_id,bank_account_id,scope,scope_id,period_end,mode,outcome,result,result_sha256,recorded_by) VALUES($1,$2,$3,'monthly_close',$4,'2026-01-31','warn','attention','{}'::jsonb,$5,$6)", [snapshotId, co.id, co.bank, randomUUID(), 'b'.repeat(64), co.owner.id]);
    expect(await dbError('UPDATE bank_reconciliation_snapshots SET outcome=\'reconciled\' WHERE id=$1', [snapshotId])).toMatch(/append-only/i);
    expect(await dbError('DELETE FROM bank_reconciliation_snapshots WHERE id=$1', [snapshotId])).toMatch(/append-only/i);
  });

  it('prevents overlapping ledger-link validity, non-cash ledger accounts and currency mismatch', async () => {
    const co = await setup('links');
    const first = await link(co, '2026-01-01');
    const overlap = await co.owner.client.req('POST', '/bank-ledger-links', { bank_account_id: co.bank, account_id: co.otherGl, valid_from: '2026-06-01' });
    expect(overlap.status).toBe(409);
    expect(overlap.json.code).toBe('BANK_LINK_OVERLAP');
    const nonCash = await co.owner.client.req('POST', '/bank-ledger-links', { bank_account_id: co.bank, account_id: co.nonCash, valid_from: '2025-01-01' });
    expect(nonCash.status).toBe(400);
    expect((await co.owner.client.req('POST', `/bank-ledger-links/${first}/end`, { valid_to: '2026-05-31' })).status).toBe(200);
    expect((await co.owner.client.req('POST', `/bank-ledger-links/${first}/end`, { valid_to: '2026-05-31' })).json.code).toBe('BANK_LINK_ALREADY_ENDED');
    expect((await co.owner.client.req('POST', '/bank-ledger-links', { bank_account_id: co.bank, account_id: co.otherGl, valid_from: '2026-06-01' })).status).toBe(201);
    // the first ledger account stays free for a second bank account only after its period ended
    const usd = await setup('linksusd', { currency: 'USD' });
    const mismatch = await usd.owner.client.req('POST', '/bank-ledger-links', { bank_account_id: usd.bank, account_id: usd.bankGl, valid_from: '2026-01-01' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.json.code).toBe('BANK_LINK_CURRENCY_MISMATCH');
  });

  /* ---------------------------------------------------------------- authorization, isolation, workflow */
  it('enforces capabilities and company isolation', async () => {
    const a = await setup('isoa');
    const b = await setup('isob');
    expect((await a.viewer.client.req('POST', '/bank-statements', stmtBody(a))).status).toBe(403);
    expect((await a.viewer.client.req('PUT', '/bank-reconciliation/settings', { mode: 'warn', enforce_from: null, version: 0 })).status).toBe(403);
    const draft = await a.clerk.client.req('POST', '/bank-statements', stmtBody(a));
    expect(draft.status).toBe(201);
    expect((await a.clerk.client.req('POST', `/bank-statements/${draft.json.id}/confirm`, { version: 1 })).status).toBe(403);
    expect((await a.approver.client.req('POST', '/bank-statements', stmtBody(a))).status).toBe(403);
    // another company cannot see or touch it, nor use A's bank account
    expect((await b.owner.client.req('GET', '/bank-statements')).json).toEqual([]);
    expect((await b.owner.client.req('POST', `/bank-statements/${draft.json.id}/confirm`, { version: 1 })).status).toBe(404);
    expect((await b.owner.client.req('POST', '/bank-statements', stmtBody(a))).status).toBe(404);
    expect((await b.owner.client.req('POST', '/bank-ledger-links', { bank_account_id: a.bank, account_id: b.bankGl, valid_from: '2026-01-01' })).status).toBe(404);
    expect((await b.owner.client.req('GET', `/bank-reconciliation/preview?bank_account_id=${a.bank}&period_end=2026-01-31`)).status).toBe(404);
  });

  it('runs draft, confirm and supersession with duplicates, stale versions, audit and concurrency protection', async () => {
    const co = await setup('flow');
    const d = await co.clerk.client.req('POST', '/bank-statements', stmtBody(co, { statement_ref: 'JAN-1' }));
    expect(d.status).toBe(201);
    expect((await co.clerk.client.req('POST', '/bank-statements', stmtBody(co, { statement_ref: 'JAN-2' }))).json.code).toBe('BANK_STATEMENT_DUPLICATE_DRAFT');
    const edited = await co.clerk.client.req('PATCH', `/bank-statements/${d.json.id}`, { ...stmtBody(co, { statement_ref: 'JAN-1', closing_balance: '1200.00' }), version: 1 });
    expect(edited.status).toBe(200);
    expect((await co.clerk.client.req('PATCH', `/bank-statements/${d.json.id}`, { ...stmtBody(co, { statement_ref: 'JAN-1' }), version: 1 })).json.code).toBe('BANK_STATEMENT_STALE');
    const [c1, c2] = await Promise.all([1, 2].map(() => co.approver.client.req('POST', `/bank-statements/${d.json.id}/confirm`, { version: 2 })));
    expect([c1.status, c2.status].sort()).toEqual([200, 409]);
    const confirmed = [c1, c2].find(r => r.status === 200)!.json;
    // a confirmed period cannot be duplicated; replacement needs a reason and the current version
    expect((await co.clerk.client.req('POST', '/bank-statements', stmtBody(co, { statement_ref: 'JAN-1B' }))).status).toBe(201);
    const dupConfirm = await co.approver.client.req('POST', `/bank-statements/${(await co.clerk.client.req('GET', '/bank-statements?status=draft')).json[0].id}/confirm`, { version: 1 });
    expect(dupConfirm.json.code).toBe('BANK_STATEMENT_DUPLICATE_PERIOD');
    const noReason = await co.approver.client.req('POST', `/bank-statements/${confirmed.id}/supersede`, { ...stmtBody(co, { statement_ref: 'JAN-1-R', closing_balance: '900.00' }), version: confirmed.version });
    expect(noReason.status).toBe(400);
    const body = { ...stmtBody(co, { statement_ref: 'JAN-1-R', closing_balance: '900.00' }), version: confirmed.version, reason: 'Bank corrected the statement' };
    const [s1, s2] = await Promise.all([1, 2].map(() => co.approver.client.req('POST', `/bank-statements/${confirmed.id}/supersede`, body)));
    expect([s1.status, s2.status].sort()).toEqual([201, 409]);
    const old = (await h.q<{ status: string; superseded_by: string | null }>('SELECT status,superseded_by FROM bank_statement_balances WHERE id=$1', [confirmed.id]))[0]!;
    expect(old.status).toBe('superseded');
    expect(await h.count("SELECT COUNT(*)::text n FROM bank_statement_balances WHERE company_id=$1 AND status='confirmed'", [co.id])).toBe(1);
    const replacement = [s1, s2].find(r => r.status === 201)!.json;
    expect(replacement.supersedes_id).toBe(confirmed.id);
    expect(replacement.replacement_reason).toBe('Bank corrected the statement');
    for (const action of ['bank_statement.create_draft', 'bank_statement.update_draft', 'bank_statement.confirm', 'bank_statement.supersede']) {
      expect(await h.count('SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action=$2', [co.id, action])).toBeGreaterThanOrEqual(1);
    }
  });

  it('refuses statement changes inside a closed accounting period', async () => {
    const co = await setup('lock');
    const period = await monthPeriod(co, '2026-01-01', '2026-01-31');
    const s = await confirmedStatement(co);
    expect((await co.owner.client.req('POST', `/monthly-close-periods/${period}/close`)).status).toBe(200);
    const refused = await co.clerk.client.req('POST', '/bank-statements', stmtBody(co, { period_start: '2026-01-01', period_end: '2026-01-31', statement_ref: 'LATE' }));
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('ACCOUNTING_PERIOD_CLOSED');
    const supersede = await co.approver.client.req('POST', `/bank-statements/${s.id}/supersede`, { ...stmtBody(co, { statement_ref: 'LATE-R' }), version: s.version, reason: 'late fix' });
    expect(supersede.status).toBe(409);
  });

  /* ---------------------------------------------------------------- calculation */
  it('reconciles with exactly zero tolerance and reports an unexplained difference', async () => {
    const co = await setup('calc');
    await link(co);
    await glEntry(co, '2026-01-10', '1000.00', 'in');
    expect(await preview(co)).toMatchObject({ problems: ['statement_missing'], reconciled: false });
    await confirmedStatement(co, '1000.00');
    expect(await preview(co)).toMatchObject({ gl_balance: '1000.00', adjusted_bank_balance: '1000.00', difference: '0.00', problems: [], reconciled: true });
    const wrong = await setup('calcwrong');
    await link(wrong);
    await glEntry(wrong, '2026-01-10', '1000.00', 'in');
    await confirmedStatement(wrong, '999.99');
    expect(await preview(wrong)).toMatchObject({ difference: '-0.01', problems: ['difference_unexplained'], reconciled: false });
  });

  it('accepts evidenced timing differences and never assumes an unmatched line is outstanding', async () => {
    const co = await setup('timing');
    await link(co);
    await glEntry(co, '2026-01-05', '1500.00', 'in');
    // payment recorded on 31 Jan, cleared by the bank on 03 Feb: the settlement ties the GL entry to the later bank row
    const later = await bankTx(co, '2026-02-03', '-250.00');
    await glEntry(co, '2026-01-31', '250.00', 'out', later);
    await confirmedStatement(co, '1500.00');
    expect(await preview(co)).toMatchObject({ gl_balance: '1250.00', outstanding_payments: '250.00', deposits_in_transit: '0.00', adjusted_bank_balance: '1250.00', difference: '0.00', reconciled: true });
    expect((await preview(co)).outstanding_items).toHaveLength(1);

    // the same shape WITHOUT a source record is not proven outstanding: it stays in the difference
    const bare = await setup('timingbare');
    await link(bare);
    await glEntry(bare, '2026-01-05', '1500.00', 'in');
    await glEntry(bare, '2026-01-31', '250.00', 'out');
    await confirmedStatement(bare, '1500.00');
    expect(await preview(bare)).toMatchObject({ outstanding_items: [], difference: '250.00', problems: ['difference_unexplained'] });

    // evidence whose amount disagrees with the imported bank row is rejected, not applied
    const mismatch = await setup('timingmis');
    await link(mismatch);
    await glEntry(mismatch, '2026-01-05', '1500.00', 'in');
    // R9 (migration 100): a settlement can never exceed its bank row, so the mismatch is a partial allocation (250 of 300)
    const odd = await bankTx(mismatch, '2026-02-03', '-300.00');
    await glEntry(mismatch, '2026-01-31', '250.00', 'out', odd);
    await confirmedStatement(mismatch, '1500.00');
    const result = await preview(mismatch);
    expect(result.rejected_evidence).toHaveLength(1);
    expect(result).toMatchObject({ outstanding_items: [], difference: '250.00', reconciled: false });
  });

  it('uses the bank sign convention (credit/positive = money in = GL debit) in both directions and rejects opposite signs', async () => {
    // imported statement rows: a debit column becomes a negative amount, a credit column a positive amount (bank.router.ts normalisation)
    const co = await setup('sign');
    await link(co);
    await glEntry(co, '2026-01-05', '1000.00', 'in');
    const receipt = await bankTx(co, '2026-02-04', '300.00');      // credit on the statement, cleared after month end
    await glEntry(co, '2026-01-31', '300.00', 'in', receipt);      // GL: debit bank
    const payment = await bankTx(co, '2026-02-02', '-100.00');     // debit on the statement
    await glEntry(co, '2026-01-30', '100.00', 'out', payment);     // GL: credit bank
    await confirmedStatement(co, '1000.00');                       // the bank holds 1000 at month end; GL 1200 = 1000 + 300 in transit - 100 outstanding
    expect(await preview(co)).toMatchObject({ gl_balance: '1200.00', deposits_in_transit: '300.00', outstanding_payments: '100.00', adjusted_bank_balance: '1200.00', difference: '0.00', reconciled: true });
    // opposite signs: a bank credit (+250) tied to a GL payment (credit bank) is rejected, never applied
    const opp = await setup('signopp');
    await link(opp);
    await glEntry(opp, '2026-01-05', '1000.00', 'in');
    const wrong = await bankTx(opp, '2026-02-04', '250.00');
    await glEntry(opp, '2026-01-31', '250.00', 'out', wrong);
    await confirmedStatement(opp, '1000.00');
    const result = await preview(opp);
    expect(result.rejected_evidence).toHaveLength(1);
    expect(result).toMatchObject({ outstanding_items: [], difference: '250.00', reconciled: false });
  });

  it('never counts one bank row twice: the database refuses a second explanation and the evidence is applied once', async () => {
    const co = await setup('dup');
    await link(co);
    await glEntry(co, '2026-01-05', '1000.00', 'in');
    const later = await bankTx(co, '2026-02-03', '-250.00');
    await glEntry(co, '2026-01-31', '250.00', 'out', later);       // document settlement path
    const cp = (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Supplier','supplier',$2) RETURNING id", [co.id, co.owner.id]))[0]!.id;
    const ob = (await h.q<{ id: string }>("INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,250,'2026-01-20','confirmed','manual',$3) RETURNING id", [co.id, cp, co.owner.id]))[0]!.id;
    expect(await dbError('INSERT INTO obligation_settlements(company_id,obligation_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,250,$4)', [co.id, ob, later, co.owner.id])).toMatch(/already explained/i);
    // one journal per source and one explanation per bank row: the same row cannot back two entries
    expect(await dbError("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,source_type,source_id,created_by) SELECT company_id,fiscal_year_id,accounting_date,'dup',source_type,source_id,created_by FROM journal_entries WHERE company_id=$1 AND source_type='document_settlement'", [co.id])).toMatch(/duplicate key/i);
    await confirmedStatement(co, '1000.00');
    const result = await preview(co);
    expect(result.outstanding_items).toHaveLength(1);
    expect(result).toMatchObject({ outstanding_payments: '250.00', difference: '0.00', reconciled: true });
  });

  it('never treats a bank-only item as resolved before it is posted', async () => {
    const co = await setup('bankonly');
    await link(co);
    await glEntry(co, '2026-01-10', '1000.00', 'in');
    await bankTx(co, '2026-01-20', '-40.00');           // bank fee: on the statement, no accounting entry yet
    await confirmedStatement(co, '960.00');
    expect(await preview(co)).toMatchObject({ bank_only_count: 1, difference: '-40.00', problems: ['difference_unexplained'], warnings: ['bank_only_items'] });
  });

  it('flags unmapped accounts, missing statements and currency problems', async () => {
    const co = await setup('probs');
    await bankTx(co, '2026-01-12', '100.00');
    expect(await preview(co)).toMatchObject({ problems: ['unmapped', 'statement_missing'] });
    const usd = await setup('probsusd', { currency: 'USD' });
    await h.q('INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,$4,$5)', [usd.id, usd.bank, usd.bankGl, '2026-01-01', usd.owner.id]);
    expect(await preview(usd)).toMatchObject({ problems: expect.arrayContaining(['currency_mismatch']) });
  });

  /* ---------------------------------------------------------------- closing gates */
  it('keeps closing unchanged when off, warns when warn, blocks only in enforce, and recalculates inside the close', async () => {
    const co = await setup('close');
    await link(co);
    await glEntry(co, '2026-01-10', '1000.00', 'in');
    await bankTx(co, '2026-01-15', '1000.00');
    // a bank row that is not otherwise resolved would already block via the existing check; settle it the existing way is out of scope here,
    // so use a month without bank rows for the gate assertions
    const period = await monthPeriod(co, '2026-02-01', '2026-02-28');
    const feb = await co.owner.client.req('GET', '/monthly-close-periods');
    expect(feb.json.periods.find((p: { id: string }) => p.id === period).blockers.bank_reconciliation).toBeUndefined();

    await setMode(co, 'warn');
    const warn = await co.owner.client.req('GET', '/monthly-close-periods');
    const warnPeriod = warn.json.periods.find((p: { id: string }) => p.id === period);
    // one account with a problem (statement missing) + the same account carrying the unresolved January bank row as a warning
    expect(warnPeriod.warnings?.bank_reconciliation).toBe(2);
    expect(warnPeriod.ready).toBe(true);

    await setMode(co, 'enforce', '2026-03-01');                  // effective after February: still a warning
    expect((await co.owner.client.req('GET', '/monthly-close-periods')).json.periods.find((p: { id: string }) => p.id === period).ready).toBe(true);

    await setMode(co, 'enforce', '2026-02-01');
    const blocked = await co.owner.client.req('POST', `/monthly-close-periods/${period}/close`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('MONTHLY_CLOSE_BLOCKED');
    expect(await h.count("SELECT COUNT(*)::text n FROM bank_reconciliation_snapshots WHERE company_id=$1", [co.id])).toBe(0);

    await confirmedStatement(co, '1000.00', { period_start: '2026-02-01', period_end: '2026-02-28' });
    const ok = await co.owner.client.req('POST', `/monthly-close-periods/${period}/close`);
    expect(ok.status).toBe(200);
    const snap = (await h.q<{ outcome: string; statement_id: string; scope: string; difference: string; result: { difference: string; statement_id: string } }>('SELECT outcome,statement_id,scope,difference::text,result FROM bank_reconciliation_snapshots WHERE company_id=$1', [co.id]));
    // the snapshot is the very result the gate passed on: same statement, zero difference
    expect(snap).toEqual([{ outcome: 'reconciled', statement_id: expect.any(String), scope: 'monthly_close', difference: '0.00', result: expect.objectContaining({ difference: '0.00' }) }]);
    expect(snap[0]!.result.statement_id).toBe(snap[0]!.statement_id);
  });

  it('blocks a September monthly close on a 100.00 unexplained difference in enforce mode, independently of unrelated blockers, and reports it in the readiness list', async () => {
    const co = await setup('sept');
    await link(co, '2026-01-01');
    await setMode(co, 'enforce', '2026-09-01');
    const period = await monthPeriod(co, '2026-09-01', '2026-09-30');
    const readiness = async () => (await co.owner.client.req('GET', '/monthly-close-periods')).json.periods.find((p: { id: string }) => p.id === period);
    const sept = (o: Record<string, unknown> = {}) => ({ period_start: '2026-09-01', period_end: '2026-09-30', ...o });

    // statement says 100.00, the ledger holds 0.00 -> exactly the owner's UAT scenario
    const stmt = await confirmedStatement(co, '100.00', sept());
    const first = await readiness();
    expect(first.blockers.bank_reconciliation).toBe(1);
    expect(first.disclosed_total).toBe(1);
    expect(first.ready).toBe(false);
    const blocked = await co.owner.client.req('POST', `/monthly-close-periods/${period}/close`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('MONTHLY_CLOSE_BLOCKED');
    expect(await h.count("SELECT COUNT(*)::text n FROM bank_reconciliation_snapshots WHERE company_id=$1", [co.id])).toBe(0);

    // an unrelated blocker (an unresolved bank row inside the month) is counted separately and does not hide or replace the reconciliation blocker
    await bankTx(co, '2026-09-10', '5.00');
    const both = await readiness();
    expect(both.blockers.bank_reconciliation).toBe(1);
    expect(both.blockers.bank_transactions).toBe(1);
    expect(both.disclosed_total).toBe(2);

    // the statement is corrected to the ledger value: the reconciliation blocker clears on its own, the unrelated one remains
    const fix = await co.approver.client.req('POST', `/bank-statements/${stmt.id}/supersede`, { ...stmtBody(co, sept({ statement_ref: 'SEP-FIX', closing_balance: '0.00' })), version: stmt.version, reason: 'bank issued a corrected statement' });
    expect(fix.status).toBe(201);
    const afterFix = await readiness();
    expect(afterFix.blockers.bank_reconciliation).toBe(0);
    expect(afterFix.blockers.bank_transactions).toBe(1);
    expect((await co.owner.client.req('POST', `/monthly-close-periods/${period}/close`)).status).toBe(409);
  });

  it('omits the reconciliation category outside enforce mode so the readiness list never shows an unrelated zero row', async () => {
    const co = await setup('sept-off');
    await link(co, '2026-01-01');
    const period = await monthPeriod(co, '2026-09-01', '2026-09-30');
    await confirmedStatement(co, '100.00', { period_start: '2026-09-01', period_end: '2026-09-30' });
    const row = (await co.owner.client.req('GET', '/monthly-close-periods')).json.periods.find((p: { id: string }) => p.id === period);
    expect(row.blockers.bank_reconciliation).toBeUndefined();
    expect(row.ready).toBe(true);
  });

  it('rejects stale evidence: a replacement racing the close either blocks the close or lands before it', async () => {
    const co = await setup('race');
    await link(co);
    await glEntry(co, '2026-01-10', '1000.00', 'in');
    await setMode(co, 'enforce', '2026-02-01');
    const period = await monthPeriod(co, '2026-02-01', '2026-02-28');
    const s = await confirmedStatement(co, '1000.00', { period_start: '2026-02-01', period_end: '2026-02-28' });
    const body = { ...stmtBody(co, { statement_ref: 'FEB-R', period_start: '2026-02-01', period_end: '2026-02-28', closing_balance: '777.00' }), version: s.version, reason: 'bank issued a corrected statement' };
    const [close, replace] = await Promise.all([
      co.owner.client.req('POST', `/monthly-close-periods/${period}/close`),
      co.approver.client.req('POST', `/bank-statements/${s.id}/supersede`, body),
    ]);
    const closed = close.status === 200;
    const snapshots = await h.q<{ statement_id: string; outcome: string }>("SELECT statement_id,outcome FROM bank_reconciliation_snapshots WHERE company_id=$1 AND scope='monthly_close'", [co.id]);
    if (closed) {
      // the close used the statement that was confirmed when it ran; the replacement could not change a closed period afterwards
      expect(replace.status).toBe(409);
      expect(snapshots).toEqual([{ statement_id: s.id, outcome: 'reconciled' }]);
    } else {
      // the replacement landed first: the recalculation saw 777.00 and refused to close
      expect(close.json.code).toBe('MONTHLY_CLOSE_BLOCKED');
      expect(replace.status).toBe(201);
      expect(snapshots).toEqual([]);
    }
  });

  it('uses the same calculation for annual readiness as for the monthly gate', async () => {
    const co = await setup('annual');
    await link(co);
    await glEntry(co, '2026-01-10', '1000.00', 'in');
    const { AnnualClosingService } = await import('../src/modules/annual-closing/annual-closing.service');
    const { evaluateCompanyBankReconciliation } = await import('../src/modules/banking/bank-reconciliation-core');
    const off = await new AnnualClosingService(h.db).readiness(co.id, co.fy);
    expect(off.domains['banking']!.summary['reconciliation_mode']).toBe('off');
    expect(off.domains['banking']!.summary['reconciliation_blockers']).toBe(0);
    await setMode(co, 'enforce', '2026-01-01');
    const annual = await new AnnualClosingService(h.db).readiness(co.id, co.fy);
    const direct = await evaluateCompanyBankReconciliation(h.db, co.id, '2026-01-01', '2026-12-31');
    expect(direct.blockers).toBe(1);
    expect(annual.domains['banking']!.summary['reconciliation_blockers']).toBe(direct.blockers);
    expect(annual.domains['banking']!.blocker_count).toBeGreaterThanOrEqual(1);
    const { getFiscalYearCloseReadiness } = await import('../src/modules/fiscal-years/fiscal-year-close-readiness');
    const client = await h.db.connect();
    try {
      const readiness = await getFiscalYearCloseReadiness(client, co.id, { id: co.fy, start_date: '2026-01-01', end_date: '2026-12-31' });
      expect(readiness.ready).toBe(false);
      expect(readiness.blockers.map(b => b.code)).toContain('bank_reconciliation_unresolved');
    } finally { client.release(); }
    await confirmedStatement(co, '1000.00', { period_start: '2026-12-01', period_end: '2026-12-31' });
    expect((await evaluateCompanyBankReconciliation(h.db, co.id, '2026-01-01', '2026-12-31')).blockers).toBe(0);
  });

  it('defaults existing companies to off and audits activation', async () => {
    const co = await setup('settings');
    expect((await co.viewer.client.req('GET', '/bank-reconciliation/settings')).json).toMatchObject({ mode: 'off', version: 0 });
    expect((await co.owner.client.req('PUT', '/bank-reconciliation/settings', { mode: 'enforce', enforce_from: null, version: 0 })).json.code).toBe('BANK_RECON_ENFORCE_DATE_REQUIRED');
    expect((await co.owner.client.req('PUT', '/bank-reconciliation/settings', { mode: 'warn', enforce_from: null, version: 5 })).json.code).toBe('BANK_RECON_SETTINGS_STALE');
    expect((await co.owner.client.req('PUT', '/bank-reconciliation/settings', { mode: 'warn', enforce_from: null, version: 0 })).status).toBe(200);
    expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='bank_reconciliation.settings'", [co.id])).toBe(1);
  });
});
