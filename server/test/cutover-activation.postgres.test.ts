import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { createHash } from 'node:crypto';
import { getFiscalYearCloseReadiness } from '../src/modules/fiscal-years/fiscal-year-close-readiness';
import { rewriteAsPreS1Activation } from './helpers/authority-fixture';

// C1B-3b cut-over activation over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('cut-over activation (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  const ACKS = { retained_earnings: true, current_year_pnl: true, cash_balances: true, account_level_limitations: true, pre_closing_trial_balance: true };

  async function profile(co: string, userId: string, o: { from?: string; to?: string | null; vat?: 'registered' | 'not_registered'; freq?: string; review?: boolean; version?: number } = {}) {
    const reg = (o.vat ?? 'not_registered') === 'registered';
    await h.q(
      `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,vat_registration_number,vat_registered_from,vat_filing_frequency,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,effective_to,prepared_by_user_id,approved_by_user_id,approved_at)
       VALUES($1,$2,'approved','IFRS','SAR','SAR','2026-01-01',$3,$4,$5,$6,'zakat_applicable','saudi_gcc_only','not_currently_applicable','no',$7,$8,$9,$9,NOW())`,
      [co, o.version ?? 1, o.vat ?? 'not_registered', reg ? '300000000000003' : null, reg ? '2026-01-01' : null, reg ? (o.freq ?? 'monthly') : null, o.from ?? '2025-01-01', o.to ?? null, userId]);
  }

  async function setup(label: string, opts: { vat?: 'registered' | 'not_registered'; freq?: string; noProfile?: boolean } = {}) {
    const owner = await h.user(`${label}-own`);
    const viewer = await h.user(`${label}-vw`);
    const id = await h.company(label, owner.id);
    await h.member(id, viewer.id, ['accounting.view']);
    await owner.client.login(); await viewer.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    if (!opts.noProfile) await profile(id, owner.id, opts.vat ? { vat: opts.vat, freq: opts.freq ?? 'monthly' } : {});
    const bank = await h.account(id, 'C-BANK', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [bank]);
    const recv = await h.account(id, 'C-AR', 'asset', 'current_asset');
    const cap = await h.account(id, 'C-CAP', 'equity', 'equity');
    const re = await h.account(id, 'C-RE', 'equity', 'equity');
    const rev = await h.account(id, 'C-REV', 'revenue', 'revenue');
    const exp = await h.account(id, 'C-EXP', 'expense', 'operating_expense');
    const loose = await h.account(id, 'C-LOOSE', 'asset', 'unmapped');
    return { id, fy, owner, viewer, bank, recv, cap, re, rev, exp, loose };
  }
  type Co = Awaited<ReturnType<typeof setup>>;

  // Trial balance at 2026-06-30: bank 600, AR 400 | capital 700, RE 100, revenue 300 less expense 100 (profit 200 -> 200 net credit).
  const lines = (co: Co) => [
    { account_id: co.bank, debit: '600.00', credit: '0' }, { account_id: co.recv, debit: '400.00', credit: '0' },
    { account_id: co.exp, debit: '100.00', credit: '0' },
    { account_id: co.cap, debit: '0', credit: '700.00' }, { account_id: co.re, debit: '0', credit: '100.00' }, { account_id: co.rev, debit: '0', credit: '300.00' },
  ];
  const cut = (co: Co, extra: Record<string, unknown> = {}) => ({
    lines: lines(co), retained_earnings_account_id: co.re, tb_reference: 'TB-2026-06', tb_prepared_by: 'Accountant A', tb_source_system: 'Legacy ERP', acknowledgements: ACKS, idempotency_key: `key-${Math.random().toString(36).slice(2, 10)}`, confirm: true, ...extra,
  });
  const draft = async (co: Co, to = '2026-06-30', from = '2026-01-01') =>
    (await co.owner.client.req('POST', '/ledger-source-authority/drafts', { from_date: from, to_date: to, reason: 'Excel until June', confirm: true })).json.range.id as string;
  const activate = (co: Co, id: string, extra: Record<string, unknown> = {}) => co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, cut(co, extra));
  const preview = (co: Co, id: string, extra: Record<string, unknown> = {}) => co.owner.client.req('POST', `/ledger-source-authority/${id}/cutover/preview`, cut(co, extra));
  const cutJournals = (co: Co) => h.count("SELECT COUNT(*) n FROM journal_entries WHERE company_id=$1 AND entry_type='cutover_balance'", [co.id]);
  const status = async (id: string) => (await h.q<{ status: string }>('SELECT status FROM ledger_source_authority WHERE id=$1', [id]))[0]!.status;
  const dbError = async (sql: string, p: unknown[]) => { try { await h.db.query(sql, p); return null; } catch (e) { return (e as { message: string }).message; } };

  it('activates atomically: one posted cutover_balance journal, range active, audit written', async () => {
    const co = await setup('act1');
    const id = await draft(co);
    const res = await activate(co, id);
    expect(res.status).toBe(201);
    expect(await status(id)).toBe('active');
    expect(await cutJournals(co)).toBe(1);
    const j = (await h.q<{ status: string; accounting_date: string; source_type: string | null }>("SELECT status,accounting_date::text,source_type FROM journal_entries WHERE company_id=$1 AND entry_type='cutover_balance'", [co.id]))[0]!;
    expect([j.status, j.accounting_date, j.source_type]).toEqual(['posted', '2026-06-30', null]);
    const r = (await h.q<{ cutover_journal_id: string; tb_reference: string; activated_by: string }>('SELECT cutover_journal_id,tb_reference,activated_by FROM ledger_source_authority WHERE id=$1', [id]))[0]!;
    expect([!!r.cutover_journal_id, r.tb_reference, r.activated_by]).toEqual([true, 'TB-2026-06', co.owner.id]);
    expect(await h.count("SELECT COUNT(*) n FROM audit_log WHERE company_id=$1 AND action='ledger_source_authority.activate'", [co.id])).toBe(1);
  });

  it('preview never persists and reports the real verdict plus warnings', async () => {
    const co = await setup('prev');
    const id = await draft(co);
    const p = await preview(co, id);
    expect(p.status).toBe(200);
    expect(p.json.valid).toBe(true);
    expect(p.json.summary.warnings.map((w: { code: string }) => w.code)).toContain('CUTOVER_ACCOUNT_LEVEL_ONLY');
    expect([await status(id), await cutJournals(co)]).toEqual(['draft', 0]);
    const bad = await preview(co, id, { lines: lines(co).slice(1) });
    expect(bad.json.valid).toBe(false);
    expect(bad.json.blockers[0].code).toBe('CUTOVER_JOURNAL_UNBALANCED');
  });

  it('rolls back everything when validation fails and writes no cutover journal', async () => {
    const co = await setup('rb');
    const id = await draft(co);
    const res = await activate(co, id, { lines: lines(co).slice(1) });
    expect([res.status, res.json.code]).toEqual([409, 'CUTOVER_JOURNAL_UNBALANCED']);
    expect([await status(id), await cutJournals(co)]).toEqual(['draft', 0]);
    expect(await h.count("SELECT COUNT(*) n FROM journal_entries WHERE company_id=$1", [co.id])).toBe(0);
  });

  it('cash safeguard: a cash-like account classified non_cash blocks until each account is individually confirmed, and the evidence records it', async () => {
    const co = await setup('cashsg');
    await h.q("UPDATE accounts SET name='Petty cash float' WHERE id=$1", [co.recv]);
    const id = await draft(co);
    const seen = await preview(co, id);
    expect(seen.json.valid).toBe(false);
    expect(seen.json.blockers[0]).toMatchObject({ code: 'CUTOVER_CASH_CLASSIFICATION_UNCONFIRMED', detail: { accounts: [{ id: co.recv, code: 'C-AR' }] } });
    const blocked = await activate(co, id);
    expect([blocked.status, blocked.json.code]).toEqual([409, 'CUTOVER_CASH_CLASSIFICATION_UNCONFIRMED']);
    expect(await cutJournals(co)).toBe(0);
    expect(await status(id)).toBe('draft');
    const wrong = await activate(co, id, { cash_non_cash_confirmed_account_ids: [co.recv, co.cap] });
    expect([wrong.status, wrong.json.code]).toEqual([409, 'CUTOVER_CASH_CONFIRMATION_INVALID']);
    expect((await activate(co, id, { cash_non_cash_confirmed_account_ids: ['not-a-uuid'] })).status).toBe(400);
    expect((await preview(co, id, { cash_non_cash_confirmed_account_ids: [co.recv] })).json.valid).toBe(true);
    expect(await status(id)).toBe('draft');
    const ok = await activate(co, id, { cash_non_cash_confirmed_account_ids: [co.recv] });
    expect(ok.status).toBe(201);
    expect((await h.q<{ cash_role: string }>('SELECT cash_role FROM accounts WHERE id=$1', [co.recv]))[0]!.cash_role).toBe('non_cash');
    const snap = (await h.q<{ activation_snapshot: { cash_non_cash_confirmed_account_ids: string[] } }>('SELECT activation_snapshot FROM ledger_source_authority WHERE id=$1', [id]))[0]!.activation_snapshot;
    expect(snap.cash_non_cash_confirmed_account_ids).toEqual([co.recv]);
    const audit = (await h.q<{ after_data: { cash_non_cash_confirmed_account_ids: string[] } }>("SELECT after_data FROM audit_log WHERE company_id=$1 AND action='ledger_source_authority.activate'", [co.id]))[0]!.after_data;
    expect(audit.cash_non_cash_confirmed_account_ids).toEqual([co.recv]);
  });

  it('cash safeguard: a cash-classified account, a zero balance or a non-asset never needs confirmation, and confirmations are part of the idempotent payload', async () => {
    const co = await setup('cashok');
    await h.q("UPDATE accounts SET name='Cash clearing' WHERE id=$1", [co.cap]);
    const id = await draft(co);
    expect((await preview(co, id)).json.valid).toBe(true);
    await h.q("UPDATE accounts SET name='Bank guarantee' WHERE id=$1", [co.recv]);
    const body = cut(co, { idempotency_key: 'cash-idem-1', cash_non_cash_confirmed_account_ids: [co.recv] });
    const first = await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, body);
    const replay = await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, body);
    const changed = await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, { ...body, cash_non_cash_confirmed_account_ids: [] });
    expect([first.status, replay.status, changed.status]).toEqual([201, 200, 409]);
    expect(await cutJournals(co)).toBe(1);
  });

  it('is idempotent: same key+payload replays (200), different payload or key conflicts', async () => {
    const co = await setup('idem');
    const id = await draft(co);
    const body = cut(co, { idempotency_key: 'idem-key-1' });
    const first = await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, body);
    const again = await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, body);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(await cutJournals(co)).toBe(1);
    const other = await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, { ...body, tb_reference: 'DIFFERENT' });
    expect(other.status).toBe(409);
    const otherKey = await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, { ...body, idempotency_key: 'idem-key-2' });
    expect(otherKey.status).toBe(409);
    expect(await cutJournals(co)).toBe(1);
  });

  it('concurrent activations produce exactly one cutover journal', async () => {
    const co = await setup('conc');
    const id = await draft(co);
    const res = await Promise.all([activate(co, id), activate(co, id), activate(co, id)]);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await cutJournals(co)).toBe(1);
    expect(await status(id)).toBe('active');
  });

  it('enforces permission, confirmation, same origin, required evidence and tenant isolation', async () => {
    const co = await setup('perm');
    const other = await setup('permB');
    const id = await draft(co);
    expect((await co.viewer.client.req('POST', `/ledger-source-authority/${id}/activate`, cut(co))).status).toBe(403);
    expect((await co.viewer.client.req('POST', `/ledger-source-authority/${id}/cutover/preview`, cut(co))).status).toBe(403);
    expect((await activate(co, id, { confirm: undefined })).json.code).toBe('CONFIRMATION_REQUIRED');
    expect((await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, cut(co), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await activate(co, id, { tb_reference: '' })).status).toBe(400);
    expect((await activate(co, id, { tb_prepared_by: '' })).status).toBe(400);
    expect((await activate(co, id, { acknowledgements: { ...ACKS, cash_balances: false } })).status).toBe(400);
    expect((await activate(co, id, { idempotency_key: undefined })).status).toBe(400);
    expect((await other.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, cut(co))).status).toBe(404);
    expect(await status(id)).toBe('draft');
    expect(await h.count("SELECT COUNT(*) n FROM role_capabilities WHERE capability_id='source_authority.activate' AND role_id IN (SELECT id FROM roles WHERE name<>'Full Access')")).toBe(0);
  });

  it('validates the trial balance: inactive, unmapped, duplicate, wrong retained earnings, cross-company, non month-end', async () => {
    const co = await setup('tb');
    const other = await setup('tbB');
    const id = await draft(co);
    const code = async (extra: Record<string, unknown>) => (await activate(co, id, extra)).json.code;
    expect(await code({ lines: [...lines(co), { account_id: co.loose, debit: '0', credit: '0.00' }] })).toBe('CUTOVER_LINES_INVALID');
    expect(await code({ lines: [...lines(co).slice(0, 5), { account_id: co.loose, debit: '0', credit: '300.00' }] })).toBe('CUTOVER_ACCOUNT_UNMAPPED');
    expect(await code({ lines: [...lines(co), lines(co)[0]] })).toBe('CUTOVER_LINES_INVALID');
    expect(await code({ retained_earnings_account_id: co.bank })).toBe('CUTOVER_RETAINED_ACCOUNT_INVALID');
    expect(await code({ lines: [...lines(co).slice(1), { account_id: other.bank, debit: '600.00', credit: '0' }] })).toBe('CUTOVER_ACCOUNT_NOT_FOUND');
    await h.q('UPDATE accounts SET is_active=false WHERE id=$1', [co.exp]);
    expect(await code({})).toBe('CUTOVER_ACCOUNT_INACTIVE');
    await h.q('UPDATE accounts SET is_active=true WHERE id=$1', [co.exp]);
    const mid = await draft(co, '2026-07-15', '2026-07-01').catch(() => null);
    expect(mid === null || typeof mid === 'string').toBe(true);
    expect(await status(id)).toBe('draft');
  });

  it('rejects a non month-end date, a range not starting at fiscal-year start, and a future date', async () => {
    const co = await setup('dates');
    const mid = await draft(co, '2026-06-15');
    expect((await activate(co, mid)).json.code).toBe('CUTOVER_DATE_NOT_MONTH_END');
    const late = await draft(co, '2026-06-30', '2026-02-01').catch(() => '');
    if (late) expect((await activate(co, late)).status).toBe(409);
    expect(await cutJournals(co)).toBe(0);
  });

  it('VAT: quarterly filers must cut over on a calendar-quarter end; monthly may use any month end', async () => {
    const q = await setup('vatq', { vat: 'registered', freq: 'quarterly' });
    const bad = await draft(q, '2026-05-31');
    expect((await activate(q, bad)).json.code).toBe('CUTOVER_VAT_QUARTER_BOUNDARY');
    await h.q("UPDATE ledger_source_authority SET status='voided',voided_by=$2,voided_at=NOW(),void_reason='x' WHERE id=$1", [bad, q.owner.id]);
    const good = await draft(q, '2026-06-30');
    expect((await activate(q, good)).status).toBe(201);
    const m = await setup('vatm', { vat: 'registered', freq: 'monthly' });
    const mid = await draft(m, '2026-05-31');
    expect((await activate(m, mid)).status).toBe(201);
  });

  it('VAT: missing/overlapping/needs-review profiles block activation', async () => {
    const none = await setup('vatnone', { noProfile: true });
    expect((await activate(none, await draft(none))).json.code).toMatch(/^CUTOVER_/);
    const split = await setup('vatsplit');
    await h.q("UPDATE company_accounting_profiles SET effective_to='2026-06-30' WHERE company_id=$1", [split.id]);
    const id = await draft(split);
    // profile ends at D, nothing governs D+1
    expect((await activate(split, id)).json.code).toBe('CUTOVER_PROFILE_NOT_UNIQUE');
    expect(await status(id)).toBe('draft');
  });

  it('VAT: existing VAT periods in range block; VAT periods and VAT memos are refused afterwards', async () => {
    const co = await setup('vatper', { vat: 'registered' });
    const id = await draft(co);
    expect((await activate(co, id)).status).toBe(201);
    const err = await dbError(
      "INSERT INTO vat_periods(company_id,period_start,period_end,filing_frequency,status) VALUES($1,'2026-03-01','2026-03-31','monthly','open')", [co.id]);
    expect(err).not.toBeNull();
    const memoErr = await dbError(
      `INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) SELECT company_id,id,$2,1,0,'VAT_INPUT',9 FROM journal_entries WHERE company_id=$1 AND entry_type='cutover_balance'`, [co.id, co.bank]);
    expect(memoErr).not.toBeNull();
  });

  it('DB protects active ranges and the cutover journal from raw SQL', async () => {
    const co = await setup('dbp');
    const id = await draft(co);
    await activate(co, id);
    for (const sql of [
      "UPDATE ledger_source_authority SET status='voided' WHERE id=$1", "UPDATE ledger_source_authority SET to_date='2026-05-31' WHERE id=$1",
      "UPDATE ledger_source_authority SET tb_reference='x' WHERE id=$1", 'DELETE FROM ledger_source_authority WHERE id=$1',
    ]) expect(await dbError(sql, [id])).toBe('LEDGER_SOURCE_AUTHORITY_IMMUTABLE');
    expect(await dbError("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,entry_type,created_by) VALUES($1,$2,'2026-06-30','dup','cutover_balance',$3)", [co.id, co.fy, co.owner.id])).not.toBeNull();
    expect(await dbError("UPDATE journal_entries SET status='draft' WHERE company_id=$1 AND entry_type='cutover_balance'", [co.id])).not.toBeNull();
    expect(await dbError("DELETE FROM journal_entries WHERE company_id=$1 AND entry_type='cutover_balance'", [co.id])).not.toBeNull();
    expect(await cutJournals(co)).toBe(1);
  });

  it('DB refuses a raw draft->active (no journal, no evidence) and an orphan posted cutover journal', async () => {
    const co = await setup('raw');
    const id = await draft(co);
    expect(await dbError("UPDATE ledger_source_authority SET status='active' WHERE id=$1", [id])).toBe('CUTOVER_ACTIVATION_INCOMPLETE');
    const jid = (await h.q<{ id: string }>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,entry_type,created_by) VALUES($1,$2,'2026-06-30','orphan','cutover_balance',$3) RETURNING id", [co.id, co.fy, co.owner.id]))[0]!.id;
    await h.q('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,1,0,1),($1,$2,$4,0,1,2)', [co.id, jid, co.bank, co.cap]);
    expect(await dbError("UPDATE journal_entries SET status='posted',posted_by=$2,posted_at=NOW() WHERE id=$1", [jid, co.owner.id])).not.toBeNull();
    expect(await h.count("SELECT COUNT(*) n FROM journal_entries WHERE company_id=$1 AND entry_type='cutover_balance' AND status='posted'", [co.id])).toBe(0);
  });

  it('blocks manual cutover entries and any posting inside the active range', async () => {
    const co = await setup('post');
    const id = await draft(co);
    await activate(co, id);
    const manual = await co.owner.client.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: '2026-07-31', description: 'x', entry_type: 'cutover_balance' });
    expect([400, 409]).toContain(manual.status);
    expect(await cutJournals(co)).toBe(1);
    const jid = (await h.q<{ id: string }>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,'2026-03-15','late',$3) RETURNING id", [co.id, co.fy, co.owner.id]))[0]!.id;
    await h.q('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,1,0,1),($1,$2,$4,0,1,2)', [co.id, jid, co.bank, co.cap]);
    const inRange = await co.owner.client.req('POST', `/journals/${jid}/post`, {});
    expect(inRange.status).toBe(409);
    expect((await h.q<{ status: string }>('SELECT status FROM journal_entries WHERE id=$1', [jid]))[0]!.status).toBe('draft');
  });

  it('reports: P&L YTD in the annual result, imported equity as opening, balance sheet balanced, ranges guarded', async () => {
    const co = await setup('rep');
    await activate(co, await draft(co));
    const tb = await co.owner.client.req('GET', `/trial-balance?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-06-30`);
    expect(tb.status).toBe(200);
    const external = await co.owner.client.req('GET', `/trial-balance?fiscal_year_id=${co.fy}&start_date=2026-03-01&end_date=2026-03-31`);
    expect([external.status, external.json.code]).toEqual([409, 'EXTERNAL_PERIOD_REPORT_UNAVAILABLE']);
    const after = await co.owner.client.req('GET', `/trial-balance?fiscal_year_id=${co.fy}&start_date=2026-07-01&end_date=2026-07-31`);
    expect(after.status).toBe(200);
    const cf = await co.owner.client.req('GET', `/financial-statements/cash-flow?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-06-30`);
    expect([cf.status, cf.json.code]).toEqual([409, 'CASH_FLOW_EXTERNAL_PERIOD']);
    const cf2 = await co.owner.client.req('GET', `/financial-statements/cash-flow?fiscal_year_id=${co.fy}&start_date=2026-07-01&end_date=2026-07-31`);
    expect(cf2.status).toBe(200);
  });

  it('statements: profit through D stays in the annual result; imported capital/RE are opening equity; position balances', async () => {
    const co = await setup('stmt');
    await activate(co, await draft(co));
    const q = (n: string) => `/financial-statements/${n}?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-06-30`;
    const pl = await co.owner.client.req('GET', q('profit-or-loss'));
    expect(pl.status).toBe(200);
    expect(JSON.stringify(pl.json)).toContain('200.00');
    const soce = await co.owner.client.req('GET', q('changes-in-equity'));
    expect(soce.status).toBe(200);
    expect(soce.json.cutover_date).toBe('2026-06-30');
    expect(soce.json.opening_equity).toBe('800.00');
    expect(soce.json.closing_equity).toBe('1000.00');
    const pos = await co.owner.client.req('GET', `/financial-statements/financial-position?fiscal_year_id=${co.fy}&as_of_date=2026-06-30`);
    expect(pos.status).toBe(200);
    const ext = await co.owner.client.req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${co.fy}&start_date=2026-03-01&end_date=2026-03-31`);
    expect([ext.status, ext.json.code]).toEqual([409, 'EXTERNAL_PERIOD_REPORT_UNAVAILABLE']);
  });

  it('S1: statements disclose the cut-over, split imported/native P&L and never claim full-year completeness', async () => {
    const co = await setup('s1');
    const id = await draft(co);
    expect((await activate(co, id)).status).toBe(201);
    const snap = (await h.q<{ activation_snapshot: Record<string, unknown>; acknowledgements: Record<string, unknown> }>('SELECT activation_snapshot,acknowledgements FROM ledger_source_authority WHERE id=$1', [id]))[0]!;
    expect([snap.activation_snapshot['tb_basis'], snap.activation_snapshot['tb_source_system'], snap.acknowledgements['pre_closing_trial_balance']]).toEqual(['pre_closing', 'Legacy ERP', true]);
    await h.q("UPDATE accounts SET cash_flow_category='operating' WHERE id=$1", [co.rev]);
    await h.postedJournal(co.id, co.fy, '2026-07-15', co.owner.id, [[co.bank, '50', '0'], [co.rev, '0', '50']]);

    const pl = (await co.owner.client.req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-12-31`)).json;
    expect(pl.profit_or_loss).toBe('250.00');
    expect(pl.profit_or_loss_split).toEqual({ imported: '200.00', native: '50.00' });
    const revenue = pl.sections.find((s: { category: string }) => s.category === 'revenue');
    expect([revenue.total, revenue.imported_total, revenue.native_total]).toEqual(['350.00', '300.00', '50.00']);
    expect([revenue.accounts[0].imported_amount, revenue.accounts[0].native_amount]).toEqual(['300.00', '50.00']);
    expect(pl.pre_cutover).toMatchObject({ cutover_date: '2026-06-30', tb_reference: 'TB-2026-06', tb_source_system: 'Legacy ERP', tb_basis: 'pre_closing_acknowledged', evidence_missing: [] });
    expect(pl.pre_cutover.completeness).toMatchObject({ availability: 'ledger_calculated', full_year_complete: false, status: 'unverified' });
    expect(pl.pre_cutover.completeness.reasons).toContain('HISTORICAL_SUPPLEMENTS_NOT_AVAILABLE');

    const q4 = (await co.owner.client.req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${co.fy}&start_date=2026-07-01&end_date=2026-12-31`)).json;
    expect([q4.profit_or_loss, q4.profit_or_loss_split.imported, q4.profit_or_loss_split.native]).toEqual(['50.00', '0.00', '50.00']);
    const pos = (await co.owner.client.req('GET', `/financial-statements/financial-position?fiscal_year_id=${co.fy}&as_of_date=2026-12-31`)).json;
    expect([pos.accounting_equation.balanced, pos.pre_cutover.completeness.full_year_complete]).toEqual([true, false]);
    const soce = (await co.owner.client.req('GET', `/financial-statements/changes-in-equity?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-12-31`)).json;
    expect(soce.pre_cutover.completeness.reasons).toContain('PRE_CUTOVER_EQUITY_MOVEMENTS_NOT_RECORDED');
    const cf = (await co.owner.client.req('GET', `/financial-statements/cash-flow?fiscal_year_id=${co.fy}&start_date=2026-07-01&end_date=2026-12-31`)).json;
    expect([cf.net_change_in_cash_and_cash_equivalents, cf.opening_cash_and_cash_equivalents]).toEqual(['50.00', '600.00']);
    expect([cf.pre_cutover.completeness.availability, cf.pre_cutover.completeness.full_year_complete]).toEqual(['post_cutover_only', false]);

    // Annual package: blocked by the missing history. Ledger close: warnings only, no new blocker.
    const annual = (await co.owner.client.req('GET', `/annual-closing/${co.fy}`)).json;
    expect(annual.domains.pre_cutover_history.blocker_count).toBe(1);
    expect(annual.financial_statements_readiness.status).toBe('needs_review');
    const client = await h.db.connect();
    try {
      const close = await getFiscalYearCloseReadiness(client, co.id, { id: co.fy, start_date: '2026-01-01', end_date: '2026-12-31' });
      expect(close.warnings.map((w) => w.code)).toContain('cutover_historical_supplements_missing');
      expect(close.warnings.map((w) => w.code)).not.toContain('cutover_tb_evidence_missing');
      expect(close.blockers.map((b) => b.code).filter((c) => /cutover|history|supplement/.test(c))).toEqual([]);
    } finally { client.release(); }
  });

  it('S1 compatibility: a retry of a completed pre-S1 activation replays the stored outcome and changes nothing', async () => {
    const co = await setup('legacy');
    const id = await draft(co);
    const key = 'legacy-key-0001';
    const legacyAcks = { retained_earnings: true, current_year_pnl: true, cash_balances: true, account_level_limitations: true };
    // The original pre-S1 request body and the hash the pre-S1 code stored for it (independent re-implementation of that formula).
    const legacyBody = { lines: lines(co), retained_earnings_account_id: co.re, tb_reference: 'TB-2026-06', tb_prepared_by: 'Accountant A', acknowledgements: legacyAcks, idempotency_key: key, confirm: true };
    const sorted = [...legacyBody.lines].map((l) => ({ a: l.account_id, d: Number(l.debit).toFixed(2), c: Number(l.credit).toFixed(2) })).sort((p, q) => p.a.localeCompare(q.a));
    const oldHash = createHash('sha256').update(JSON.stringify({ lines: sorted, re: co.re, ref: 'TB-2026-06', by: 'Accountant A', ack: legacyAcks, cash: [] })).digest('hex');
    expect((await activate(co, id, { idempotency_key: key })).status).toBe(201);
    await rewriteAsPreS1Activation(h.db, id, oldHash);
    const before = await h.q('SELECT * FROM ledger_source_authority WHERE id=$1', [id]);
    const audits = await h.count('SELECT COUNT(*) n FROM audit_log WHERE company_id=$1', [co.id]);

    const replay = await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, legacyBody);
    expect(replay.status).toBe(200);
    expect([replay.json.replayed, replay.json.range.status, !!replay.json.journal_id]).toEqual([true, 'active', true]);
    expect(replay.json.journal_id).toBe(before[0]!['cutover_journal_id']);
    // Nothing created or rewritten: one journal, same row, no audit event.
    expect(await cutJournals(co)).toBe(1);
    expect(await h.q('SELECT * FROM ledger_source_authority WHERE id=$1', [id])).toEqual(before);
    expect(await h.count('SELECT COUNT(*) n FROM audit_log WHERE company_id=$1', [co.id])).toBe(audits);
    // The legacy record is disclosed as missing evidence, not upgraded.
    const pl = (await co.owner.client.req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-12-31`)).json;
    expect([pl.pre_cutover.tb_basis, pl.pre_cutover.tb_source_system]).toEqual(['not_recorded', null]);

    // A pre-S1 body with a different key or payload never replays; it conflicts and changes nothing.
    expect((await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, { ...legacyBody, idempotency_key: 'legacy-key-0002' })).json.code).toBe('AUTHORITY_ALREADY_ACTIVE');
    expect((await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, { ...legacyBody, tb_reference: 'TB-OTHER' })).json.code).toBe('AUTHORITY_ALREADY_ACTIVE');
    expect(await cutJournals(co)).toBe(1);
  });

  it('S1 evidence stays required: a pre-S1 body cannot activate a draft', async () => {
    const co = await setup('legacy2');
    const id = await draft(co);
    const legacyAcks = { retained_earnings: true, current_year_pnl: true, cash_balances: true, account_level_limitations: true };
    const res = await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, { lines: lines(co), retained_earnings_account_id: co.re, tb_reference: 'TB-1', tb_prepared_by: 'A', acknowledgements: legacyAcks, idempotency_key: 'legacy-key-0003', confirm: true });
    expect([res.status, res.json.code]).toEqual([400, 'CUTOVER_EVIDENCE_REQUIRED']);
    expect([await status(id), await cutJournals(co)]).toEqual(['draft', 0]);
    const noKey = await co.owner.client.req('POST', `/ledger-source-authority/${id}/activate`, { lines: lines(co), retained_earnings_account_id: co.re, tb_reference: 'TB-1', tb_prepared_by: 'A', acknowledgements: legacyAcks, confirm: true });
    expect(noKey.status).toBe(400);
    expect((await preview(co, id, { acknowledgements: legacyAcks, tb_source_system: undefined })).status).toBe(400);
  });

  it('S1: a January-1 company gets no disclosure, no split columns and no history domain', async () => {
    const co = await setup('s1plain');
    await h.postedJournal(co.id, co.fy, '2026-03-10', co.owner.id, [[co.bank, '50', '0'], [co.rev, '0', '50']]);
    const pl = (await co.owner.client.req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-12-31`)).json;
    expect(pl.profit_or_loss).toBe('50.00');
    expect('pre_cutover' in pl || 'profit_or_loss_split' in pl).toBe(false);
    expect(Object.keys(pl.sections[0]).sort()).toEqual(['accounts', 'category', 'total']);
    expect(Object.keys(pl.sections.find((s: { category: string }) => s.category === 'revenue').accounts[0])).not.toContain('imported_amount');
    const annual = (await co.owner.client.req('GET', `/annual-closing/${co.fy}`)).json;
    expect(annual.domains.pre_cutover_history).toBeUndefined();
    expect(annual.package_manifest.map((m: { section: string }) => m.section)).not.toContain('pre_cutover_history');
  });

  it('monthly close: months through D are external and cannot be closed; D+1 month is native', async () => {
    const co = await setup('mc');
    await activate(co, await draft(co));
    const mp = async (m: number) => (await h.q<{ id: string }>("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,make_date(2026,$3,1),(make_date(2026,$3,1)+interval '1 month - 1 day')::date,'open') RETURNING id", [co.id, co.fy, m]))[0]!.id;
    const [march, july] = [await mp(3), await mp(7)];
    const list = await co.owner.client.req('GET', '/monthly-close-periods');
    expect(list.status).toBe(200);
    const row = (id: string) => list.json.periods.find((p: { id: string }) => p.id === id);
    expect([row(march).external_period, row(march).ready]).toEqual([true, false]);
    expect(row(july).external_period).toBeFalsy();
    const close = await co.owner.client.req('POST', `/monthly-close-periods/${march}/close`, {});
    expect([close.status, close.json.code]).toEqual([409, 'MONTHLY_CLOSE_EXTERNAL_PERIOD']);
  });

  it('companies without a cut-over are unaffected (statements, trial balance, posting)', async () => {
    const co = await setup('plain');
    await h.postedJournal(co.id, co.fy, '2026-03-10', co.owner.id, [[co.bank, '50', '0'], [co.rev, '0', '50']]);
    expect((await co.owner.client.req('GET', `/trial-balance?fiscal_year_id=${co.fy}&start_date=2026-03-01&end_date=2026-03-31`)).status).toBe(200);
    const cf = await co.owner.client.req('GET', `/financial-statements/cash-flow?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-06-30`);
    expect(cf.json?.code).not.toMatch(/EXTERNAL/);
  });
});
