import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// C1B-3b over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('cut-over trial balance, journal and activation (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  type Setup = { vatFrequency?: 'quarterly' | 'monthly'; vatStatus?: 'registered' | 'not_registered' | 'needs_review'; to?: string; firstLive?: string; noProfile?: boolean };
  async function setup(label: string, opts: Setup = {}) {
    const owner = await h.user(`${label}-own`);
    const viewer = await h.user(`${label}-vw`);
    const company = await h.company(label, owner.id);
    await h.member(company, viewer.id, ['accounting.view']);
    for (const u of [owner, viewer]) await u.client.login();
    const fy = await h.fiscalYear(company, 'FY26', '2026-01-01', '2026-12-31');
    const acc = async (code: string, type: string, category: string, extra = '') => {
      const id = await h.account(company, code, type, category);
      if (extra) await h.q(`UPDATE accounts SET ${extra} WHERE id=$1`, [id]);
      return id;
    };
    const cash = await acc('C-CASH', 'asset', 'current_asset', "cash_role='cash',name='Main Bank'");
    const capital = await acc('C-CAP', 'equity', 'equity');
    const retained = await acc('C-RE', 'equity', 'equity');
    const revenue = await acc('C-REV', 'revenue', 'revenue');
    const expense = await acc('C-EXP', 'expense', 'operating_expense');
    const receivable = await acc('C-AR', 'asset', 'current_asset', "name='Trade debtors'");
    for (let m = 1; m <= 12; m++) {
      const s = new Date(Date.UTC(2026, m - 1, 1)).toISOString().slice(0, 10), e = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10);
      await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,$3,$4,'open')", [company, fy, s, e]);
    }
    if (!opts.noProfile) {
      const status = opts.vatStatus ?? 'registered';
      const reg = status === 'registered';
      await h.q(
        `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,vat_registration_number,vat_registered_from,vat_filing_frequency,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,effective_to,prepared_by_user_id,approved_by_user_id,approved_at)
         VALUES($1,1,'approved','IFRS','SAR','SAR',$2,$3,$4,$5,$6,'zakat_applicable','saudi_gcc_only','not_currently_applicable','no','2025-01-01',NULL,$7,$7,NOW())`,
        [company, opts.firstLive ?? '2026-07-01', status, reg ? '300000000000003' : null, reg ? '2025-01-01' : null, reg ? (opts.vatFrequency ?? 'quarterly') : null, owner.id]);
    }
    const draft = await owner.client.req('POST', '/ledger-source-authority/drafts', { from_date: '2026-01-01', to_date: opts.to ?? '2026-06-30', reason: 'Books kept in Excel until June', confirm: true });
    expect(draft.status).toBe(201);
    return { company, fy, owner, viewer, cash, capital, retained, revenue, expense, receivable, rangeId: draft.json.range.id as string };
  }
  type Co = Awaited<ReturnType<typeof setup>>;

  const ACK = { retained_earnings_before_period_profit: true, pnl_from_year_start_to_cutover: true, cash_matches_statements: true, account_level_only: true };
  const payload = (co: Co, extra: Record<string, unknown> = {}) => ({
    lines: [
      { account_id: co.cash, debit: '1000.00', credit: '0' },
      { account_id: co.expense, debit: '200.00', credit: '0' },
      { account_id: co.revenue, debit: '0', credit: '500.00' },
      { account_id: co.capital, debit: '0', credit: '500.00' },
      { account_id: co.retained, debit: '0', credit: '200.00' },
    ],
    retained_earnings_account_id: co.retained, prepared_by: 'Dana Accountant, CPA', trial_balance_reference: 'TB-2026-06-30 v3', acknowledgements: ACK, confirm: true, ...extra,
  });
  const activate = (co: Co, extra: Record<string, unknown> = {}, who: 'owner' | 'viewer' = 'owner') => (who === 'owner' ? co.owner : co.viewer).client.req('POST', `/ledger-source-authority/${co.rangeId}/activate`, payload(co, extra));
  const preview = (co: Co, extra: Record<string, unknown> = {}) => co.owner.client.req('POST', `/ledger-source-authority/${co.rangeId}/cutover-preview`, payload(co, extra));
  const rangeStatus = async (co: Co) => (await h.q<{ status: string }>('SELECT status FROM ledger_source_authority WHERE id=$1', [co.rangeId]))[0]!.status;
  const cutoverJournals = async (co: Co) => h.q<{ id: string; status: string; accounting_date: string }>("SELECT id,status,accounting_date::text FROM journal_entries WHERE company_id=$1 AND entry_type='cutover_balance'", [co.company]);
  const blockerCodes = (res: { json: any }) => ((res.json.blockers ?? res.json.preview?.blockers ?? []) as Array<{ code: string }>).map((b) => b.code);

  it('requires the independent critical capability; a role without it cannot preview or activate', async () => {
    const co = await setup('coCap');
    expect((await activate(co, {}, 'viewer')).status).toBe(403);
    expect((await co.viewer.client.req('POST', `/ledger-source-authority/${co.rangeId}/cutover-preview`, payload(co))).status).toBe(403);
    expect(await rangeStatus(co)).toBe('draft');
    expect(await h.count("SELECT COUNT(*) n FROM role_capabilities WHERE capability_id='source_authority.activate' AND role_id IN (SELECT id FROM roles WHERE name IN ('Viewer','Accountant','Finance Manager'))")).toBe(0);
    expect(await h.count("SELECT COUNT(*) n FROM capabilities WHERE id='source_authority.activate'")).toBe(1);
  });

  it('previews a valid trial balance without writing anything', async () => {
    const co = await setup('coPrev');
    const res = await preview(co);
    expect(res.status).toBe(200);
    expect(res.json.preview).toMatchObject({ ready: true, native_posting_starts: '2026-07-01', totals: { debit: '1200.00', credit: '1200.00', balanced: true, line_count: 5 }, profit_or_loss_through_cutover: { net_result: '300.00' } });
    expect(res.json.preview.warnings.map((w: { code: string }) => w.code)).toContain('CUTOVER_ACCOUNT_LEVEL_ONLY');
    expect(await rangeStatus(co)).toBe('draft');
    expect(await cutoverJournals(co)).toHaveLength(0);
  });

  it('activates atomically: one posted balanced cut-over journal, an active range, activation evidence and an audit record', async () => {
    const co = await setup('coAct');
    const res = await activate(co);
    expect(res.status).toBe(201);
    expect(await rangeStatus(co)).toBe('active');
    const journals = await cutoverJournals(co);
    expect(journals).toEqual([{ id: res.json.activation.journal_id, status: 'posted', accounting_date: '2026-06-30' }]);
    const totals = (await h.q<{ d: string; c: string }>('SELECT SUM(debit)::text d,SUM(credit)::text c FROM journal_lines WHERE journal_entry_id=$1', [journals[0]!.id]))[0]!;
    expect(totals).toEqual({ d: '1200.00', c: '1200.00' });
    const row = (await h.q<any>('SELECT cutover_journal_id,activated_by,activated_at,activation_ack FROM ledger_source_authority WHERE id=$1', [co.rangeId]))[0];
    expect(row.cutover_journal_id).toBe(journals[0]!.id);
    expect(row.activated_by).toBe(co.owner.id);
    expect(row.activation_ack).toMatchObject({ prepared_by: 'Dana Accountant, CPA', trial_balance_reference: 'TB-2026-06-30 v3', acknowledgements: ACK });
    const audit = await h.q<{ action: string }>("SELECT action FROM audit_log WHERE company_id=$1 AND action='ledger_source_authority.activate'", [co.company]);
    expect(audit).toHaveLength(1);
    expect((await activate(co)).status).toBe(409);
    expect(await cutoverJournals(co)).toHaveLength(1);
  });

  it('refuses incomplete evidence: missing confirmation, preparer, trial-balance reference or any acknowledgement', async () => {
    const co = await setup('coEvid');
    expect((await activate(co, { confirm: undefined })).json.code).toBe('CONFIRMATION_REQUIRED');
    expect((await activate(co, { prepared_by: '   ' })).json.code).toBe('CUTOVER_PREPARER_REQUIRED');
    expect((await activate(co, { trial_balance_reference: '' })).json.code).toBe('CUTOVER_TB_REFERENCE_REQUIRED');
    for (const key of Object.keys(ACK)) {
      const res = await activate(co, { acknowledgements: { ...ACK, [key]: false } });
      expect([res.status, res.json.code]).toEqual([400, 'CUTOVER_ACK_REQUIRED']);
    }
    expect((await activate(co, { unexpected: 1 })).status).toBe(400);
    expect(await rangeStatus(co)).toBe('draft');
    expect(await cutoverJournals(co)).toHaveLength(0);
  });

  it('rejects an unbalanced, duplicated or ill-formed trial balance and leaves no partial journal', async () => {
    const co = await setup('coTb');
    const lines = payload(co).lines;
    const unbalanced = await activate(co, { lines: [...lines.slice(0, 4), { account_id: co.retained, debit: '0', credit: '199.99' }] });
    expect([unbalanced.status, blockerCodes(unbalanced)]).toEqual([409, ['CUTOVER_UNBALANCED']]);
    expect(blockerCodes(await activate(co, { lines: [...lines, { account_id: co.cash, debit: '0', credit: '1000' }] }))).toContain('CUTOVER_LINES_DUPLICATE_ACCOUNT');
    expect(blockerCodes(await activate(co, { lines: lines.map((l) => (l.account_id === co.retained ? { ...l, memo: 'vat_output' } : l)) }))).toContain('CUTOVER_MEMO_RESERVED');
    expect(blockerCodes(await activate(co, { retained_earnings_account_id: co.revenue }))).toContain('CUTOVER_RETAINED_EARNINGS_INVALID');
    expect((await activate(co, { lines: [{ account_id: co.cash, debit: '1.005', credit: '0' }, ...lines.slice(1)] })).json.code).toBe('CUTOVER_LINES_INVALID');
    expect((await activate(co, { lines: [{ account_id: co.cash, debit: '5', credit: '5' }, ...lines.slice(1)] })).json.code).toBe('CUTOVER_LINES_INVALID');
    const other = await setup('coTbOther');
    expect(blockerCodes(await activate(co, { lines: [{ account_id: other.cash, debit: '1000', credit: '0' }, ...lines.slice(1)] }))).toContain('CUTOVER_ACCOUNT_INVALID');
    await h.q('UPDATE accounts SET is_active=false WHERE id=$1', [co.expense]);
    expect(blockerCodes(await activate(co))).toContain('CUTOVER_ACCOUNT_INVALID');
    expect(await rangeStatus(co)).toBe('draft');
    expect(await cutoverJournals(co)).toHaveLength(0);
  });

  it('blocks a balance-sheet account that looks like cash but is not classified as cash, unless the accountant confirms it', async () => {
    const co = await setup('coCash');
    await h.q("UPDATE accounts SET name='Petty cash fund',cash_role='non_cash' WHERE id=$1", [co.receivable]);
    const lines = [...payload(co).lines.slice(0, 4), { account_id: co.receivable, debit: '0', credit: '0.00' }];
    const withBalance = [{ account_id: co.cash, debit: '900', credit: '0' }, { account_id: co.receivable, debit: '100', credit: '0' }, ...payload(co).lines.slice(1)];
    void lines;
    const blocked = await activate(co, { lines: withBalance });
    expect(blockerCodes(blocked)).toContain('CUTOVER_CASH_CLASSIFICATION_SUSPECT');
    const confirmed = await activate(co, { lines: withBalance, cash_non_cash_confirmed_account_ids: [co.receivable] });
    expect(confirmed.status).toBe(201);
  });

  it('enforces the VAT cut-over boundary and the approved accounting profile', async () => {
    const offQuarter = await setup('coVatQ', { to: '2026-05-31', firstLive: '2026-06-01' });
    expect(blockerCodes(await activate(offQuarter))).toContain('CUTOVER_VAT_QUARTER_BOUNDARY');
    const monthly = await setup('coVatM', { to: '2026-05-31', firstLive: '2026-06-01', vatFrequency: 'monthly' });
    expect((await activate(monthly)).status).toBe(201);
    const review = await setup('coVatR', { vatStatus: 'needs_review' });
    expect(blockerCodes(await activate(review))).toContain('CUTOVER_VAT_PROFILE_NEEDS_REVIEW');
    const none = await setup('coVatN', { noProfile: true });
    expect(blockerCodes(await activate(none))).toContain('CUTOVER_VAT_PROFILE_AMBIGUOUS');
    const unregistered = await setup('coVatU', { vatStatus: 'not_registered', to: '2026-05-31', firstLive: '2026-06-01' });
    expect((await activate(unregistered)).status).toBe(201);
    const withPeriod = await setup('coVatP');
    await h.q("INSERT INTO vat_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-01-01','2026-03-31','open')", [withPeriod.company, withPeriod.fy]);
    expect(blockerCodes(await activate(withPeriod))).toContain('CUTOVER_VAT_PERIOD_CONFLICT');
    const firstLive = await setup('coVatF', { firstLive: '2026-09-01' });
    const result = await activate(firstLive);
    expect(result.status).toBe(201);
    expect(result.json.activation.warnings.map((w: { code: string }) => w.code)).toContain('CUTOVER_FIRST_LIVE_DATE_DIFFERS');
  });

  it('rejects a cut-over date that is not a month end', async () => {
    const co = await setup('coMonth', { to: '2026-06-29' });
    expect(blockerCodes(await activate(co))).toContain('CUTOVER_DATE_NOT_MONTH_END');
  });

  it('blocks activation when an approved annual closing package exists, or a closed month, journal or opening path is already in the range', async () => {
    const pkg = await setup('coPkg');
    await h.q("INSERT INTO annual_closing_packages(company_id,fiscal_year_id,status,reviewed_by_user_id,reviewed_at,approved_by_user_id,approved_at) VALUES($1,$2,'approved',$3,NOW(),$3,NOW())", [pkg.company, pkg.fy, pkg.owner.id]);
    expect(blockerCodes(await activate(pkg))).toContain('CUTOVER_ANNUAL_PACKAGE_APPROVED');
    expect(await rangeStatus(pkg)).toBe('draft');

    const closed = await setup('coClosed');
    await h.q("UPDATE monthly_close_periods SET status='closed' WHERE company_id=$1 AND period_start='2026-02-01'", [closed.company]);
    expect(blockerCodes(await activate(closed))).toContain('CUTOVER_PERIOD_CLOSED');

    const journal = await setup('coJrn');
    await h.postedJournal(journal.company, journal.fy, '2026-03-10', journal.owner.id, [[journal.cash, '10', '0'], [journal.revenue, '0', '10']]);
    expect(blockerCodes(await activate(journal))).toContain('CUTOVER_PERIOD_HAS_JOURNALS');
  });

  it('refuses manual cut-over journals and a raw SQL activation that skips the workflow', async () => {
    const co = await setup('coRaw');
    const manual = await co.owner.client.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: '2026-06-30', description: 'manual', entry_type: 'cutover_balance' });
    expect(manual.status).toBe(400);
    expect(await cutoverJournals(co)).toHaveLength(0);
    const fails = async (sql: string, params: unknown[] = []) => { try { await h.db.query(sql, params); return null; } catch (e) { return (e as { message: string }).message; } };
    expect(await fails("UPDATE ledger_source_authority SET status='active' WHERE id=$1", [co.rangeId])).toBe('AUTHORITY_ACTIVATION_INCOMPLETE');
    const second = await setup('coRaw2');
    await activate(second);
    expect(await fails("UPDATE ledger_source_authority SET status='voided' WHERE id=$1", [second.rangeId])).toBeTruthy();
    expect(await rangeStatus(second)).toBe('active');
    expect(await fails("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,entry_type,created_by) VALUES($1,$2,'2026-06-30','dup','cutover_balance',$3)", [second.company, second.fy, second.owner.id])).toBeTruthy();
  });

  it('serialises concurrent activations: exactly one cut-over journal and one active range', async () => {
    const co = await setup('coRace');
    const results = await Promise.all([activate(co), activate(co), activate(co)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await cutoverJournals(co)).toHaveLength(1);
    expect(await rangeStatus(co)).toBe('active');
  });

  it('keeps tenant isolation: another company cannot preview or activate this range', async () => {
    const a = await setup('coTenA');
    const b = await setup('coTenB');
    const res = await b.owner.client.req('POST', `/ledger-source-authority/${a.rangeId}/activate`, payload(b));
    expect(res.status).toBe(404);
    expect(await rangeStatus(a)).toBe('draft');
  });

  describe('after activation', () => {
    it('closes the native door: no manual posting or VAT period inside the range; posting after the cut-over date is allowed', async () => {
      const co = await setup('coPost');
      await activate(co);
      const draft = await co.owner.client.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: '2026-03-15', description: 'late', entry_type: 'standard' });
      expect(draft.status).toBe(201);
      await h.q('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,5,0,1),($1,$2,$4,0,5,2)', [co.company, draft.json.id ?? draft.json.journal?.id, co.cash, co.revenue]);
      const posted = await co.owner.client.req('POST', `/journals/${draft.json.id ?? draft.json.journal?.id}/post`, {});
      expect(posted.status).toBe(409);
      const vat = await co.owner.client.req('POST', '/vat-periods', { fiscal_year_id: co.fy, period_start: '2026-04-01', period_end: '2026-06-30' });
      expect([vat.status, vat.json.code]).toEqual([409, 'VAT_PERIOD_EXTERNAL']);
      const after = await co.owner.client.req('POST', '/vat-periods', { fiscal_year_id: co.fy, period_start: '2026-07-01', period_end: '2026-09-30' });
      expect(after.status).toBe(201);
    });

    it('treats months up to the cut-over date as externally maintained in monthly close', async () => {
      const co = await setup('coMc');
      await activate(co);
      const list = await co.owner.client.req('GET', '/monthly-close-periods');
      const byStart = new Map((list.json.periods as Array<{ period_start: string; ready: boolean; external?: boolean; blockers: Record<string, number> }>).map((p) => [String(p.period_start).slice(0, 10), p]));
      expect(byStart.get('2026-03-01')).toMatchObject({ ready: true, external: true });
      expect(byStart.get('2026-06-01')).toMatchObject({ ready: true, external: true });
      expect(byStart.get('2026-07-01')!.external).toBe(false);
      expect(byStart.get('2026-07-01')!.blockers['opening_balances']).toBe(0);
      const jan = (await h.q<{ id: string }>("SELECT id FROM monthly_close_periods WHERE company_id=$1 AND period_start='2026-01-01'", [co.company]))[0]!.id;
      const close = await co.owner.client.req('POST', `/monthly-close-periods/${jan}/close`);
      expect([close.status, close.json.code]).toEqual([409, 'MONTHLY_CLOSE_EXTERNAL_PERIOD']);
    });

    it('does not count external months as missing or open in annual close readiness and does not require the opening-balance review', async () => {
      const co = await setup('coAnn');
      const before = await co.owner.client.req('GET', `/annual-closing/${co.fy}`);
      expect(before.json.domains.monthly_close.summary.expected_periods).toBe(12);
      await activate(co);
      const after = await co.owner.client.req('GET', `/annual-closing/${co.fy}`);
      expect(after.status).toBe(200);
      const mc = after.json.domains.monthly_close.summary;
      expect([mc.expected_periods, mc.external_through]).toEqual([6, '2026-06-30']);
      expect(after.json.domains.opening_balances.blocker_count).toBe(0);
    });

    it('rejects misleading report periods and fictitious cash flows', async () => {
      const co = await setup('coRep');
      await activate(co);
      const q = (path: string, params: Record<string, string>) => co.owner.client.req('GET', `${path}?${new URLSearchParams({ fiscal_year_id: co.fy, ...params })}`);
      const asOfBefore = await q('/financial-statements/financial-position', { as_of_date: '2026-03-31' });
      expect([asOfBefore.status, asOfBefore.json.code]).toEqual([409, 'EXTERNAL_PERIOD_REPORT_UNAVAILABLE']);
      const position = await q('/financial-statements/financial-position', { as_of_date: '2026-06-30' });
      expect(position.status).toBe(200);
      expect(position.json.accounting_equation.balanced).toBe(true);
      expect(position.json.total_assets).toBe('1000.00');
      expect((await q('/financial-statements/profit-or-loss', { start_date: '2026-01-01', end_date: '2026-06-30' })).json.profit_or_loss).toBe('300.00');
      expect((await q('/financial-statements/profit-or-loss', { start_date: '2026-02-01', end_date: '2026-07-31' })).json.code).toBe('EXTERNAL_PERIOD_REPORT_UNAVAILABLE');
      expect((await q('/financial-statements/profit-or-loss', { start_date: '2026-01-01', end_date: '2026-03-31' })).json.code).toBe('EXTERNAL_PERIOD_REPORT_UNAVAILABLE');
      expect((await q('/financial-statements/profit-or-loss', { start_date: '2026-07-01', end_date: '2026-07-31' })).status).toBe(200);
      expect((await q('/trial-balance', { end_date: '2026-03-31' })).json.code).toBe('EXTERNAL_PERIOD_REPORT_UNAVAILABLE');
      expect((await q('/trial-balance', { end_date: '2026-06-30' })).status).toBe(200);
      const cashFlowFull = await q('/financial-statements/cash-flow', {});
      expect([cashFlowFull.status, cashFlowFull.json.code]).toEqual([409, 'CASH_FLOW_EXTERNAL_PERIOD']);
      expect((await q('/financial-statements/cash-flow', { start_date: '2026-06-30', end_date: '2026-07-31' })).json.code).toBe('CASH_FLOW_EXTERNAL_PERIOD');
      const native = await q('/financial-statements/cash-flow', { start_date: '2026-07-01', end_date: '2026-07-31' });
      expect(native.status).toBe(200);
      expect(native.json.opening_cash_and_cash_equivalents).toBe('1000.00');
      expect(native.json.net_change_in_cash_and_cash_equivalents).toBe('0.00');
    });

    it('presents imported equity as opening in the statement of changes in equity and reconciles to the balance sheet', async () => {
      const co = await setup('coEq');
      await activate(co);
      const res = await co.owner.client.req('GET', `/financial-statements/changes-in-equity?${new URLSearchParams({ fiscal_year_id: co.fy, start_date: '2026-01-01', end_date: '2026-06-30' })}`);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ opening_equity: '700.00', direct_equity_movements: '0.00', current_period_earnings: '300.00', closing_equity: '1000.00' });
      expect(res.json.reconciliation.balanced).toBe(true);
    });
  });
});
