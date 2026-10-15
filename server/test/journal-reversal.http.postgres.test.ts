import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// Posted-journal reversal over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('posted manual journal reversal (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  const u: Record<string, Awaited<ReturnType<Awaited<ReturnType<typeof startHarness>>['user']>>> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    h = await startHarness();
    for (const l of ['ownerA', 'ownerB', 'reverser', 'accountant']) u[l] = await h.user(l);
    ids.A = await h.company('A', u.ownerA!.id);
    ids.B = await h.company('B', u.ownerB!.id);
    await h.member(ids.A!, u.reverser!.id, ['accounting.view', 'accounting.journal.reverse']);
    await h.member(ids.A!, u.accountant!.id, ['accounting.view', 'accounting.journal.create', 'accounting.journal.edit', 'accounting.journal.post']);
    ids.fy = await h.fiscalYear(ids.A!, 'FY26', '2026-01-01', '2026-12-31');
    ids.fyOld = await h.fiscalYear(ids.A!, 'FY25', '2025-01-01', '2025-12-31', 'closed');
    ids.bank = await h.account(ids.A!, 'R-BANK', 'asset', 'current_asset');
    ids.rev = await h.account(ids.A!, 'R-REV', 'revenue', 'revenue');
    ids.exp = await h.account(ids.A!, 'R-EXP', 'expense', 'operating_expense');
    ids.fyB = await h.fiscalYear(ids.B!, 'FY26', '2026-01-01', '2026-12-31');
    for (const l of Object.keys(u)) await u[l]!.client.login();
  });
  afterAll(() => h.close());

  const manual = (date = '2026-03-10', fy = ids.fy!, memo?: string) =>
    h.postedJournal(ids.A!, fy, date, u.ownerA!.id, [[ids.bank!, '250.00', '0'], [ids.rev!, '0', '250.00']], memo ? { memo } : {});
  const reverse = (who: string, id: string, body: Record<string, unknown> = { accounting_date: '2026-04-01', reason: 'Posted to the wrong account' }) =>
    u[who]!.client.req('POST', `/journals/${id}/reverse`, body);
  const snapshot = async (id: string) => JSON.stringify({
    j: await h.q('SELECT status,accounting_date::text,description,reference,source_type,entry_type,posted_by FROM journal_entries WHERE id=$1', [id]),
    l: await h.q('SELECT account_id,debit::text,credit::text,sequence FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence', [id]),
  });

  it('registers the capability for the wildcard only: Full Access can reverse; accountant and unlisted users cannot; cross-origin refused', async () => {
    expect((await h.q('SELECT implicit_full_access FROM capabilities WHERE id=$1', ['accounting.journal.reverse']))[0]!.implicit_full_access).toBe(true);
    expect(await h.count("SELECT COUNT(*)::text n FROM role_capabilities WHERE capability_id IN ('accounting.journal.reverse','fiscal_year.carryforward.prepare') AND role_id IN (SELECT id FROM roles WHERE company_id=$1 AND name NOT LIKE 'r-%')", [ids.A])).toBe(0);
    const id = await manual();
    expect((await reverse('accountant', id)).status).toBe(403);
    expect((await u.reverser!.client.req('POST', `/journals/${id}/reverse`, { accounting_date: '2026-04-01', reason: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE reversal_of_journal_id=$1', [id])).toBe(0);
    expect((await reverse('ownerA', id)).status).toBe(201);
  });

  it('creates a separate balanced mirror journal, links it, leaves the original untouched and audits with the reason', async () => {
    const id = await manual('2026-03-11');
    const before = await snapshot(id);
    const res = await reverse('reverser', id);
    expect(res.status).toBe(201);
    const rev = res.json.reversal;
    expect(rev.status).toBe('posted');
    expect(rev.reversal_of_journal_id).toBe(id);
    expect(rev.id).not.toBe(id);
    expect(await snapshot(id)).toBe(before);
    const lines = await h.q('SELECT account_id,debit::text,credit::text FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence', [rev.id]);
    expect(lines).toEqual([{ account_id: ids.bank, debit: '0.00', credit: '250.00' }, { account_id: ids.rev, debit: '250.00', credit: '0.00' }]);
    const sums = (await h.q<{ d: string; c: string }>('SELECT SUM(debit)::text d,SUM(credit)::text c FROM journal_lines WHERE journal_entry_id=$1', [rev.id]))[0]!;
    expect(sums.d).toBe(sums.c);
    const read = await u.reverser!.client.req('GET', `/journals/${id}`);
    expect(read.json.reversed_by_journal_id).toBe(rev.id);
    const audit = (await h.q('SELECT actor_user_id,reason,after_data FROM audit_log WHERE action=$1 AND entity_id=$2', ['journal.reverse', id]))[0]!;
    expect(audit.actor_user_id).toBe(u.reverser!.id);
    expect(audit.reason).toBe('Posted to the wrong account');
    expect(audit.after_data.reversal_journal_id).toBe(rev.id);
    // Net effect on the ledger for both journals together is zero.
    const net = (await h.q<{ n: string }>('SELECT COALESCE(SUM(debit-credit),0)::text n FROM journal_lines WHERE journal_entry_id=ANY($1::uuid[])', [[id, rev.id]]))[0]!.n;
    expect(Number(net)).toBe(0);
  });

  it('refuses a duplicate reversal and lets exactly one of many concurrent requests win', async () => {
    const id = await manual('2026-03-12');
    const results = await Promise.all(Array.from({ length: 6 }, () => reverse('ownerA', id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) expect([r.status, r.json.code]).toEqual([409, 'JOURNAL_ALREADY_REVERSED']);
    expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE reversal_of_journal_id=$1', [id])).toBe(1);
    expect((await reverse('ownerA', id)).json.code).toBe('JOURNAL_ALREADY_REVERSED');
  });

  it('only reverses eligible entries: not drafts, system-generated, opening balances, reversals or VAT-tagged journals', async () => {
    const draft = (await h.q<{ id: string }>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,'2026-03-13','d',$3) RETURNING id", [ids.A, ids.fy, u.ownerA!.id]))[0]!.id;
    expect((await reverse('ownerA', draft)).json.code).toBe('JOURNAL_REVERSAL_NOT_POSTED');
    const system = await h.postedJournal(ids.A!, ids.fy!, '2026-03-13', u.ownerA!.id, [[ids.bank!, '10.00', '0'], [ids.rev!, '0', '10.00']], { source_type: 'obligation', source_id: randomUUID() });
    expect((await reverse('ownerA', system)).json.code).toBe('JOURNAL_REVERSAL_SYSTEM_GENERATED');
    const opening = await h.postedJournal(ids.A!, ids.fyOld!, '2025-01-01', u.ownerA!.id, [[ids.bank!, '10.00', '0'], [ids.rev!, '0', '10.00']], { entry_type: 'opening_balance' });
    expect((await reverse('ownerA', opening, { accounting_date: '2026-04-01', reason: 'x' })).json.code).toBe('JOURNAL_REVERSAL_NOT_ELIGIBLE');
    const original = await manual('2026-03-14');
    const first = await reverse('ownerA', original);
    expect((await reverse('ownerA', first.json.reversal.id)).json.code).toBe('JOURNAL_IS_REVERSAL');
    const vat = await manual('2026-03-14', ids.fy!, 'VAT_OUTPUT');
    expect((await reverse('ownerA', vat)).json.code).toBe('JOURNAL_REVERSAL_VAT_TAGGED');
    for (const j of [draft, system, opening, vat]) expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE reversal_of_journal_id=$1', [j])).toBe(0);
  });

  it('enforces the reversal date: closed month, closed fiscal year, before the original, future, bad input', async () => {
    const id = await manual('2026-05-05');
    const total = () => h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1', [ids.A]);
    const base = await total();
    await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-06-01','2026-06-30','closed')", [ids.A, ids.fy]);
    const closedMonth = await reverse('ownerA', id, { accounting_date: '2026-06-10', reason: 'x' });
    expect([closedMonth.status, closedMonth.json.code]).toEqual([409, 'ACCOUNTING_PERIOD_CLOSED']);
    const closedYear = await reverse('ownerA', id, { accounting_date: '2025-12-31', reason: 'x' });
    expect(closedYear.status).toBe(400); // before the original journal date
    const oldJournal = await h.postedJournal(ids.A!, ids.fyOld!, '2025-06-01', u.ownerA!.id, [[ids.bank!, '5.00', '0'], [ids.rev!, '0', '5.00']]);
    const base2 = await total();
    const fyClosed = await reverse('ownerA', oldJournal, { accounting_date: '2025-07-01', reason: 'x' });
    expect([fyClosed.status, fyClosed.json.code]).toEqual([409, 'FISCAL_YEAR_CLOSED']);
    expect((await reverse('ownerA', id, { accounting_date: '2026-05-01', reason: 'x' })).status).toBe(400);
    expect((await reverse('ownerA', id, { accounting_date: '2099-01-01', reason: 'x' })).status).toBe(400);
    for (const bad of [{}, { accounting_date: '2026-07-01' }, { accounting_date: '2026-07-01', reason: '   ' }, { accounting_date: '2026-02-30', reason: 'x' }, { accounting_date: '2026-07-01', reason: 'x', company_id: ids.B }]) {
      expect((await reverse('ownerA', id, bad as Record<string, unknown>)).status).toBe(400);
    }
    expect(await total()).toBe(base2);
    expect(base2).toBe(base + 1); // only the fixture journal added in between
    expect((await reverse('ownerA', id, { accounting_date: '2026-07-01', reason: 'ok' })).status).toBe(201);
  });

  it('keeps companies isolated', async () => {
    const id = await manual('2026-03-20');
    const cross = await reverse('ownerB', id);
    expect(cross.status).toBe(404);
    expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE reversal_of_journal_id=$1', [id])).toBe(0);
    expect((await u.ownerB!.client.req('GET', `/journals/${id}`)).status).toBe(404);
  });

  it('is enforced by the database too: posted journals stay immutable, one reversal per journal, no reversal of system journals', async () => {
    const id = await manual('2026-03-21');
    await expect(h.q('UPDATE journal_entries SET description=$2 WHERE id=$1', [id, 'tamper'])).rejects.toThrow(/immutable/);
    const insert = (of: string, date = '2026-04-02') => h.q(
      "INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by,reversal_of_journal_id,reversal_reason) VALUES($1,$2,$3,'r',$4,$5,'why')", [ids.A, ids.fy, date, u.ownerA!.id, of]);
    await insert(id);
    await expect(insert(id)).rejects.toThrow(/journal_entries_one_reversal_uidx|duplicate/);
    const system = await h.postedJournal(ids.A!, ids.fy!, '2026-03-21', u.ownerA!.id, [[ids.bank!, '1.00', '0'], [ids.rev!, '0', '1.00']], { source_type: 'obligation', source_id: randomUUID() });
    await expect(insert(system)).rejects.toThrow(/manual journal/);
    const other = await h.postedJournal(ids.B!, ids.fyB!, '2026-03-21', u.ownerB!.id, [[await h.account(ids.B!, `B-${randomUUID().slice(0, 4)}`, 'asset', 'current_asset'), '1.00', '0'], [await h.account(ids.B!, `B-${randomUUID().slice(0, 4)}`, 'revenue', 'revenue'), '0', '1.00']]);
    await expect(insert(other)).rejects.toThrow(); // cross-company link fails the composite FK
  });
});
