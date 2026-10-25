import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// Year-end carry-forward over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('fiscal-year carry-forward (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  const u: Record<string, Awaited<ReturnType<Awaited<ReturnType<typeof startHarness>>['user']>>> = {};
  type Co = { owner: string; id: string; fy25: string; fy26: string | null; bank: string; capital: string; re: string; rev: string; exp: string; ap: string };
  let A: Co; let B: Co;

  /** FY2025 (closed by the test when asked) with: capital 10000, sales 5000, expense 2000, supplier payable 700 -> profit 3000, bank 13000-700... */
  /** Each company gets its own Full Access owner (the session's active company is the owner's first membership). */
  async function setup(label: string, ownerId: string, o: { next?: boolean; close?: boolean; re?: [side: 'debit' | 'credit', amount: string]; revenue?: string } = {}): Promise<Co> {
    let ownerKey = ownerId === u.ownerA!.id ? 'ownerA' : 'ownerB';
    if (!/^cf[AB]$/.test(label)) { u[label] = await h.user(label); ownerKey = label; ownerId = u[label]!.id; }
    const owner = ownerId;
    const id = await h.company(label, owner);
    if (u[label]?.client && !u[label]!.client.cookie) await u[label]!.client.login();
    const fy25 = await h.fiscalYear(id, 'FY25', '2025-01-01', '2025-12-31');
    const fy26 = o.next === false ? null : await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const bank = await h.account(id, 'C-BANK', 'asset', 'current_asset');
    const capital = await h.account(id, 'C-CAP', 'equity', 'equity');
    const re = await h.account(id, 'C-RE', 'equity', 'equity');
    const rev = await h.account(id, 'C-REV', 'revenue', 'revenue');
    const exp = await h.account(id, 'C-EXP', 'expense', 'operating_expense');
    const ap = await h.account(id, 'C-AP', 'liability', 'current_liability');
    const post = (date: string, lines: Array<[string, string, string]>) => h.postedJournal(id, fy25, date, owner, lines);
    await post('2025-01-02', [[bank, '10000.00', '0'], [capital, '0', '10000.00']]);
    await post('2025-03-01', [[bank, o.revenue ?? '5000.00', '0'], [rev, '0', o.revenue ?? '5000.00']]);
    await post('2025-04-01', [[exp, '2000.00', '0'], [bank, '0', '1300.00'], [ap, '0', '700.00']]);
    if (o.re) await post('2025-05-01', o.re[0] === 'credit' ? [[capital, o.re[1], '0'], [re, '0', o.re[1]]] : [[re, o.re[1], '0'], [capital, '0', o.re[1]]]);
    if (o.close !== false) await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [fy25]);
    return { owner: ownerKey, id, fy25, fy26, bank, capital, re, rev, exp, ap };
  }
  const prep = (who: string, co: Co, body: Record<string, unknown> = { retained_earnings_account_id: co.re }, year = co.fy25) =>
    u[who]!.client.req('POST', `/fiscal-years/${year}/carryforward`, body);
  const journalCount = (co: Co) => h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1', [co.id]);

  beforeAll(async () => {
    h = await startHarness();
    for (const l of ['ownerA', 'ownerB', 'preparer', 'viewer', 'accountant']) u[l] = await h.user(l);
    A = await setup('cfA', u.ownerA!.id, { close: false });
    B = await setup('cfB', u.ownerB!.id);
    await h.member(A.id, u.preparer!.id, ['accounting.view', 'opening_balance.view', 'fiscal_year.carryforward.prepare']);
    await h.member(A.id, u.viewer!.id, ['accounting.view', 'opening_balance.view']);
    await h.member(A.id, u.accountant!.id, ['accounting.view', 'opening_balance.view', 'opening_balance.item.create', 'opening_balance.submit', 'fiscal_year.view']);
    for (const l of Object.keys(u)) await u[l]!.client.login();
  });
  afterAll(() => h.close());

  it('blocks an open fiscal year and changes nothing', async () => {
    const before = await journalCount(A);
    const res = await prep('ownerA', A);
    expect([res.status, res.json.code]).toEqual([409, 'CARRYFORWARD_BLOCKED']);
    expect(res.json.blockers.map((b: { code: string }) => b.code)).toContain('FISCAL_YEAR_NOT_CLOSED');
    expect(await h.count('SELECT COUNT(*)::text n FROM opening_balance_reviews WHERE company_id=$1', [A.id])).toBe(0);
    expect(await journalCount(A)).toBe(before);
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [A.fy25]);
  });

  it('requires the dedicated capability on the server; preview needs only view rights; Full Access holds it by wildcard', async () => {
    expect((await prep('viewer', A)).status).toBe(403);
    expect((await prep('accountant', A)).status).toBe(403);
    expect((await u.viewer!.client.req('GET', `/fiscal-years/${A.fy25}/carryforward`)).status).toBe(200);
    expect((await u.accountant!.client.req('GET', `/fiscal-years/${A.fy25}/carryforward`)).status).toBe(200);
    expect((await u.preparer!.client.req('POST', `/fiscal-years/${A.fy25}/carryforward`, { retained_earnings_account_id: A.re }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await h.q('SELECT implicit_full_access FROM capabilities WHERE id=$1', ['fiscal_year.carryforward.prepare']))[0]!.implicit_full_access).toBe(true);
  });

  it('previews the proposed opening balance: balance-sheet accounts at closing balance, P&L netted into retained earnings, balanced', async () => {
    const res = await u.viewer!.client.req('GET', `/fiscal-years/${A.fy25}/carryforward?retained_earnings_account_id=${A.re}`);
    expect(res.status).toBe(200);
    expect(res.json.ready).toBe(true);
    expect(res.json.net_result).toBe('3000.00');
    expect(res.json.balanced).toBe(true);
    const by = Object.fromEntries(res.json.lines.map((l: any) => [l.account_id, `${l.side}:${l.amount}`]));
    expect(by).toEqual({ [A.bank]: 'debit:13700.00', [A.capital]: 'credit:10000.00', [A.ap]: 'credit:700.00', [A.re]: 'credit:3000.00' });
    expect(res.json.total_debit).toBe('13700.00');
    expect(res.json.total_credit).toBe('13700.00');
    expect((await u.viewer!.client.req('GET', `/fiscal-years/${A.fy25}/carryforward`)).json.ready).toBe(false);
  });

  it('rejects an unusable retained-earnings account (wrong type, other company, unknown) without side effects', async () => {
    for (const bad of [A.bank, B.re, A.rev, '00000000-0000-4000-8000-000000000000']) {
      expect((await prep('ownerA', A, { retained_earnings_account_id: bad })).status).toBe(400);
    }
    expect((await prep('ownerA', A, {})).status).toBe(400);
    expect((await prep('ownerA', A, { retained_earnings_account_id: A.re, company_id: B.id })).status).toBe(400);
    expect(await h.count('SELECT COUNT(*)::text n FROM opening_balance_reviews WHERE company_id=$1', [A.id])).toBe(0);
  });

  it('prepares ONE draft opening balance review, posts nothing, leaves prior-year history untouched, audits', async () => {
    const fy25Before = JSON.stringify(await h.q('SELECT id,status,accounting_date::text FROM journal_entries WHERE fiscal_year_id=$1 ORDER BY id', [A.fy25]));
    const journalsBefore = await journalCount(A);
    const res = await prep('preparer', A);
    expect(res.status).toBe(201);
    expect(res.json.review.status).toBe('draft');
    expect(res.json.review.fiscal_year_id).toBe(A.fy26);
    expect(res.json.carryforward).toMatchObject({ net_result: '3000.00', total_debit: '13700.00', total_credit: '13700.00', item_count: 4 });
    expect(await journalCount(A)).toBe(journalsBefore); // nothing posted or drafted
    expect(JSON.stringify(await h.q('SELECT id,status,accounting_date::text FROM journal_entries WHERE fiscal_year_id=$1 ORDER BY id', [A.fy25]))).toBe(fy25Before);
    const items = await h.q<{ balance_side: string; amount: string; source_type: string }>('SELECT balance_side,amount::text,source_type FROM opening_balance_items WHERE review_id=$1', [res.json.review.id]);
    expect(items).toHaveLength(4);
    expect(items.every((i) => i.source_type === 'internal_ledger')).toBe(true);
    const sum = (side: string) => items.filter((i) => i.balance_side === side).reduce((s, i) => s + Number(i.amount), 0);
    expect(sum('debit')).toBe(sum('credit'));
    expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='fiscal_year.carryforward.prepare' AND actor_user_id=$2", [A.id, u.preparer!.id])).toBe(1);
    await expect(h.q('DELETE FROM fiscal_year_carryforwards WHERE company_id=$1', [A.id])).rejects.toThrow(/immutable/);
  });

  it('is idempotent: a repeated request is refused and nothing is duplicated', async () => {
    const again = await prep('ownerA', A);
    expect([again.status, again.json.code]).toEqual([409, 'CARRYFORWARD_ALREADY_PREPARED']);
    expect(await h.count('SELECT COUNT(*)::text n FROM opening_balance_reviews WHERE company_id=$1', [A.id])).toBe(1);
    expect(await h.count('SELECT COUNT(*)::text n FROM opening_balance_items WHERE company_id=$1', [A.id])).toBe(4);
    expect((await u.ownerA!.client.req('GET', `/fiscal-years/${A.fy25}/carryforward`)).json.ready).toBe(false);
  });

  it('carries the balances through the existing approval flow without double counting; prior-year statements are unchanged', async () => {
    const p26 = () => u.ownerA!.client.req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${A.fy26}`);
    const fp = (fy: string) => u.ownerA!.client.req('GET', `/financial-statements/financial-position?fiscal_year_id=${fy}`);
    const p25Before = (await u.ownerA!.client.req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${A.fy25}`)).json.profit_or_loss;
    expect(p25Before).toBe('3000.00');
    expect((await u.ownerA!.client.req('POST', `/opening-balances/${A.fy26}/submit-review`, {})).status).toBe(200);
    const approved = await u.ownerA!.client.req('POST', `/opening-balances/${A.fy26}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.json.journal.status).toBe('posted');
    const tb = (await u.ownerA!.client.req('GET', `/trial-balance?fiscal_year_id=${A.fy26}`)).json.accounts as any[];
    const bal = (id: string) => tb.find((a) => a.account_id === id);
    expect([bal(A.bank).debit_balance, bal(A.capital).credit_balance, bal(A.re).credit_balance, bal(A.ap).credit_balance]).toEqual(['13700.00', '10000.00', '3000.00', '700.00']);
    expect(tb.reduce((s, a) => s + Number(a.debit_balance), 0)).toBe(tb.reduce((s, a) => s + Number(a.credit_balance), 0));
    const pos = (await fp(A.fy26!)).json;
    expect(pos.accounting_equation.balanced).toBe(true);
    expect(pos.total_assets).toBe('13700.00');
    expect(pos.current_period_earnings).toBe('0.00'); // prior result sits in retained earnings, not counted again
    expect((await p26()).json.profit_or_loss).toBe('0.00');
    expect((await u.ownerA!.client.req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${A.fy25}`)).json.profit_or_loss).toBe(p25Before);
    expect((await fp(A.fy25)).json.accounting_equation.balanced).toBe(true);
  });

  let regression = 0;
  it.each([
    { name: 'existing credit balance + profit', re: ['credit', '1000.00'], revenue: '5000.00', expected: 'credit:4000.00' },
    { name: 'existing debit balance + smaller profit', re: ['debit', '5000.00'], revenue: '5000.00', expected: 'debit:2000.00' },
    { name: 'existing debit balance + profit flips to credit', re: ['debit', '1000.00'], revenue: '5000.00', expected: 'credit:2000.00' },
    { name: 'existing credit balance + loss', re: ['credit', '1000.00'], revenue: '1000.00', expected: 'credit:0.00' },
    { name: 'existing debit balance exactly offset by profit', re: ['debit', '3000.00'], revenue: '5000.00', expected: null },
    { name: 'existing debit balance + loss', re: ['debit', '1000.00'], revenue: '1000.00', expected: 'debit:2000.00' },
  ] as const)('consolidates the retained-earnings balance and the year result into one net line: $name', async ({ re, revenue, expected, name }) => {
    // profit = revenue - 2000 (so 3000, 3000, 3000, -1000, 3000, -1000); the loss cases net against the existing balance.
    const co = await setup(`cfR${++regression}`, u.ownerA!.id, { re: [re[0], re[1]], revenue });
    const preview = await u[co.owner]!.client.req('GET', `/fiscal-years/${co.fy25}/carryforward?retained_earnings_account_id=${co.re}`);
    expect(preview.json.balanced).toBe(true);
    const res = await prep(co.owner, co);
    expect(res.status).toBe(201);
    const items = await h.q<{ account_id: string; balance_side: string; amount: string }>('SELECT account_id,balance_side,amount::text FROM opening_balance_items WHERE review_id=$1', [res.json.review.id]);
    expect(new Set(items.map((i) => i.account_id)).size).toBe(items.length); // never two lines for one account
    const reItems = items.filter((i) => i.account_id === co.re);
    if (expected === null) expect(reItems).toHaveLength(0);
    else if (expected === 'credit:0.00') {
      // existing credit 1000 + loss 1000 = zero -> no line at all
      expect(reItems).toHaveLength(0);
    } else expect(reItems.map((i) => `${i.balance_side}:${i.amount}`)).toEqual([expected]);
    const sum = (side: string) => items.filter((i) => i.balance_side === side).reduce((t, i) => t + Number(i.amount), 0);
    expect(sum('debit')).toBeCloseTo(sum('credit'), 2);
    expect(Number(res.json.carryforward.total_debit)).toBeCloseTo(sum('debit'), 2);
  });

  it('approves and posts the consolidated opening balance: retained earnings = existing balance + result, books balanced, no double count', async () => {
    const co = await setup('cfRP', u.ownerA!.id, { re: ['credit', '1000.00'] });
    const o = u[co.owner]!.client;
    expect((await prep(co.owner, co)).status).toBe(201);
    expect((await o.req('POST', `/opening-balances/${co.fy26}/submit-review`, {})).status).toBe(200);
    const approved = await o.req('POST', `/opening-balances/${co.fy26}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.json.journal.status).toBe('posted');
    const lines = await h.q<{ account_id: string; debit: string; credit: string }>('SELECT account_id,debit::text,credit::text FROM journal_lines WHERE journal_entry_id=$1', [approved.json.journal.id]);
    expect(lines.filter((l) => l.account_id === co.re)).toEqual([{ account_id: co.re, debit: '0.00', credit: '4000.00' }]);
    expect(lines.reduce((t, l) => t + Number(l.debit), 0)).toBe(lines.reduce((t, l) => t + Number(l.credit), 0));
    const tb = (await o.req('GET', `/trial-balance?fiscal_year_id=${co.fy26}`)).json.accounts as any[];
    expect(tb.find((a) => a.account_id === co.re).credit_balance).toBe('4000.00');
    const pos = (await o.req('GET', `/financial-statements/financial-position?fiscal_year_id=${co.fy26}`)).json;
    expect(pos.accounting_equation.balanced).toBe(true);
    expect(pos.current_period_earnings).toBe('0.00');
  });

  it('lets exactly one of many concurrent requests prepare the carry-forward', async () => {
    const C = await setup('cfC', u.ownerA!.id);
    await h.member(C.id, u.preparer!.id, ['fiscal_year.carryforward.prepare']);
    const results = await Promise.all(Array.from({ length: 6 }, () => prep(C.owner, C)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) expect([r.status, r.json.code]).toEqual([409, 'CARRYFORWARD_ALREADY_PREPARED']);
    expect(await h.count('SELECT COUNT(*)::text n FROM opening_balance_reviews WHERE company_id=$1', [C.id])).toBe(1);
    expect(await h.count('SELECT COUNT(*)::text n FROM opening_balance_items WHERE company_id=$1', [C.id])).toBe(4);
    expect(await h.count('SELECT COUNT(*)::text n FROM fiscal_year_carryforwards WHERE company_id=$1', [C.id])).toBe(1);
  });

  it('blocks a missing next year, an existing opening balance, a closed next year and a closed first month, with no side effects', async () => {
    const noNext = await setup('cfD', u.ownerA!.id, { next: false });
    const r1 = await prep(noNext.owner, noNext);
    expect(r1.json.blockers.map((b: any) => b.code)).toContain('NEXT_FISCAL_YEAR_MISSING');

    const existing = await setup('cfE', u.ownerA!.id);
    await h.q('INSERT INTO opening_balance_reviews(company_id,fiscal_year_id,prepared_by) VALUES($1,$2,$3)', [existing.id, existing.fy26, u.ownerA!.id]);
    const r2 = await prep(existing.owner, existing);
    expect(r2.json.blockers.map((b: any) => b.code)).toContain('OPENING_BALANCE_ALREADY_EXISTS');

    const closedNext = await setup('cfF', u.ownerA!.id);
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [closedNext.fy26]);
    expect((await prep(closedNext.owner, closedNext)).json.blockers.map((b: any) => b.code)).toContain('NEXT_FISCAL_YEAR_CLOSED');

    const closedMonth = await setup('cfG', u.ownerA!.id);
    await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-01-01','2026-01-31','closed')", [closedMonth.id, closedMonth.fy26]);
    const r4 = await prep(closedMonth.owner, closedMonth);
    expect([r4.status, r4.json.code]).toEqual([409, 'ACCOUNTING_PERIOD_CLOSED']);

    for (const co of [noNext, closedNext, closedMonth]) {
      expect(await h.count('SELECT COUNT(*)::text n FROM opening_balance_reviews WHERE company_id=$1', [co.id])).toBe(0);
      expect(await h.count('SELECT COUNT(*)::text n FROM fiscal_year_carryforwards WHERE company_id=$1', [co.id])).toBe(0);
    }
    expect(await h.count('SELECT COUNT(*)::text n FROM fiscal_year_carryforwards WHERE company_id=$1', [existing.id])).toBe(0);
  });

  it('keeps companies isolated', async () => {
    for (const method of ['GET', 'POST'] as const) {
      const res = await u.ownerB!.client.req(method, `/fiscal-years/${A.fy25}/carryforward`, method === 'POST' ? { retained_earnings_account_id: B.re } : undefined);
      expect(res.status).toBe(404);
    }
    expect((await prep('ownerA', B, { retained_earnings_account_id: B.re }, B.fy25)).status).toBe(404);
    expect(await h.count('SELECT COUNT(*)::text n FROM opening_balance_reviews WHERE company_id=$1', [B.id])).toBe(0);
  });

  it('refuses to carry an unbalanced prior-year ledger', async () => {
    const bad = await setup('cfH', u.ownerA!.id);
    await h.q('ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_posted_immutable');
    await h.q('ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_posted_immutable');
    await h.q("UPDATE journal_lines SET debit=debit+1 WHERE id=(SELECT l.id FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.company_id=$1 AND l.debit>0 LIMIT 1)", [bad.id]);
    await h.q('ALTER TABLE journal_entries ENABLE TRIGGER journal_entries_posted_immutable');
    await h.q('ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_posted_immutable');
    const res = await prep(bad.owner, bad);
    expect(res.json.blockers.map((b: any) => b.code)).toContain('TRIAL_BALANCE_UNBALANCED');
    expect(await h.count('SELECT COUNT(*)::text n FROM opening_balance_reviews WHERE company_id=$1', [bad.id])).toBe(0);
  });

  // ── P1 (Owner policies F1, F2, F5): carry-forward approval reconciliation, subsequent-year close prerequisite, exact halalas ──
  const client = (co: Co) => u[co.owner]!.client;
  const submit = (co: Co, fy = co.fy26!) => client(co).req('POST', `/opening-balances/${fy}/submit-review`, {});
  const approve = (co: Co, fy = co.fy26!) => client(co).req('POST', `/opening-balances/${fy}/approve`, {});
  const closeYear = (co: Co, fy: string) => client(co).req('POST', `/fiscal-years/${fy}/close`, {});
  const codes = (res: { json: any }) => (res.json?.blockers ?? []).map((b: { code: string }) => b.code);
  const closeMonths = async (co: Co, fy: string, year: number) => {
    for (let m = 1; m <= 12; m++) {
      await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,$3,$4,'closed')",
        [co.id, fy, new Date(Date.UTC(year, m - 1, 1)).toISOString().slice(0, 10), new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10)]);
    }
  };
  const reviewOf = async (co: Co, fy = co.fy26!) => (await h.q<{ id: string; status: string; journal_entry_id: string | null }>(
    'SELECT id,status,journal_entry_id FROM opening_balance_reviews WHERE company_id=$1 AND fiscal_year_id=$2', [co.id, fy]))[0]!;
  const itemOf = async (co: Co, account: string) => (await h.q<{ id: string; amount: string; balance_side: string; version: number }>(
    'SELECT i.id,i.amount::text,i.balance_side,i.version FROM opening_balance_items i JOIN opening_balance_reviews r ON r.id=i.review_id WHERE r.company_id=$1 AND r.fiscal_year_id=$2 AND i.account_id=$3',
    [co.id, co.fy26, account]))[0]!;
  const postedOpenings = (co: Co, fy = co.fy26!) => h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND fiscal_year_id=$2 AND entry_type='opening_balance' AND status='posted'", [co.id, fy]);
  const balanceOf = async (co: Co, fy: string, account: string) => {
    const row = ((await client(co).req('GET', `/trial-balance?fiscal_year_id=${fy}`)).json.accounts as any[]).find((a) => a.account_id === account);
    if (!row || (!Number(row.debit_balance) && !Number(row.credit_balance))) return 'none';
    return Number(row.debit_balance) ? `debit:${row.debit_balance}` : `credit:${row.credit_balance}`;
  };
  const expectRejected = async (co: Co) => {
    const res = await approve(co);
    expect([res.status, res.json.code]).toEqual([409, 'CARRYFORWARD_RECONCILIATION_MISMATCH']);
    const review = await reviewOf(co);
    expect([review.status, review.journal_entry_id]).toEqual(['in_review', null]); // never corrected, never posted
    expect(await postedOpenings(co)).toBe(0);
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND fiscal_year_id=$2", [co.id, co.fy26])).toBe(0);
    expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='opening_balance.approve'", [co.id])).toBe(0);
    return res.json.mismatches as Array<{ code: string; expected: string; actual: string }>;
  };
  /** setup -> prepare -> submit -> approve (posted) -> close the twelve months of FY26. */
  const carried = async (label: string, o: Parameters<typeof setup>[2] = {}) => {
    const co = await setup(label, u.ownerA!.id, o);
    expect((await prep(co.owner, co)).status).toBe(201);
    expect((await submit(co)).status).toBe(200);
    const approved = await approve(co);
    expect(approved.status).toBe(200);
    await closeMonths(co, co.fy26!, 2026);
    return co;
  };

  describe('P1 B1: carry-forward approval reconciles exactly with the originating year', () => {
    it('rejects a draft modified by review (account replaced), without correcting or posting it', async () => {
      const co = await setup('p1M', u.ownerA!.id);
      expect((await prep(co.owner, co)).status).toBe(201);
      const other = await h.account(co.id, 'C-CAP2', 'equity', 'equity');
      const capital = await itemOf(co, co.capital);
      expect((await client(co).req('PATCH', `/opening-balances/${co.fy26}/items/${capital.id}`, { account_id: other, version: capital.version })).status).toBe(200);
      expect((await submit(co)).status).toBe(200);
      const mismatches = await expectRejected(co);
      expect(mismatches.map((m) => `${m.code}:${m.expected}>${m.actual}`).sort()).toEqual(['C-CAP2:none>credit:10000.00', 'C-CAP:credit:10000.00>missing']);
    });

    it('rejects a balanced but incorrect draft: one halalah moved between two accounts', async () => {
      const co = await setup('p1H', u.ownerA!.id);
      expect((await prep(co.owner, co)).status).toBe(201);
      await h.q('UPDATE opening_balance_items SET amount=amount+0.01 WHERE account_id=ANY($1)', [[co.bank, co.re]]); // still balanced
      expect((await submit(co)).status).toBe(200);
      const mismatches = await expectRejected(co);
      expect(mismatches.map((m) => `${m.code}:${m.expected}>${m.actual}`)).toEqual(['C-BANK:debit:13700.00>debit:13700.01', 'C-RE:credit:3000.00>credit:3000.01']);
    });

    it('rejects a flipped side, a missing required line and an extra zero-net account', async () => {
      const flip = await setup('p1F', u.ownerA!.id);
      expect((await prep(flip.owner, flip)).status).toBe(201);
      await h.q("UPDATE opening_balance_items SET balance_side='debit' WHERE account_id=$1", [flip.ap]);
      await h.q("UPDATE opening_balance_items SET amount=amount-1400 WHERE account_id=$1", [flip.bank]); // keep it balanced
      expect((await submit(flip)).status).toBe(200);
      expect((await expectRejected(flip)).map((m) => m.code)).toEqual(['C-AP', 'C-BANK']);

      const missing = await setup('p1D', u.ownerA!.id);
      expect((await prep(missing.owner, missing)).status).toBe(201);
      await h.q('DELETE FROM opening_balance_items WHERE account_id=ANY($1)', [[missing.ap]]);
      await h.q("UPDATE opening_balance_items SET amount=amount-700 WHERE account_id=$1", [missing.bank]);
      expect((await submit(missing)).status).toBe(200);
      expect((await expectRejected(missing)).map((m) => `${m.code}:${m.actual}`)).toEqual(['C-AP:missing', 'C-BANK:debit:13000.00']);

      const extra = await setup('p1X', u.ownerA!.id);
      expect((await prep(extra.owner, extra)).status).toBe(201);
      const review = await reviewOf(extra);
      const suspense = await h.account(extra.id, 'C-SUSP', 'asset', 'current_asset');
      for (const side of ['debit', 'credit']) {
        await h.q(`INSERT INTO opening_balance_items(company_id,review_id,category,account_id,amount,balance_side,source_type,confidence,created_by) VALUES($1,$2,'other_asset',$3,5,$4,'internal_ledger','high',$5)`,
          [extra.id, review.id, suspense, side, u.ownerA!.id]);
      }
      expect((await submit(extra)).status).toBe(200);
      expect((await expectRejected(extra)).map((m) => `${m.code}:${m.expected}>${m.actual}`)).toEqual(['C-SUSP:none>none']);
    });

    it('cannot be bypassed by posting the opening journal through the canonical posting contract directly', async () => {
      const co = await setup('p1B', u.ownerA!.id);
      expect((await prep(co.owner, co)).status).toBe(201);
      await h.q("UPDATE opening_balance_items SET amount=amount+1 WHERE account_id=ANY($1)", [[co.bank, co.capital]]);
      expect((await submit(co)).status).toBe(200);
      const review = await reviewOf(co);
      const { postJournalInTransaction } = await import('../src/modules/accounting/journal-posting');
      const c = await h.db.connect();
      try {
        await c.query('BEGIN');
        const j = (await c.query<{ id: string }>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,entry_type,created_by) VALUES($1,$2,'2026-01-01','x','opening_balance',$3) RETURNING id", [co.id, co.fy26, u.ownerA!.id])).rows[0]!;
        // The journal itself carries the CORRECT carry-forward; the review items do not. Both must reconcile.
        const lines: Array<[string, string, string]> = [[co.bank, '13700.00', '0'], [co.capital, '0', '10000.00'], [co.ap, '0', '700.00'], [co.re, '0', '3000.00']];
        let seq = 1;
        for (const [acc, d, cr] of lines) await c.query('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,$4,$5,$6)', [co.id, j.id, acc, d, cr, seq++]);
        await expect(postJournalInTransaction(c, co.id, u.ownerA!.id, j.id, { openingBalanceReviewId: review.id })).rejects.toMatchObject({ code: 'CARRYFORWARD_RECONCILIATION_MISMATCH' });
      } finally { await c.query('ROLLBACK'); c.release(); }
      expect(await postedOpenings(co)).toBe(0);
    });

    it('approves and posts a reviewed draft that still matches exactly (a note edit is harmless)', async () => {
      const co = await setup('p1OK', u.ownerA!.id);
      expect((await prep(co.owner, co)).status).toBe(201);
      const re = await itemOf(co, co.re);
      expect((await client(co).req('PATCH', `/opening-balances/${co.fy26}/items/${re.id}`, { note: 'Reviewed by FM', version: re.version })).status).toBe(200);
      expect((await submit(co)).status).toBe(200);
      const res = await approve(co);
      expect(res.status).toBe(200);
      expect(res.json.journal.status).toBe('posted');
      expect(await postedOpenings(co)).toBe(1);
      expect(await balanceOf(co, co.fy26!, co.re)).toBe('credit:3000.00');
    });

    it('leaves an ordinary (non carry-forward) opening balance review unaffected', async () => {
      const co = await setup('p1Ord', u.ownerA!.id);
      const review = (await h.q<{ id: string }>('INSERT INTO opening_balance_reviews(company_id,fiscal_year_id,prepared_by) VALUES($1,$2,$3) RETURNING id', [co.id, co.fy26, u.ownerA!.id]))[0]!;
      for (const [cat, acc, amount, side] of [['other_asset', co.bank, '123.45', 'debit'], ['equity', co.capital, '123.45', 'credit']]) {
        await h.q(`INSERT INTO opening_balance_items(company_id,review_id,category,account_id,amount,balance_side,source_type,confidence,created_by) VALUES($1,$2,$3,$4,$5,$6,'internal_ledger','high',$7)`,
          [co.id, review.id, cat, acc, amount, side, u.ownerA!.id]);
      }
      expect((await submit(co)).status).toBe(200);
      const res = await approve(co);
      expect(res.status).toBe(200);
      expect(res.json.journal.status).toBe('posted');
      // ...but it is not a carry-forward of FY25, so FY26 cannot close on it (F1).
      await closeMonths(co, co.fy26!, 2026);
      const closed = await closeYear(co, co.fy26!);
      expect([closed.status, codes(closed)]).toEqual([409, ['carryforward_missing']]);
    });

    it('lets exactly one of several concurrent approvals post the carry-forward', async () => {
      const co = await setup('p1CA', u.ownerA!.id);
      expect((await prep(co.owner, co)).status).toBe(201);
      expect((await submit(co)).status).toBe(200);
      const results = await Promise.all(Array.from({ length: 5 }, () => approve(co)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
      expect(await postedOpenings(co)).toBe(1);
      expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='opening_balance.approve'", [co.id])).toBe(1);
    });
  });

  describe('P1 B2: a subsequent fiscal year closes only on a valid carry-forward', () => {
    it('blocks while the preceding year is open, while no carry-forward exists and while it is not yet posted', async () => {
      const open = await setup('p1Y1', u.ownerA!.id, { close: false });
      await closeMonths(open, open.fy26!, 2026);
      const r1 = await closeYear(open, open.fy26!);
      expect([r1.status, r1.json.code]).toEqual([409, 'FISCAL_YEAR_CLOSE_BLOCKED']);
      expect(r1.json.blockers).toContainEqual({ code: 'previous_fiscal_year_not_closed', count: 1, detail: 'FY25' });

      const none = await setup('p1Y2', u.ownerA!.id);
      await closeMonths(none, none.fy26!, 2026);
      expect(codes(await closeYear(none, none.fy26!))).toContain('carryforward_missing');

      const pending = await setup('p1Y3', u.ownerA!.id);
      expect((await prep(pending.owner, pending)).status).toBe(201);
      expect((await submit(pending)).status).toBe(200);
      await closeMonths(pending, pending.fy26!, 2026);
      expect(codes(await closeYear(pending, pending.fy26!))).toContain('carryforward_opening_not_posted');
      for (const co of [open, none, pending]) {
        expect((await h.q('SELECT status FROM fiscal_years WHERE id=$1', [co.fy26]))[0]!.status).toBe('open');
        expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='fiscal_year.status_change'", [co.id])).toBe(0);
      }
    });

    it('verifies the carry-forward, not just its existence: a later change to the closed year blocks the close', async () => {
      const co = await carried('p1Y4');
      // Fixture write that bypasses the closed-year guard on purpose (as a data repair would): the posted opening no longer equals FY25.
      await h.postedJournal(co.id, co.fy25, '2025-12-31', u.ownerA!.id, [[co.exp, '0.01', '0'], [co.bank, '0', '0.01']]);
      const res = await closeYear(co, co.fy26!);
      expect(res.status).toBe(409);
      expect(res.json.blockers).toContainEqual({ code: 'carryforward_reconciliation_mismatch', count: 2, detail: 'C-BANK,C-RE' });
    });

    it('blocks a gap between fiscal years (no contiguous preceding year)', async () => {
      const co = await setup('p1Gap', u.ownerA!.id, { next: false });
      const fy27 = await h.fiscalYear(co.id, 'FY27', '2027-01-01', '2027-12-31');
      await closeMonths(co, fy27, 2027);
      expect((await closeYear(co, fy27)).json.blockers).toContainEqual({ code: 'previous_fiscal_year_not_contiguous', count: 1, detail: 'FY25' });
    });

    it.each([
      { name: 'profit', revenue: '5000.00', result: '3000.00', re: 'credit:3000.00' },
      { name: 'loss', revenue: '1000.00', result: '-1000.00', re: 'debit:1000.00' },
      { name: 'complete zero-profit year', revenue: '2000.00', result: '0.00', re: 'none' },
    ])('closes the subsequent year after a valid carry-forward: $name', async ({ revenue, result, re }) => {
      const co = await carried(`p1V${result.replace(/\W/g, '')}`, { revenue });
      const carry = (await h.q<{ net_result: string }>('SELECT net_result::text FROM fiscal_year_carryforwards WHERE company_id=$1', [co.id]))[0]!;
      expect(carry.net_result).toBe(result);
      expect((await client(co).req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${co.fy25}`)).json.profit_or_loss).toBe(result);
      expect(await balanceOf(co, co.fy26!, co.re)).toBe(re);
      const pos = (await client(co).req('GET', `/financial-statements/financial-position?fiscal_year_id=${co.fy26}`)).json;
      expect([pos.accounting_equation.balanced, pos.current_period_earnings]).toEqual([true, '0.00']);
      const res = await closeYear(co, co.fy26!);
      expect([res.status, res.json.fiscalYear?.status]).toEqual([200, 'closed']);
      expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND entity_id=$2 AND action='fiscal_year.status_change'", [co.id, co.fy26])).toBe(1);
    });

    it('lets exactly one of several concurrent close requests close the year', async () => {
      const co = await carried('p1CC');
      const results = await Promise.all(Array.from({ length: 4 }, () => closeYear(co, co.fy26!)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 200)) expect([r.status, r.json.code]).toEqual([409, 'FISCAL_YEAR_ALREADY_CLOSED']);
      expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND entity_id=$2 AND action='fiscal_year.status_change'", [co.id, co.fy26])).toBe(1);
    });

    it('a racing approval and close never leave a closed year without its opening balance', async () => {
      // Approval needs January open; the close needs every month closed: whichever commits first, the other must refuse.
      const co = await setup('p1Race', u.ownerA!.id);
      expect((await prep(co.owner, co)).status).toBe(201);
      expect((await submit(co)).status).toBe(200);
      await closeMonths(co, co.fy26!, 2026);
      const [a, c] = await Promise.all([approve(co), closeYear(co, co.fy26!)]);
      expect(a.status).toBe(409);
      expect(c.status).toBe(409);
      expect(codes(c)).toContain('carryforward_opening_not_posted');
      expect((await h.q('SELECT status FROM fiscal_years WHERE id=$1', [co.fy26]))[0]!.status).toBe('open');
      expect(await postedOpenings(co)).toBe(0);
    });

    it('keeps companies isolated: one company\'s carry-forward never satisfies, closes or blocks another', async () => {
      const x = await carried('p1IsoX');
      const y = await setup('p1IsoY', u.ownerA!.id); // identical ledger, no carry-forward
      await closeMonths(y, y.fy26!, 2026);
      expect((await u.ownerB!.client.req('POST', `/fiscal-years/${x.fy26}/close`, {})).status).toBe(404);
      expect(codes(await closeYear(y, y.fy26!))).toContain('carryforward_missing');
      expect((await closeYear(x, x.fy26!)).status).toBe(200);
      expect((await h.q('SELECT status FROM fiscal_years WHERE id=$1', [y.fy26]))[0]!.status).toBe('open');
    });

    it('reconciles retained earnings across three consecutive years in exact halalas', async () => {
      const co = await carried('p1Three', { revenue: '5000.01' }); // FY25 profit 3000.01
      const fy27 = await h.fiscalYear(co.id, 'FY27', '2027-01-01', '2027-12-31');
      // FY26 activity: revenue 0.10 x 3 + 0.20, expense 100.25 -> loss 99.75 (fractional halalas, exact)
      for (const amount of ['0.10', '0.10', '0.10', '0.20']) await h.postedJournal(co.id, co.fy26!, '2026-06-01', u.ownerA!.id, [[co.bank, amount, '0'], [co.rev, '0', amount]]);
      await h.postedJournal(co.id, co.fy26!, '2026-07-01', u.ownerA!.id, [[co.exp, '100.25', '0'], [co.bank, '0', '100.25']]);
      const soce26 = (await client(co).req('GET', `/financial-statements/changes-in-equity?fiscal_year_id=${co.fy26}`)).json;
      expect([soce26.opening_equity, soce26.current_period_earnings, soce26.closing_equity, soce26.reconciliation.difference, soce26.reconciliation.balanced])
        .toEqual(['13000.01', '-99.75', '12900.26', '0.00', true]);
      expect((await closeYear(co, co.fy26!)).status).toBe(200);

      const next = { ...co, fy25: co.fy26!, fy26: fy27 };
      expect((await prep(co.owner, next)).status).toBe(201);
      expect((await submit(next)).status).toBe(200);
      expect((await approve(next)).status).toBe(200);
      expect(await balanceOf(co, fy27, co.re)).toBe('credit:2900.26'); // 3000.01 - 99.75
      const soce27 = (await client(co).req('GET', `/financial-statements/changes-in-equity?fiscal_year_id=${fy27}`)).json;
      expect(soce27.opening_equity).toBe(soce26.closing_equity); // cross-year reconciliation
      const pos27 = (await client(co).req('GET', `/financial-statements/financial-position?fiscal_year_id=${fy27}`)).json;
      expect([pos27.total_assets, pos27.total_equity, pos27.accounting_equation.difference]).toEqual(['13600.26', '12900.26', '0.00']);
      // Prior years' statements are unchanged by the later carry-forwards (comparatives stay traceable).
      expect((await client(co).req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${co.fy25}`)).json.profit_or_loss).toBe('3000.01');
      expect((await client(co).req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${co.fy26}`)).json.profit_or_loss).toBe('-99.75');
      await closeMonths(co, fy27, 2027);
      expect((await closeYear(co, fy27)).status).toBe(200);
    });
  });
});
