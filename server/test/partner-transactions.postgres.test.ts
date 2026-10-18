import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// In-year partner financial transactions over real HTTP + PostgreSQL (migration 087). Requires a disposable DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('partner transactions (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  let rowNo = 0;

  async function setup(label: string) {
    const owner = await h.user(`${label}-own`);
    const preparer = await h.user(`${label}-prep`);   // may create, not post
    const poster = await h.user(`${label}-post`);     // may post/reverse, not create
    const viewer = await h.user(`${label}-view`);     // partner.view only
    const mapper = await h.user(`${label}-map`);
    const id = await h.company(label, owner.id);
    await h.member(id, preparer.id, ['partner.view', 'partner.transaction.view', 'partner.transaction.create']);
    await h.member(id, poster.id, ['partner.view', 'partner.transaction.view', 'partner.transaction.post', 'partner.transaction.reverse']);
    await h.member(id, viewer.id, ['partner.view']);
    await h.member(id, mapper.id, ['partner.transaction.view', 'partner.account_mapping.manage']);
    for (const u of [owner, preparer, poster, viewer, mapper]) await u.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const bankGl = await h.account(id, 'B-BANK', 'asset', 'current_asset');
    const cashGl = await h.account(id, 'B-CASH', 'asset', 'current_asset');
    const capital = await h.account(id, 'E-CAP', 'equity', 'equity');
    const currentA = await h.account(id, 'E-CUR-A', 'equity', 'equity');
    const currentB = await h.account(id, 'L-CUR-B', 'liability', 'current_liability');
    const loan = await h.account(id, 'L-LOAN', 'liability', 'non_current_liability');
    const expense = await h.account(id, 'X-EXP', 'expense', 'operating_expense');
    const bank = (await h.q<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const batch = (await h.q<{ id: string }>(
      "INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id",
      [id, bank, `k-${randomUUID()}`, owner.id]))[0]!.id;
    const partnerA = (await h.q<{ id: string }>("INSERT INTO partners(company_id,name,created_by_user_id) VALUES($1,'Partner A',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const partnerB = (await h.q<{ id: string }>("INSERT INTO partners(company_id,name,created_by_user_id) VALUES($1,'Partner B',$2) RETURNING id", [id, owner.id]))[0]!.id;
    return { id, owner, preparer, poster, viewer, mapper, fy, bankGl, cashGl, capital, currentA, currentB, loan, expense, bank, batch, partnerA, partnerB };
  }
  type Co = Awaited<ReturnType<typeof setup>>;

  async function mapAll(co: Co) {
    for (const [partner, key, acc] of [[co.partnerA, 'capital', co.capital], [co.partnerA, 'current', co.currentA], [co.partnerA, 'loan', co.loan], [co.partnerB, 'current', co.currentB]] as const) {
      const r = await co.owner.client.req('PUT', `/partners/${partner}/account-mappings/${key}`, { account_id: acc });
      expect(r.status).toBe(200);
    }
    expect((await co.owner.client.req('PUT', `/partners/cash-account-mappings/${co.bank}`, { account_id: co.bankGl })).status).toBe(200);
    expect((await co.owner.client.req('PUT', '/partners/cash-account-mappings/cash', { account_id: co.cashGl })).status).toBe(200);
  }
  async function bankTx(co: Co, date: string, amount: string) {
    rowNo += 1;
    return (await h.q<{ id: string }>(
      "INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,$4,$5,'SAR',$6,$7,'strong') RETURNING id",
      [co.id, co.bank, co.batch, date, amount, rowNo, `fp-${randomUUID()}`]))[0]!.id;
  }
  const body = (co: Co, o: Record<string, unknown> = {}) => ({
    partner_id: co.partnerA, transaction_type: 'current_withdrawal', transaction_date: '2026-03-10', amount: '1500.00', channel: 'cash', ...o,
  });
  async function draft(co: Co, o: Record<string, unknown> = {}) {
    const r = await co.preparer.client.req('POST', '/partners/transactions', body(co, o));
    expect(r.status).toBe(201);
    return r.json as { id: string; version: number; status: string };
  }
  const lines = (journal: string) => h.q<{ account_id: string; debit: string; credit: string }>('SELECT account_id,debit::text,credit::text FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence', [journal]);

  it('enforces capabilities: view, create, post, reverse and mapping management are separate', async () => {
    const co = await setup('auth');
    await mapAll(co);
    expect((await co.viewer.client.req('GET', '/partners/transactions')).status).toBe(403);
    expect((await co.viewer.client.req('GET', `/partners/${co.partnerA}/ledger?from=2026-01-01&to=2026-12-31`)).status).toBe(403);
    expect((await co.viewer.client.req('POST', '/partners/transactions', body(co))).status).toBe(403);
    expect((await co.poster.client.req('POST', '/partners/transactions', body(co))).status).toBe(403);
    const d = await draft(co);
    expect((await co.preparer.client.req('POST', `/partners/transactions/${d.id}/post`, {})).status).toBe(403);
    expect((await co.preparer.client.req('PUT', `/partners/${co.partnerA}/account-mappings/current`, { account_id: co.currentA })).status).toBe(403);
    expect((await co.mapper.client.req('PUT', `/partners/${co.partnerA}/account-mappings/current`, { account_id: co.currentA })).status).toBe(200);
    expect((await co.mapper.client.req('POST', `/partners/transactions/${d.id}/post`, {})).status).toBe(403);
    expect((await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {})).status).toBe(200);
    expect((await co.preparer.client.req('POST', `/partners/transactions/${d.id}/reverse`, { reversal_date: '2026-03-11', reason: 'x' })).status).toBe(403);
    expect((await co.poster.client.req('PATCH', `/partners/transactions/${d.id}`, { ...body(co), version: 1 })).status).toBe(403);
    // unauthenticated requests never reach the service
    const anon = await h.user('anon');
    expect((await anon.client.req('GET', '/partners/transactions')).status).toBe(401);
  });

  it('validates account mappings by type, activity and company; never infers an account', async () => {
    const co = await setup('map');
    const other = await setup('map-other');
    const put = (partner: string, key: string, acc: string) => co.owner.client.req('PUT', `/partners/${partner}/account-mappings/${key}`, { account_id: acc });
    expect((await put(co.partnerA, 'capital', co.currentB)).status).toBe(400);          // liability is not capital
    expect((await put(co.partnerA, 'capital', co.bankGl)).status).toBe(400);            // asset is not capital
    expect((await put(co.partnerA, 'loan', co.capital)).status).toBe(400);              // equity is not a loan
    expect((await put(co.partnerA, 'current', co.expense)).status).toBe(400);           // expense is not a current account
    expect((await put(co.partnerA, 'capital', other.capital)).status).toBe(400);        // other company's account
    expect((await put(other.partnerA, 'capital', co.capital)).status).toBe(404);        // other company's partner
    expect((await put(co.partnerA, 'bogus', co.capital)).status).toBe(400);
    await h.q('UPDATE accounts SET is_active=false WHERE id=$1', [co.capital]);
    expect((await put(co.partnerA, 'capital', co.capital)).status).toBe(400);           // inactive
    expect((await co.owner.client.req('PUT', `/partners/cash-account-mappings/${co.bank}`, { account_id: co.capital })).status).toBe(400);
    expect((await put(co.partnerA, 'current', co.currentA)).status).toBe(200);          // equity current
    expect((await put(co.partnerB, 'current', co.currentB)).status).toBe(200);          // liability current
    expect(await h.count('SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action=$2', [co.id, 'partner_account_mapping.set'])).toBe(2);
    expect((await co.owner.client.req('GET', '/partners/account-mappings')).json.partner_mappings).toHaveLength(2);
  });

  it('refuses to post without complete mappings and creates no journal', async () => {
    const co = await setup('nomap');
    const d = await draft(co);
    let r = await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {});
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('PARTNER_MAPPING_MISSING');
    await co.owner.client.req('PUT', `/partners/${co.partnerA}/account-mappings/current`, { account_id: co.currentA });
    r = await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {});
    expect(r.json.code).toBe('PARTNER_MAPPING_MISSING');               // cash mapping still missing
    await h.q('UPDATE accounts SET is_active=false WHERE id=$1', [co.currentA]);
    await co.owner.client.req('PUT', '/partners/cash-account-mappings/cash', { account_id: co.cashGl });
    r = await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {});
    expect(r.json.code).toBe('PARTNER_MAPPING_MISSING');               // mapped account deactivated after configuration
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='partner_transaction'", [co.id])).toBe(0);
    expect((await h.q<{ status: string }>('SELECT status FROM partner_transactions WHERE id=$1', [d.id]))[0]!.status).toBe('draft');
  });

  it('posts each of the five types to the mapped accounts; ordinary withdrawals hit the individual current account only', async () => {
    const co = await setup('types');
    await mapAll(co);
    const cases: Array<[string, string, string, string, string]> = [
      // type, channel, debit account, credit account, amount
      ['capital_contribution', 'cash', co.cashGl, co.capital, '10000.00'],
      ['current_deposit', 'cash', co.cashGl, co.currentA, '2000.00'],
      ['current_withdrawal', 'cash', co.currentA, co.cashGl, '1500.00'],
      ['loan_received', 'bank', co.bankGl, co.loan, '5000.00'],
      ['loan_repayment', 'bank', co.loan, co.bankGl, '1000.25'],
    ];
    for (const [type, channel, debit, credit, amount] of cases) {
      const d = await draft(co, { transaction_type: type, channel, amount, ...(channel === 'bank' ? { bank_account_id: co.bank } : {}) });
      const r = await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {});
      expect(r.status, type).toBe(200);
      expect(r.json.replayed).toBe(false);
      expect(r.json.transaction.status).toBe('posted');
      const l = await lines(r.json.transaction.journal_entry_id);
      expect(l.map((x) => [x.account_id, x.debit, x.credit]), type).toEqual([[debit, amount, '0.00'], [credit, '0.00', amount]]);
      const j = (await h.q<{ status: string; source_type: string; source_id: string }>('SELECT status,source_type,source_id FROM journal_entries WHERE id=$1', [r.json.transaction.journal_entry_id]))[0]!;
      expect(j).toEqual({ status: 'posted', source_type: 'partner_transaction', source_id: d.id });
    }
    // The withdrawal never touched capital or the loan account beyond their own movements.
    const net = async (acc: string) => (await h.q<{ n: string }>('SELECT (COALESCE(SUM(credit),0)-COALESCE(SUM(debit),0))::text n FROM journal_lines WHERE account_id=$1', [acc]))[0]!.n;
    expect(await net(co.capital)).toBe('10000.00');
    expect(await net(co.currentA)).toBe('500.00');
    expect(await net(co.loan)).toBe('3999.75');
    const unbalanced = await h.count('SELECT COUNT(*)::text n FROM (SELECT journal_entry_id FROM journal_lines WHERE company_id=$1 GROUP BY 1 HAVING SUM(debit)<>SUM(credit)) x', [co.id]);
    expect(unbalanced).toBe(0);
  });

  it('is idempotent: repeated and concurrent posting create exactly one journal', async () => {
    const co = await setup('idem');
    await mapAll(co);
    const d = await draft(co);
    const results = await Promise.all([1, 2, 3].map(() => co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {})));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.json.replayed === false)).toHaveLength(1);
    const again = await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {});
    expect(again.json.replayed).toBe(true);
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='partner_transaction' AND source_id=$2", [co.id, d.id])).toBe(1);
    expect(await h.count('SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action=$2', [co.id, 'partner_transaction.post'])).toBe(1);
  });

  it('only a draft can be edited or deleted, with optimistic concurrency; posted rows are frozen in the database', async () => {
    const co = await setup('draftonly');
    await mapAll(co);
    const d = await draft(co);
    expect((await co.preparer.client.req('PATCH', `/partners/transactions/${d.id}`, { ...body(co, { amount: '99.00' }), version: 1 })).status).toBe(200);
    const stale = await co.preparer.client.req('PATCH', `/partners/transactions/${d.id}`, { ...body(co, { amount: '98.00' }), version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('PARTNER_TRANSACTION_VERSION_CONFLICT');
    expect((await co.preparer.client.req('DELETE', `/partners/transactions/${d.id}?version=1`)).status).toBe(409);
    const gone = await draft(co);
    expect((await co.preparer.client.req('DELETE', `/partners/transactions/${gone.id}?version=${gone.version}`)).status).toBe(204);
    expect((await co.preparer.client.req('GET', `/partners/transactions/${gone.id}`)).status).toBe(404);
    expect((await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {})).status).toBe(200);
    const edit = await co.preparer.client.req('PATCH', `/partners/transactions/${d.id}`, { ...body(co), version: 2 });
    expect(edit.status).toBe(409);
    expect(edit.json.code).toBe('PARTNER_TRANSACTION_NOT_DRAFT');
    expect((await co.preparer.client.req('DELETE', `/partners/transactions/${d.id}?version=2`)).status).toBe(409);
    await expect(h.q('UPDATE partner_transactions SET amount=1 WHERE id=$1', [d.id])).rejects.toThrow(/immutable/);
    await expect(h.q('DELETE FROM partner_transactions WHERE id=$1', [d.id])).rejects.toThrow(/cannot be deleted/);
    await expect(h.q("UPDATE partner_transactions SET status='draft',journal_entry_id=NULL,posted_by=NULL,posted_at=NULL WHERE id=$1", [d.id])).rejects.toThrow();
  });

  it('validates input strictly (amount, date, channel, unknown keys, inactive partner)', async () => {
    const co = await setup('input');
    const post = (o: Record<string, unknown>) => co.preparer.client.req('POST', '/partners/transactions', o);
    for (const bad of [
      body(co, { amount: '0' }), body(co, { amount: '-5' }), body(co, { amount: '1.234' }), body(co, { amount: 'abc' }), body(co, { transaction_date: '2026-02-30' }),
      body(co, { transaction_type: 'distribution' }), body(co, { transaction_type: 'capital_reduction' }), body(co, { channel: 'bank' }),
      body(co, { channel: 'cash', bank_account_id: co.bank }), body(co, { surprise: 1 }), body(co, { partner_id: 'nope' }), body(co, { version: 1 }),
    ]) expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    await h.q('UPDATE partners SET is_active=false WHERE id=$1', [co.partnerB]);
    expect((await post(body(co, { partner_id: co.partnerB }))).status).toBe(409);
    expect((await post(body(co, { transaction_date: '2027-03-01' }))).json.code).toBe('PARTNER_FISCAL_YEAR_UNRESOLVED');
  });

  it('links to an existing bank transaction (amount, direction, date, account, exclusivity) but does not require one', async () => {
    const co = await setup('bank');
    await mapAll(co);
    const out = await bankTx(co, '2026-03-10', '-1500.00');
    const inn = await bankTx(co, '2026-03-11', '2500.00');
    const link = (o: Record<string, unknown>) => co.preparer.client.req('POST', '/partners/transactions', body(co, { channel: 'bank', bank_account_id: co.bank, bank_transaction_id: out, ...o }));
    expect((await link({ amount: '1400.00' })).json.code).toBe('PARTNER_BANK_TRANSACTION_MISMATCH');          // amount
    expect((await link({ transaction_type: 'current_deposit' })).json.code).toBe('PARTNER_BANK_TRANSACTION_MISMATCH'); // direction
    expect((await link({ transaction_date: '2026-03-12' })).json.code).toBe('PARTNER_BANK_TRANSACTION_MISMATCH');      // date
    expect((await link({ bank_transaction_id: randomUUID() })).status).toBe(404);
    const ok = await link({});
    expect(ok.status).toBe(201);
    const dup = await link({});
    expect(dup.status).toBe(409);                                                                                // same row twice
    expect(dup.json.code).toBe('PARTNER_BANK_TRANSACTION_ALREADY_EXPLAINED');
    const second = await co.preparer.client.req('POST', '/partners/transactions', body(co, { transaction_type: 'current_deposit', transaction_date: '2026-03-11', amount: '2500.00', channel: 'bank', bank_account_id: co.bank, bank_transaction_id: inn }));
    expect(second.status).toBe(201);
    // A bank statement row is not required at all.
    expect((await co.preparer.client.req('POST', '/partners/transactions', body(co, { channel: 'bank', bank_account_id: co.bank }))).status).toBe(201);
    // Database-level exclusivity with the other explanation paths, in both directions.
    const cp = (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'C','supplier',$2) RETURNING id", [co.id, co.owner.id]))[0]!.id;
    const ob = (await h.q<{ id: string }>("INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,1500,'2026-03-01','confirmed','manual',$3) RETURNING id", [co.id, cp, co.owner.id]))[0]!.id;
    await expect(h.q('INSERT INTO obligation_settlements(company_id,obligation_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,1500,$4)', [co.id, ob, out, co.owner.id])).rejects.toThrow(/partner transaction/);
    const free = await bankTx(co, '2026-03-15', '-300.00');
    await h.q('INSERT INTO obligation_settlements(company_id,obligation_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,300,$4)', [co.id, ob, free, co.owner.id]);
    expect((await co.preparer.client.req('POST', '/partners/transactions', body(co, { transaction_date: '2026-03-15', amount: '300.00', channel: 'bank', bank_account_id: co.bank, bank_transaction_id: free }))).json.code).toBe('PARTNER_BANK_TRANSACTION_ALREADY_EXPLAINED');
    // Monthly close treats a posted partner-linked bank row as handled.
    const posted = await co.poster.client.req('POST', `/partners/transactions/${ok.json.id}/post`, {});
    expect(posted.status).toBe(200);
    // Reversal releases the link.
    const rev = await co.poster.client.req('POST', `/partners/transactions/${ok.json.id}/reverse`, { reversal_date: '2026-03-20', reason: 'entered twice' });
    expect(rev.status).toBe(200);
    expect((await link({})).status).toBe(201);
  });

  it('protects closed fiscal years and closed monthly periods, at draft time and at posting time', async () => {
    const co = await setup('closed');
    await mapAll(co);
    const d = await draft(co, { transaction_date: '2026-04-10' });
    await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-04-01','2026-04-30','closed')", [co.id, co.fy]);
    expect((await co.preparer.client.req('POST', '/partners/transactions', body(co, { transaction_date: '2026-04-11' }))).status).toBe(409);
    const blocked = await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('PARTNER_PERIOD_CLOSED');
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='partner_transaction'", [co.id])).toBe(0);
    const may = await draft(co, { transaction_date: '2026-05-10' });
    expect((await co.poster.client.req('POST', `/partners/transactions/${may.id}/post`, {})).status).toBe(200);
    await h.q("UPDATE monthly_close_periods SET status='closed' WHERE company_id=$1", [co.id]);
    await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-05-01','2026-05-31','closed') ON CONFLICT DO NOTHING", [co.id, co.fy]);
    const revClosedPeriod = await co.poster.client.req('POST', `/partners/transactions/${may.id}/reverse`, { reversal_date: '2026-05-20', reason: 'wrong period' });
    expect(revClosedPeriod.status).toBe(409);
    const revLater = await co.poster.client.req('POST', `/partners/transactions/${may.id}/reverse`, { reversal_date: '2026-06-02', reason: 'wrong period' });
    expect(revLater.status).toBe(200);
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [co.fy]);
    expect((await co.preparer.client.req('POST', '/partners/transactions', body(co, { transaction_date: '2026-08-01' }))).json.code).toBe('PARTNER_FISCAL_YEAR_CLOSED');
  });

  it('reverses with a separate swapped journal; double reversal, generic reversal and edits are refused', async () => {
    const co = await setup('rev');
    await mapAll(co);
    const d = await draft(co, { amount: '750.50' });
    const posted = await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {});
    const original = posted.json.transaction.journal_entry_id as string;
    expect((await co.poster.client.req('POST', `/partners/transactions/${d.id}/reverse`, { reversal_date: '2026-03-01', reason: 'too early' })).status).toBe(400);
    expect((await co.poster.client.req('POST', `/partners/transactions/${d.id}/reverse`, { reversal_date: '2026-03-12' })).status).toBe(400);
    // The generic manual-journal reversal never applies to a system-generated partner journal.
    expect((await co.owner.client.req('POST', `/journals/${original}/reverse`, { accounting_date: '2026-03-12', reason: 'x' })).status).toBe(409);
    const results = await Promise.all([1, 2].map(() => co.poster.client.req('POST', `/partners/transactions/${d.id}/reverse`, { reversal_date: '2026-03-12', reason: 'duplicate entry' })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const reversed = (await co.poster.client.req('GET', `/partners/transactions/${d.id}`)).json;
    expect(reversed.status).toBe('reversed');
    const rl = await lines(reversed.reversal_journal_id);
    const ol = await lines(original);
    expect(rl.map((x) => [x.account_id, x.debit, x.credit])).toEqual(ol.map((x) => [x.account_id, x.credit, x.debit]));
    expect((await h.q<{ status: string; source_type: string; source_id: string }>('SELECT status,source_type,source_id FROM journal_entries WHERE id=$1', [reversed.reversal_journal_id]))[0]).toEqual({ status: 'posted', source_type: 'partner_transaction_reversal', source_id: d.id });
    const net = (await h.q<{ n: string }>('SELECT (SUM(debit)-SUM(credit))::text n FROM journal_lines WHERE account_id=$1', [co.currentA]))[0]!.n;
    expect(net).toBe('0.00');
    expect((await co.poster.client.req('POST', `/partners/transactions/${d.id}/reverse`, { reversal_date: '2026-03-13', reason: 'again' })).json.code).toBe('PARTNER_TRANSACTION_NOT_POSTED');
    expect((await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {})).json.code).toBe('PARTNER_TRANSACTION_REVERSED');
    await expect(h.q('UPDATE partner_transactions SET reference=$2 WHERE id=$1', [d.id, 'tamper'])).rejects.toThrow(/immutable/);
    expect(await h.count('SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action=$2', [co.id, 'partner_transaction.reverse'])).toBe(1);
  });

  it('refuses a hand-made journal for a partner transaction and its manual creation', async () => {
    const co = await setup('manual');
    await mapAll(co);
    const d = await draft(co);
    const manual = await co.owner.client.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: '2026-03-10', description: 'x', source_type: 'partner_transaction', source_id: d.id });
    expect(manual.status).toBe(400);
    // A draft journal inserted behind the API with arbitrary accounts is still refused by the posting contract.
    const j = (await h.q<{ id: string }>(
      "INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,source_type,source_id,entry_type,created_by) VALUES($1,$2,'2026-03-10','rogue','partner_transaction',$3,'standard',$4) RETURNING id",
      [co.id, co.fy, d.id, co.owner.id]))[0]!.id;
    await h.q('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,1500,0,1),($1,$2,$4,0,1500,2)', [co.id, j, co.expense, co.cashGl]);
    const { postJournalInTransaction } = await import('../src/modules/accounting/journal-posting');
    const client = await h.db.connect();
    try {
      await client.query('BEGIN');
      await expect(postJournalInTransaction(client, co.id, co.owner.id, j)).rejects.toThrow(/configured partner/);
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await h.q<{ status: string }>('SELECT status FROM journal_entries WHERE id=$1', [j]))[0]!.status).toBe('draft');
  });

  it('isolates companies: no reads, writes, links or mappings across tenants', async () => {
    const a = await setup('iso-a');
    const b = await setup('iso-b');
    await mapAll(a); await mapAll(b);
    const d = await draft(a);
    const bTx = await bankTx(b, '2026-03-10', '-1500.00');
    expect((await b.owner.client.req('GET', `/partners/transactions/${d.id}`)).status).toBe(404);
    expect((await b.owner.client.req('POST', `/partners/transactions/${d.id}/post`, {})).status).toBe(404);
    expect((await b.owner.client.req('POST', `/partners/transactions/${d.id}/reverse`, { reversal_date: '2026-03-12', reason: 'x' })).status).toBe(404);
    expect((await b.owner.client.req('PATCH', `/partners/transactions/${d.id}`, { ...body(b), version: 1 })).status).toBe(404);
    expect((await b.owner.client.req('DELETE', `/partners/transactions/${d.id}?version=1`)).status).toBe(404);
    expect((await b.owner.client.req('GET', '/partners/transactions')).json.transactions).toHaveLength(0);
    expect((await b.owner.client.req('GET', `/partners/${a.partnerA}/ledger?from=2026-01-01&to=2026-12-31`)).status).toBe(404);
    expect((await a.owner.client.req('POST', '/partners/transactions', body(a, { partner_id: b.partnerA }))).status).toBe(404);
    expect((await a.owner.client.req('POST', '/partners/transactions', body(a, { channel: 'bank', bank_account_id: b.bank }))).status).toBe(404);
    expect((await a.owner.client.req('POST', '/partners/transactions', body(a, { channel: 'bank', bank_account_id: a.bank, bank_transaction_id: bTx }))).status).toBe(404);
    expect((await a.owner.client.req('POST', '/partners/transactions', body(a, { document_id: randomUUID() }))).status).toBe(404);
    // company A's posting never uses company B's mapping
    expect((await a.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {})).status).toBe(200);
    expect(await h.count('SELECT COUNT(*)::text n FROM journal_lines l JOIN accounts x ON x.id=l.account_id WHERE l.company_id=$1 AND x.company_id<>l.company_id', [a.id])).toBe(0);
  });

  it('builds the partner ledger from opening balances and posted movements, excluding drafts, with reversals shown', async () => {
    const co = await setup('ledger');
    await mapAll(co);
    // Posted, approved opening-balance review for FY26 with partner items (capital 50,000 credit; current 3,000 debit i.e. partner owes the company).
    const ob = await h.postedJournal(co.id, co.fy, '2026-01-01', co.owner.id, [[co.bankGl, '47000.00', '0'], [co.currentA, '3000.00', '0'], [co.capital, '0', '50000.00']], { entry_type: 'opening_balance' });
    const review = (await h.q<{ id: string }>("INSERT INTO opening_balance_reviews(company_id,fiscal_year_id,status,prepared_by) VALUES($1,$2,'draft',$3) RETURNING id", [co.id, co.fy, co.owner.id]))[0]!.id;
    for (const [cat, acc, amt, side] of [['partner_capital', co.capital, '50000.00', 'credit'], ['partner_current', co.currentA, '3000.00', 'debit']] as const) {
      await h.q("INSERT INTO opening_balance_items(company_id,review_id,category,account_id,amount,balance_side,partner_id,source_type,confidence,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'original_document','high',$8)", [co.id, review, cat, acc, amt, side, co.partnerA, co.owner.id]);
    }
    await h.q("UPDATE opening_balance_reviews SET status='approved',journal_entry_id=$2,submitted_by=$3,submitted_at=NOW(),approved_by=$3,approved_at=NOW() WHERE id=$1", [review, ob, co.owner.id]);
    const postIt = async (o: Record<string, unknown>) => { const d = await draft(co, o); const r = await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {}); expect(r.status).toBe(200); return d.id; };
    await postIt({ transaction_type: 'current_deposit', transaction_date: '2026-02-01', amount: '1000.00' });
    const wrong = await postIt({ transaction_type: 'current_withdrawal', transaction_date: '2026-03-01', amount: '400.00' });
    await postIt({ transaction_type: 'capital_contribution', transaction_date: '2026-04-01', amount: '8000.00' });
    await postIt({ transaction_type: 'loan_received', transaction_date: '2026-04-15', amount: '2000.00', channel: 'bank', bank_account_id: co.bank });
    await postIt({ transaction_type: 'loan_repayment', transaction_date: '2026-06-15', amount: '500.00', channel: 'bank', bank_account_id: co.bank });
    await co.poster.client.req('POST', `/partners/transactions/${wrong}/reverse`, { reversal_date: '2026-03-05', reason: 'wrong partner' });
    await draft(co, { transaction_date: '2026-05-01', amount: '9999.00' });                       // draft: never counted
    await postIt({ partner_id: co.partnerB, transaction_type: 'current_deposit', transaction_date: '2026-02-01', amount: '777.00' });

    const full = (await co.owner.client.req('GET', `/partners/${co.partnerA}/ledger?from=2026-01-01&to=2026-12-31`)).json;
    expect(full.classes.capital).toEqual({ opening_balance: '50000.00', increases: '8000.00', decreases: '0.00', closing_balance: '58000.00' });
    expect(full.classes.current).toEqual({ opening_balance: '-3000.00', increases: '1400.00', decreases: '400.00', closing_balance: '-2000.00' });
    expect(full.classes.loan).toEqual({ opening_balance: '0.00', increases: '2000.00', decreases: '500.00', closing_balance: '1500.00' });
    expect(full.draft_transactions_excluded).toBe(1);
    expect(full.movements.map((m: { kind: string }) => m.kind)).toEqual(['transaction', 'transaction', 'reversal', 'transaction', 'transaction', 'transaction']);
    const currentRows = full.movements.filter((m: { account_class: string }) => m.account_class === 'current');
    expect(currentRows.map((m: { running_balance: string }) => m.running_balance)).toEqual(['-2000.00', '-2400.00', '-2000.00']);
    // A later window folds earlier movements into the opening balance; the partner's other class and other partners are untouched.
    const later = (await co.owner.client.req('GET', `/partners/${co.partnerA}/ledger?from=2026-04-10&to=2026-12-31`)).json;
    expect(later.classes.capital.opening_balance).toBe('58000.00');
    expect(later.classes.current.opening_balance).toBe('-2000.00');
    expect(later.classes.loan).toEqual({ opening_balance: '0.00', increases: '2000.00', decreases: '500.00', closing_balance: '1500.00' });
    const bal = (await co.owner.client.req('GET', '/partners/balances?as_of=2026-12-31')).json;
    expect(bal.partners.find((p: { partner_name: string }) => p.partner_name === 'Partner B')).toMatchObject({ current: '777.00', capital: '0.00' });
    expect(bal.partners.find((p: { partner_name: string }) => p.partner_name === 'Partner A')).toMatchObject({ capital: '58000.00', current: '-2000.00', loan: '1500.00' });
    expect((await co.owner.client.req('GET', `/partners/${co.partnerA}/ledger?from=2026-12-31&to=2026-01-01`)).status).toBe(400);
    // Reconciliation with the general ledger: opening journal + posted movements (net of the reversal) equal the partner ledger closing balances.
    const gl = async (acc: string) => (await h.q<{ n: string }>("SELECT (COALESCE(SUM(l.credit),0)-COALESCE(SUM(l.debit),0))::text n FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE l.account_id=$1 AND j.status='posted'", [acc]))[0]!.n;
    expect(await gl(co.capital)).toBe(full.classes.capital.closing_balance);
    expect(await gl(co.currentA)).toBe(full.classes.current.closing_balance);
    expect(await gl(co.loan)).toBe(full.classes.loan.closing_balance);
  });

  it('flows into trial balance and equity statements without double counting, and flags drafts in annual readiness', async () => {
    const co = await setup('report');
    await mapAll(co);
    const post = async (o: Record<string, unknown>) => { const d = await draft(co, o); expect((await co.poster.client.req('POST', `/partners/transactions/${d.id}/post`, {})).status).toBe(200); };
    await post({ transaction_type: 'capital_contribution', amount: '10000.00' });
    await post({ transaction_type: 'current_withdrawal', amount: '1500.00', transaction_date: '2026-03-20' });
    await draft(co, { transaction_type: 'current_deposit', amount: '5.00', transaction_date: '2026-03-21' });
    const tb = await co.owner.client.req('GET', `/trial-balance?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-12-31`);
    expect(tb.status).toBe(200);
    const text = JSON.stringify(tb.json);
    expect(text).toContain('E-CAP');
    expect(text).toContain('E-CUR-A');
    const eq = await co.owner.client.req('GET', `/financial-statements/changes-in-equity?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-12-31`);
    expect(eq.status).toBe(200);
    expect(eq.json.reconciliation.balanced).toBe(true);
    // 10,000 capital + (-1,500) withdrawal from the equity-classified current account = 8,500 of direct equity movement; the draft is not counted.
    expect(eq.json.direct_equity_movements).toBe('8500.00');
    const annual = await co.owner.client.req('GET', `/annual-closing/${co.fy}`);
    expect(annual.status).toBe(200);
    expect(annual.json.domains.partners.summary.draft_partner_transactions).toBe(1);
    expect(annual.json.domains.partners.blocker_count).toBe(1);
    expect(annual.json.domains.partners.status).toBe('blocked');
    // Posting the draft clears it: the same movement is never counted as both a draft and a posted entry.
    const draftId = (await h.q<{ id: string }>("SELECT id FROM partner_transactions WHERE company_id=$1 AND status='draft'", [co.id]))[0]!.id;
    expect((await co.poster.client.req('POST', `/partners/transactions/${draftId}/post`, {})).status).toBe(200);
    const after = await co.owner.client.req('GET', `/annual-closing/${co.fy}`);
    expect(after.json.domains.partners.summary.draft_partner_transactions).toBe(0);
    expect(after.json.domains.partners.blocker_count).toBe(0);
    expect(after.json.domains.ledger.summary.unposted_operational_sources).toBe(annual.json.domains.ledger.summary.unposted_operational_sources);
  });
});
