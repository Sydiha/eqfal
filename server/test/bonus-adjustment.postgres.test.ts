import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

const db = process.env['DATABASE_URL'] ? describe : describe.skip;
const ADJUST_CAPS = ['employee.view', 'employee_cost.salary.view', 'employee_cost.correct', 'employee_cost.approve', 'accounting.journal.post', 'employee_cost.view'];

db('approved bonus adjustments (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  /** One recognized SAR 1,000 bonus, created/approved/recognized by three distinct users, plus an independent adjuster. */
  async function fixture(label: string) {
    const owner = await h.user(`${label}-owner`);
    const creator = await h.user(`${label}-creator`);
    const approver = await h.user(`${label}-approver`);
    const recognizer = await h.user(`${label}-recognizer`);
    const adjuster = await h.user(`${label}-adjuster`);
    const outsider = await h.user(`${label}-outsider`);
    const co = await h.company(label, owner.id);
    const other = await h.company(`${label}-other`, outsider.id);
    await h.member(co, creator.id, ADJUST_CAPS);
    await h.member(co, approver.id, ADJUST_CAPS);
    await h.member(co, recognizer.id, ['employee.view', 'employee_cost.salary.view', 'employee_cost.approve', 'accounting.journal.post']);
    await h.member(co, adjuster.id, ADJUST_CAPS);
    for (const u of [owner, creator, approver, recognizer, adjuster, outsider]) await u.client.login();
    const fy = await h.fiscalYear(co, 'FY2026', '2026-01-01', '2026-12-31');
    const employee = (await h.q<{ id: string }>("INSERT INTO employees(company_id,employee_number,display_name,created_by) VALUES($1,'E1','Employee',$2) RETURNING id", [co, owner.id]))[0]!.id;
    const expense = await h.account(co, 'BEXP', 'expense', 'operating_expense');
    const liability = await h.account(co, 'BLIAB', 'liability', 'current_liability');
    const cash = await h.account(co, 'BCASH', 'asset', 'current_asset');
    const bonus = (await h.q<{ id: string }>(`
      INSERT INTO employee_bonus_entitlements(company_id,employee_id,request_key,frequency,period_start,period_end,
        eligibility_condition,recognition_condition,calculation_method,calculation_value,basic_salary,applicable_allowances,
        created_by,approved_by,approved_at,award_code)
      VALUES($1,$2,$3,'monthly','2026-03-01','2026-03-31','Eligible','Verified','fixed',1000,0,0,$4,$5,now(),'adj') RETURNING id
    `, [co, employee, randomUUID(), creator.id, approver.id]))[0]!.id;
    const recognition = await recognizer.client.req('POST', `/employee-bonuses/${bonus}/recognition`, {
      fulfilled_on: '2026-03-15', accounting_date: '2026-03-15', evidence: 'Signed evidence',
      expense_account_id: expense, liability_account_id: liability,
    });
    expect(recognition.status, JSON.stringify(recognition.json)).toBe(201);
    const url = `/employee-bonuses/${bonus}/adjustments`;
    const body = (over: Record<string, unknown> = {}) => ({
      kind: 'increase', amount: '10', accounting_date: '2026-04-01', reason: 'Documented correction', idempotency_key: randomUUID(), ...over,
    });
    const adjust = (b: Record<string, unknown>, as = adjuster) => as.client.req('POST', url, b);
    /** Simulates a prior direct settlement (fixture journal + balance entry) of the given amount. */
    async function settle(amount: string) {
      const journal = await h.postedJournal(co, fy, '2026-03-20', owner.id, [[liability, amount, '0'], [cash, '0', amount]]);
      await h.q("INSERT INTO employee_bonus_balance_entries(company_id,entitlement_id,journal_id,idempotency_key,kind,amount,created_by) VALUES($1,$2,$3,$4,'bank',$5,$6)",
        [co, bonus, journal, randomUUID(), amount, owner.id]);
    }
    const state = async () => (await adjuster.client.req('GET', '/employee-bonuses')).json.bonuses.find((b: { id: string }) => b.id === bonus);
    const entryCount = () => h.count('SELECT count(*) n FROM employee_bonus_balance_entries WHERE company_id=$1 AND entitlement_id=$2 AND kind IN (\'increase\',\'decrease\')', [co, bonus]);
    return { owner, creator, approver, recognizer, adjuster, outsider, co, other, fy, bonus, expense, liability, cash, recognition, url, body, adjust, settle, state, entryCount };
  }

  it('isolates companies: another company cannot adjust or see the bonus', async () => {
    const x = await fixture('adj-iso');
    const res = await x.adjust(x.body(), x.outsider);
    expect(res.status).toBe(404);
    expect(await x.entryCount()).toBe(0);
    expect((await x.outsider.client.req('GET', '/employee-bonuses')).json.bonuses).toEqual([]);
  });

  it('enforces separation of duties for creator, approver and recognizer, and requires every capability', async () => {
    const x = await fixture('adj-sod');
    for (const actor of [x.creator, x.approver]) {
      const res = await x.adjust(x.body(), actor);
      expect(res.status, JSON.stringify(res.json)).toBe(403);
      expect(res.json.code).toBe('BONUS_ADJUSTMENT_SEPARATION_REQUIRED');
    }
    const lacking = await h.user('adj-sod-lacking');
    await h.member(x.co, lacking.id, ADJUST_CAPS.filter(c => c !== 'employee_cost.correct'));
    await lacking.client.login();
    expect((await x.adjust(x.body(), lacking)).status).toBe(403);
    expect(await x.entryCount()).toBe(0);
    expect((await x.adjust(x.body())).status).toBe(201);
  });

  it('rejects invalid payloads and dates without writing anything', async () => {
    const x = await fixture('adj-invalid');
    for (const bad of [{ amount: '0' }, { amount: '-5' }, { amount: '1.234' }, { amount: 5 }, { kind: 'cancel' }, { reason: '   ' },
      { reason: 'x'.repeat(1001) }, { idempotency_key: 'nope' }, { accounting_date: '2026-13-01' }]) {
      const res = await x.adjust(x.body(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe('BONUS_ADJUSTMENT_INVALID');
    }
    expect((await x.adjust(x.body({ accounting_date: '2026-03-14' }))).status).toBe(404); // before recognition
    expect((await x.adjust(x.body({ accounting_date: '2999-01-01' }))).json.code).toBe('BONUS_PERIOD_INELIGIBLE');
    expect(await x.entryCount()).toBe(0);
    expect(await h.count("SELECT count(*) n FROM journal_entries WHERE company_id=$1 AND source_type='employee_bonus_adjustment'", [x.co])).toBe(0);
  });

  it('limits decreases to the outstanding balance across partial and full prior settlements', async () => {
    const x = await fixture('adj-limits');
    expect(await x.state()).toMatchObject({ amount: '1000.00', settled: '0.00', outstanding: '1000.00' });
    expect((await x.adjust(x.body({ kind: 'decrease', amount: '1000.01' }))).status).toBe(409);
    await x.settle('400');
    expect(await x.state()).toMatchObject({ settled: '400.00', outstanding: '600.00' });
    expect((await x.adjust(x.body({ kind: 'decrease', amount: '600.01' }))).status).toBe(409);
    expect((await x.adjust(x.body({ kind: 'decrease', amount: '250.50' }))).status).toBe(201);
    expect(await x.state()).toMatchObject({ amount: '1000.00', settled: '400.00', outstanding: '349.50' });
    expect((await x.adjust(x.body({ kind: 'decrease', amount: '349.50' }))).status).toBe(201);
    // Outstanding zero does not cancel the recognition: it still exists and is posted.
    expect(await x.state()).toMatchObject({ amount: '1000.00', outstanding: '0.00', accounting_date: '2026-03-15' });
    expect((await x.adjust(x.body({ kind: 'decrease', amount: '0.01' }))).status).toBe(409);
    expect((await h.q<{ status: string }>('SELECT status FROM journal_entries WHERE id=$1', [x.recognition.json.journal_id]))[0]!.status).toBe('posted');
    // A fully settled bonus can still be increased, which reopens an outstanding balance.
    expect((await x.adjust(x.body({ kind: 'increase', amount: '75' }))).status).toBe(201);
    expect(await x.state()).toMatchObject({ outstanding: '75.00' });
    await x.settle('75');
    expect(await x.state()).toMatchObject({ settled: '475.00', outstanding: '0.00' });
    expect((await x.adjust(x.body({ kind: 'decrease', amount: '1' }))).status).toBe(409);
  });

  it('is idempotent for duplicates and serializes concurrent requests', async () => {
    const x = await fixture('adj-concurrent');
    const same = x.body({ kind: 'decrease', amount: '100' });
    const dup = await Promise.all([x.adjust(same), x.adjust(same)]);
    expect(dup.map(r => r.status).sort(), JSON.stringify(dup.map(r => r.json))).toEqual([200, 201]);
    expect(dup[0]!.json.journal_id).toBe(dup[1]!.json.journal_id);
    expect(await x.entryCount()).toBe(1);
    const changed = await x.adjust({ ...same, amount: '101' });
    expect(changed.status).toBe(409);
    expect(changed.json.code).toBe('BONUS_ADJUSTMENT_CONFLICT');
    expect(await x.entryCount()).toBe(1);
    // Two different requests that would together overdraw the remaining 900: exactly one wins.
    const race = await Promise.all([
      x.adjust(x.body({ kind: 'decrease', amount: '600' })), x.adjust(x.body({ kind: 'decrease', amount: '600' })),
    ]);
    expect(race.map(r => r.status).sort(), JSON.stringify(race.map(r => r.json))).toEqual([201, 409]);
    expect(await x.state()).toMatchObject({ outstanding: '300.00' });
  });

  it('keeps journals, balances and audit records consistent', async () => {
    const x = await fixture('adj-consistency');
    await x.settle('200');
    const inc = await x.adjust(x.body({ kind: 'increase', amount: '40', reason: 'Late award' }));
    const dec = await x.adjust(x.body({ kind: 'decrease', amount: '15.25', reason: 'Overstated' }));
    expect([inc.status, dec.status]).toEqual([201, 201]);
    expect(await h.q('SELECT account_id,debit::text,credit::text FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence', [inc.json.journal_id]))
      .toEqual([{ account_id: x.expense, debit: '40.00', credit: '0.00' }, { account_id: x.liability, debit: '0.00', credit: '40.00' }]);
    expect(await h.q('SELECT account_id,debit::text,credit::text FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence', [dec.json.journal_id]))
      .toEqual([{ account_id: x.liability, debit: '15.25', credit: '0.00' }, { account_id: x.expense, debit: '0.00', credit: '15.25' }]);
    const journals = await h.q<{ status: string; balanced: boolean; source_type: string }>(`
      SELECT j.status,j.source_type,(SELECT sum(debit)=sum(credit) FROM journal_lines l WHERE l.journal_entry_id=j.id) balanced
      FROM journal_entries j WHERE j.id = ANY($1)`, [[inc.json.journal_id, dec.json.journal_id]]);
    expect(journals).toHaveLength(2);
    expect(journals.every(j => j.status === 'posted' && j.balanced && j.source_type === 'employee_bonus_adjustment')).toBe(true);
    // 1000 + 40 - 15.25 - 200 settled
    expect(await x.state()).toMatchObject({ amount: '1000.00', settled: '200.00', outstanding: '824.75' });
    const audit = await h.q<{ action: string; reason: string; after_data: { journal_id: string; kind: string; amount: string } }>(
      "SELECT action,reason,after_data FROM audit_log WHERE company_id=$1 AND entity_id=$2 AND action='employee_bonus.adjust' ORDER BY created_at", [x.co, x.bonus]);
    expect(audit.map(a => [a.reason, a.after_data.kind, a.after_data.amount, a.after_data.journal_id])).toEqual([
      ['Late award', 'increase', '40', inc.json.journal_id], ['Overstated', 'decrease', '15.25', dec.json.journal_id]]);
    // Rejected attempts leave neither a journal nor an audit record.
    const before = await h.count("SELECT count(*) n FROM audit_log WHERE company_id=$1 AND action='employee_bonus.adjust'", [x.co]);
    expect((await x.adjust(x.body({ kind: 'decrease', amount: '5000' }))).status).toBe(409);
    expect(await h.count("SELECT count(*) n FROM audit_log WHERE company_id=$1 AND action='employee_bonus.adjust'", [x.co])).toBe(before);
  });
});
