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
  async function setup(label: string, ownerId: string, o: { next?: boolean; close?: boolean } = {}): Promise<Co> {
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
    await post('2025-03-01', [[bank, '5000.00', '0'], [rev, '0', '5000.00']]);
    await post('2025-04-01', [[exp, '2000.00', '0'], [bank, '0', '1300.00'], [ap, '0', '700.00']]);
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
});
