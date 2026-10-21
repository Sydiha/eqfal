import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { getFiscalYearCloseReadiness } from '../src/modules/fiscal-years/fiscal-year-close-readiness';

// Cutover S2: pre-cut-over historical supplements over real HTTP + PostgreSQL (migration 091). Requires an isolated, disposable database (DATABASE_URL).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('cut-over historical supplements (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  const ACKS = { retained_earnings: true, current_year_pnl: true, cash_balances: true, account_level_limitations: true, pre_closing_trial_balance: true };

  // SYNTHETIC acceptance case (spec v2 J): D = 2026-06-30. Cut-over journal: bank 270,000 | capital 150,000, retained earnings 20,000, YTD profit 120,000.
  // TEST-FIXTURE BALANCING CORRECTION (not an accounting rule, not a spec change): the spec's figures alone do not balance (debit 270,000 vs
  // credit 290,000), and activation correctly refuses an unbalanced trial balance. A non-cash, non-equity asset of 20,000 (S-PPE) is added only
  // to balance the fixture; it is not a cash account (C1/C2) or an equity account (E1-E4), so every figure the spec asserts is unchanged.
  async function setup(label: string) {
    const owner = await h.user(`${label}-own`);
    const id = await h.company(label, owner.id);
    await owner.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    await h.q(
      `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,prepared_by_user_id,approved_by_user_id,approved_at)
       VALUES($1,1,'approved','IFRS','SAR','SAR','2026-01-01','not_registered','zakat_applicable','saudi_gcc_only','not_currently_applicable','no','2025-01-01',$2,$2,NOW())`, [id, owner.id]);
    const bank = await h.account(id, 'S-BANK', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [bank]);
    const cap = await h.account(id, 'S-CAP', 'equity', 'equity');
    const re = await h.account(id, 'S-RE', 'equity', 'equity');
    const rev = await h.account(id, 'S-REV', 'revenue', 'revenue');
    const adv = await h.account(id, 'S-ADV', 'liability', 'current_liability');
    const loan = await h.account(id, 'S-LOAN', 'liability', 'non_current_liability');
    const fixed = await h.account(id, 'S-PPE', 'asset', 'non_current_asset');
    await h.q("UPDATE accounts SET cash_flow_category='operating' WHERE id = ANY($1)", [[rev, adv]]);
    await h.q("UPDATE accounts SET cash_flow_category='financing' WHERE id = ANY($1)", [[cap, re, loan]]);
    const range = (await owner.client.req('POST', '/ledger-source-authority/drafts', { from_date: '2026-01-01', to_date: '2026-06-30', reason: 'Excel until June', confirm: true })).json.range.id as string;
    const act = await owner.client.req('POST', `/ledger-source-authority/${range}/activate`, {
      lines: [{ account_id: bank, debit: '270000.00', credit: '0' }, { account_id: fixed, debit: '20000.00', credit: '0' }, { account_id: cap, debit: '0', credit: '150000.00' }, { account_id: re, debit: '0', credit: '20000.00' }, { account_id: rev, debit: '0', credit: '120000.00' }],
      retained_earnings_account_id: re, tb_reference: 'TB-2026-06', tb_prepared_by: 'Accountant A', tb_source_system: 'Legacy ERP', acknowledgements: ACKS,
      idempotency_key: `key-${Math.random().toString(36).slice(2, 10)}`, confirm: true,
    });
    expect(act.status, JSON.stringify(act.json)).toBe(201);
    // Native after D: revenue 60,000 in cash; customer advance 5,000 (operating, non-P&L). Full-year operating = 235,000 + 65,000 = 300,000.
    await h.postedJournal(id, fy, '2026-07-15', owner.id, [[bank, '60000', '0'], [rev, '0', '60000']]);
    await h.postedJournal(id, fy, '2026-08-10', owner.id, [[bank, '5000', '0'], [adv, '0', '5000']]);
    return { id, fy, owner, range, bank, cap, re, rev, adv, loan };
  }
  type Co = Awaited<ReturnType<typeof setup>>;

  const cashBody = (co: Co, over: Record<string, unknown> = {}) => ({
    source_system: 'Legacy ERP', evidence_reference: 'Bank statements Jan-Jun 2026', confirm: true,
    lines: [
      { line_type: 'cash_balance', account_id: co.bank, opening_amount: '20000.00', closing_amount: '270000.00' },
      { line_type: 'cash_flow', section: 'operating', label: 'Customer receipts net of payments', amount: '235000.00' },
      { line_type: 'cash_flow', section: 'financing', label: 'Capital contribution', account_id: co.cap, amount: '15000.00' },
    ],
    ...over,
  });
  const equityBody = (co: Co, over: Record<string, unknown> = {}) => ({
    source_system: 'Legacy ERP', evidence_reference: 'FY2025 audited statements + partner resolutions', confirm: true,
    lines: [
      { line_type: 'equity_opening', account_id: co.cap, opening_amount: '135000.00' },
      { line_type: 'equity_movement', account_id: co.cap, movement_type: 'contribution', label: 'Partner contribution', amount: '15000.00' },
      { line_type: 'equity_opening', account_id: co.re, opening_amount: '20000.00' },
    ],
    ...over,
  });
  const base = (co: Co) => `/ledger-source-authority/${co.range}/supplements`;
  const createDraft = (co: Co, kind: 'cash_flow' | 'equity', body: unknown, client = co.owner.client) => client.req('POST', `${base(co)}/${kind}/drafts`, body);
  const approve = (co: Co, versionId: string, rowVersion: number, client = co.owner.client) => client.req('POST', `${base(co)}/${versionId}/approve`, { confirm: true, expected_row_version: rowVersion });
  async function approved(co: Co, kind: 'cash_flow' | 'equity', body: unknown) {
    const d = await createDraft(co, kind, body);
    expect(d.status).toBe(201);
    const a = await approve(co, d.json.version.id, d.json.version.row_version);
    expect(a.status).toBe(200);
    return a.json.version as { id: string; version_no: number; row_version: number };
  }
  const dbError = async (sql: string, p: unknown[]) => { try { await h.db.query(sql, p); return null; } catch (e) { return (e as { message: string }).message; } };
  const cf = (co: Co) => co.owner.client.req('GET', `/financial-statements/cash-flow?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-12-31`);
  const soce = (co: Co) => co.owner.client.req('GET', `/financial-statements/changes-in-equity?fiscal_year_id=${co.fy}&start_date=2026-01-01&end_date=2026-12-31`);

  it('synthetic case: full-year cash flow and changes in equity reconcile exactly with approved supplements', async () => {
    const co = await setup('syn');
    // Without supplements the S1 rule stands: no cash-flow period may start on or before D.
    expect((await cf(co)).json.code).toBe('CASH_FLOW_EXTERNAL_PERIOD');
    const cfVersion = await approved(co, 'cash_flow', cashBody(co));
    const eqVersion = await approved(co, 'equity', equityBody(co));
    expect([cfVersion.version_no, eqVersion.version_no]).toEqual([1, 1]);

    const c = (await cf(co)).json;
    expect([c.opening_cash_and_cash_equivalents, c.operating_cash_flow, c.investing_cash_flow, c.financing_cash_flow, c.fx_effect]).toEqual(['20000.00', '300000.00', '0.00', '15000.00', '0.00']);
    expect([c.net_change_in_cash_and_cash_equivalents, c.closing_cash_and_cash_equivalents, c.reconciliation.balanced, c.reconciliation.difference]).toEqual(['315000.00', '335000.00', true, '0.00']);
    const operating = c.sections.find((s: { category: string }) => s.category === 'operating');
    expect([operating.pre_cutover_total, operating.native_total, operating.total]).toEqual(['235000.00', '65000.00', '300000.00']);
    expect(operating.pre_cutover_lines[0]).toMatchObject({ source: 'pre_cutover_supplement', amount: '235000.00' });
    expect(c.pre_cutover.completeness).toMatchObject({ full_year_complete: true, status: 'reconciled', supplement: { version_no: 1, state: 'complete', revision_pending: false } });

    const e = (await soce(co)).json;
    expect([e.opening_equity, e.direct_equity_movements, e.current_period_earnings, e.closing_equity]).toEqual(['155000.00', '15000.00', '180000.00', '350000.00']);
    expect([e.reconciliation.balanced, e.reconciliation.actual]).toEqual([true, '350000.00']);
    expect(e.pre_cutover_equity.movements_by_type.contribution).toBe('15000.00');
    expect(e.pre_cutover.full_year_complete).toEqual({ income_statement: true, financial_position: true, changes_in_equity: true, cash_flow: true });

    // Financial position at a partial-year as-of date (spec F, condition 5: the range starts on 1 Jan): the 1 Jan -> as-of span is supported by
    // the cut-over journal + native ledger, so it is complete with status 'evidence_recorded'; an as-of date before D is refused.
    const fpSep = (await co.owner.client.req('GET', `/financial-statements/financial-position?fiscal_year_id=${co.fy}&as_of_date=2026-09-30`)).json;
    expect([fpSep.as_of_date, fpSep.pre_cutover.completeness.full_year_complete, fpSep.pre_cutover.completeness.status, fpSep.accounting_equation.balanced]).toEqual(['2026-09-30', true, 'evidence_recorded', true]);
    const fpEarly = await co.owner.client.req('GET', `/financial-statements/financial-position?fiscal_year_id=${co.fy}&as_of_date=2026-05-31`);
    expect([fpEarly.status, fpEarly.json.code]).toEqual([409, 'EXTERNAL_PERIOD_REPORT_UNAVAILABLE']);
    // A sub-period P&L (not from 1 Jan) is never full-year.
    const plQ4 = (await co.owner.client.req('GET', `/financial-statements/profit-or-loss?fiscal_year_id=${co.fy}&start_date=2026-07-01&end_date=2026-12-31`)).json;
    expect([plQ4.pre_cutover.completeness.full_year_complete, plQ4.pre_cutover.completeness.reasons]).toEqual([false, ['REPORT_RANGE_NOT_FULL_YEAR']]);

    // A period starting inside (1 Jan, D] stays refused; a sub-period after D is unchanged and not full-year.
    const inside = await co.owner.client.req('GET', `/financial-statements/cash-flow?fiscal_year_id=${co.fy}&start_date=2026-03-01&end_date=2026-12-31`);
    expect(inside.json.code).toBe('CASH_FLOW_EXTERNAL_PERIOD');
    const after = (await co.owner.client.req('GET', `/financial-statements/cash-flow?fiscal_year_id=${co.fy}&start_date=2026-07-01&end_date=2026-12-31`)).json;
    expect([after.opening_cash_and_cash_equivalents, after.operating_cash_flow, after.pre_cutover.completeness.full_year_complete]).toEqual(['270000.00', '65000.00', false]);
    // Nothing was written to the ledger.
    expect(await h.count('SELECT COUNT(*) n FROM journal_entries WHERE company_id=$1', [co.id])).toBe(3);

    // Annual package unblocked by history; ledger close carries no supplement warning.
    const annual = (await co.owner.client.req('GET', `/annual-closing/${co.fy}`)).json;
    expect([annual.domains.pre_cutover_history.blocker_count, annual.domains.pre_cutover_history.summary.historical_supplements]).toEqual([0, 'complete']);
    expect(annual.package_manifest.filter((m: { section: string }) => m.section.startsWith('pre_cutover_')).map((m: { section: string; status: string; version_no?: number }) => [m.section, m.status, m.version_no ?? null]))
      .toEqual([['pre_cutover_history', 'ready', null], ['pre_cutover_cash_flow', 'ready', 1], ['pre_cutover_equity', 'ready', 1]]);
    const client = await h.db.connect();
    try {
      const close = await getFiscalYearCloseReadiness(client, co.id, { id: co.fy, start_date: '2026-01-01', end_date: '2026-12-31' });
      expect(close.warnings.map((w) => w.code).filter((x) => /supplement/.test(x))).toEqual([]);
    } finally { client.release(); }
  });

  it('refuses approval for every broken invariant and keeps the version a draft', async () => {
    const co = await setup('inv');
    const cases: Array<[string, 'cash_flow' | 'equity', Record<string, unknown>]> = [
      ['SUPPLEMENT_CASH_CLOSING_MISMATCH', 'cash_flow', { lines: [{ line_type: 'cash_balance', account_id: co.bank, opening_amount: '20000.00', closing_amount: '269999.99' }, { line_type: 'cash_flow', section: 'operating', label: 'x', amount: '249999.99' }] }],
      ['SUPPLEMENT_CASH_ROLLFORWARD_MISMATCH', 'cash_flow', { lines: [{ line_type: 'cash_balance', account_id: co.bank, opening_amount: '20000.00', closing_amount: '270000.00' }, { line_type: 'cash_flow', section: 'operating', label: 'x', amount: '249999.99' }] }],
      ['SUPPLEMENT_CASH_ACCOUNT_MISSING', 'cash_flow', { lines: [{ line_type: 'cash_flow', section: 'operating', label: 'x', amount: '1.00' }] }],
      ['SUPPLEMENT_INTERNAL_TRANSFER_LINE', 'cash_flow', { lines: [...cashBody(co).lines, { line_type: 'cash_flow', section: 'operating', label: 'Transfer', account_id: co.bank, amount: '10.00' }] }],
      ['SUPPLEMENT_CLASSIFICATION_OVERRIDE_REQUIRED', 'cash_flow', { lines: [cashBody(co).lines[0], cashBody(co).lines[1], { line_type: 'cash_flow', section: 'operating', label: 'Loan', account_id: co.loan, amount: '15000.00' }] }],
      ['SUPPLEMENT_FX_EFFECT_NOT_ALLOWED', 'cash_flow', { lines: [cashBody(co).lines[0], { line_type: 'cash_flow', section: 'operating', label: 'x', amount: '249000.00' }, { line_type: 'cash_flow', section: 'fx_effect', label: 'fx', amount: '1000.00' }] }],
      ['SUPPLEMENT_EQUITY_ROLLFORWARD_MISMATCH', 'equity', { lines: [{ line_type: 'equity_opening', account_id: co.cap, opening_amount: '135000.00' }, { line_type: 'equity_opening', account_id: co.re, opening_amount: '20000.00' }] }],
      ['SUPPLEMENT_RETAINED_EARNINGS_MISMATCH', 'equity', { lines: [...equityBody(co).lines.slice(0, 2), { line_type: 'equity_opening', account_id: co.re, opening_amount: '19000.00' }] }],
      ['SUPPLEMENT_EQUITY_ACCOUNT_MISSING', 'equity', { lines: equityBody(co).lines.slice(0, 2) }],
      ['SUPPLEMENT_ACCOUNT_NOT_EQUITY', 'equity', { lines: [...equityBody(co).lines, { line_type: 'equity_opening', account_id: co.rev, opening_amount: '0.00' }] }],
      ['SUPPLEMENT_EQUITY_TRANSFERS_UNBALANCED', 'equity', { lines: [...equityBody(co).lines, { line_type: 'equity_movement', account_id: co.re, movement_type: 'transfer', label: 'T', amount: '5.00' }] }],
      ['SUPPLEMENT_MOVEMENT_SIGN_INVALID', 'equity', { lines: [equityBody(co).lines[0], { line_type: 'equity_movement', account_id: co.cap, movement_type: 'distribution', label: 'D', amount: '15000.00' }, equityBody(co).lines[2]] }],
    ];
    for (const [code, kind, over] of cases) {
      const d = await createDraft(co, kind, kind === 'cash_flow' ? cashBody(co, over) : equityBody(co, over));
      expect(d.status, code).toBe(201);
      expect(d.json.evaluation.issues.map((i: { code: string }) => i.code), code).toContain(code);
      const a = await approve(co, d.json.version.id, d.json.version.row_version);
      expect([a.status, a.json.code], code).toEqual([409, 'SUPPLEMENT_INVARIANTS_FAILED']);
      expect(a.json.detail.issues.map((i: { code: string }) => i.code), code).toContain(code);
      const voided = await co.owner.client.req('POST', `${base(co)}/${d.json.version.id}/void`, { confirm: true, expected_row_version: d.json.version.row_version, reason: 'test' });
      expect(voided.status, code).toBe(200);
    }
    // C4 exception with a written justification is accepted and kept in the audit evidence; the account is not reclassified.
    const ok = await createDraft(co, 'cash_flow', cashBody(co, { lines: [cashBody(co).lines[0], cashBody(co).lines[1], { line_type: 'cash_flow', section: 'operating', label: 'Loan', account_id: co.loan, amount: '15000.00', classification_override_reason: 'Supplier credit facility used for working capital' }] }));
    const a = await approve(co, ok.json.version.id, ok.json.version.row_version);
    expect(a.status).toBe(200);
    expect((await h.q<{ cash_flow_category: string }>('SELECT cash_flow_category FROM accounts WHERE id=$1', [co.loan]))[0]!.cash_flow_category).toBe('financing');
    const audit = (await h.q<{ after_data: { overrides: Array<{ reason: string }> } }>("SELECT after_data FROM audit_log WHERE company_id=$1 AND action='cutover_supplement.approve'", [co.id]))[0]!.after_data;
    expect(audit.overrides[0]!.reason).toBe('Supplier credit facility used for working capital');
    // Malformed input never reaches the database: override without reason length, override without account, zero amount, unknown key.
    for (const line of [
      { line_type: 'cash_flow', section: 'operating', label: 'x', amount: '1.00', account_id: co.loan, classification_override_reason: 'short' },
      { line_type: 'cash_flow', section: 'operating', label: 'x', amount: '1.00', classification_override_reason: 'long enough reason here' },
      { line_type: 'cash_flow', section: 'operating', label: 'x', amount: '0.00' },
      { line_type: 'cash_flow', section: 'operating', label: 'x', amount: '1.001' },
      { line_type: 'equity_opening', account_id: co.cap, opening_amount: '1.00' },
    ]) expect((await createDraft(co, 'cash_flow', cashBody(co, { lines: [line] }))).status).toBe(400);
  });

  it('lifecycle: one draft and one approved per kind, supersession, freeze, no delete, stale writes, audit', async () => {
    const co = await setup('life');
    const v1 = await approved(co, 'cash_flow', cashBody(co));
    // Approved is frozen: lines and header cannot change, nothing can be deleted (raw SQL included).
    expect(await dbError("UPDATE cutover_supplement_lines SET amount=1 WHERE version_id=$1 AND line_type='cash_flow'", [v1.id])).toBe('SUPPLEMENT_IMMUTABLE');
    expect(await dbError("UPDATE cutover_supplement_versions SET evidence_reference='changed' WHERE id=$1", [v1.id])).toBe('SUPPLEMENT_IMMUTABLE');
    expect(await dbError('DELETE FROM cutover_supplement_versions WHERE id=$1', [v1.id])).toBe('SUPPLEMENT_IMMUTABLE');
    expect(await dbError('DELETE FROM cutover_supplement_lines WHERE version_id=$1', [v1.id])).toBe('SUPPLEMENT_IMMUTABLE');
    expect(await dbError("UPDATE cutover_supplement_versions SET status='superseded',superseded_at=NOW(),superseded_by_id=id WHERE id=$1", [v1.id])).toBe('SUPPLEMENT_IMMUTABLE');

    const d2 = await createDraft(co, 'cash_flow', cashBody(co, { evidence_reference: 'Corrected bank statements' }));
    expect([d2.status, d2.json.version.version_no, d2.json.version.supersedes_id]).toEqual([201, 2, v1.id]);
    expect((await createDraft(co, 'cash_flow', cashBody(co))).json.code).toBe('SUPPLEMENT_DRAFT_EXISTS');
    // A pending revision keeps the approved version in force and is disclosed.
    expect((await cf(co)).json.pre_cutover.completeness.supplement).toEqual({ version_no: 1, state: 'complete', revision_pending: true });

    // Stale writes: an edit with an old row_version is refused; a correct edit bumps it.
    const replace = (rv: number) => co.owner.client.req('PUT', `${base(co)}/${d2.json.version.id}`, { ...cashBody(co, { evidence_reference: 'Corrected v2' }), expected_row_version: rv });
    const ok = await replace(1);
    expect([ok.status, ok.json.version.row_version]).toEqual([200, 2]);
    const upd = (await h.q<{ before_data: { lines: Array<{ amount: string | null }>; evidence_reference: string }; after_data: { lines: unknown[]; evidence_reference: string } }>("SELECT before_data,after_data FROM audit_log WHERE entity_id=$1 AND action='cutover_supplement.draft_update'", [d2.json.version.id]))[0]!;
    expect([upd.before_data.evidence_reference, upd.after_data.evidence_reference, upd.before_data.lines.length, upd.after_data.lines.length]).toEqual(['Corrected bank statements', 'Corrected v2', 3, 3]);
    expect(upd.before_data.lines.map((l) => l.amount)).toEqual([null, '235000.00', '15000.00']);
    expect((await replace(1)).json.code).toBe('SUPPLEMENT_STALE_WRITE');
    expect((await approve(co, d2.json.version.id, 1)).json.code).toBe('SUPPLEMENT_STALE_WRITE');
    const a2 = await approve(co, d2.json.version.id, 2);
    expect(a2.status).toBe(200);
    const rows = await h.q<{ version_no: number; status: string; superseded_by_id: string | null }>('SELECT version_no,status,superseded_by_id FROM cutover_supplement_versions WHERE authority_id=$1 ORDER BY version_no', [co.range]);
    expect(rows).toEqual([{ version_no: 1, status: 'superseded', superseded_by_id: d2.json.version.id }, { version_no: 2, status: 'approved', superseded_by_id: null }]);
    expect((await cf(co)).json.pre_cutover.completeness.supplement).toEqual({ version_no: 2, state: 'complete', revision_pending: false });
    const actions = (await h.q<{ action: string }>("SELECT action FROM audit_log WHERE company_id=$1 AND entity_type='cutover_supplement_version' ORDER BY created_at,id", [co.id])).map((r) => r.action);
    // The supersession and the new approval share one transaction (same timestamp), so only their set is compared.
    expect(actions.slice(0, 4)).toEqual(['cutover_supplement.draft_create', 'cutover_supplement.approve', 'cutover_supplement.draft_create', 'cutover_supplement.draft_update']);
    expect(actions.slice(4).sort()).toEqual(['cutover_supplement.approve', 'cutover_supplement.superseded']);
    // 086 is untouched: the active range still refuses any update; supplements never wrote to it.
    expect(await dbError("UPDATE ledger_source_authority SET reason='x' WHERE id=$1", [co.range])).toBe('LEDGER_SOURCE_AUTHORITY_IMMUTABLE');
    expect((await h.q<{ status: string }>('SELECT status FROM ledger_source_authority WHERE id=$1', [co.range]))[0]!.status).toBe('active');
    // Approving a draft re-checks the predecessor: a direct-SQL draft cannot be inserted as approved.
    expect(await dbError("INSERT INTO cutover_supplement_versions(company_id,authority_id,kind,version_no,status,source_system,evidence_reference,functional_currency,prepared_by) VALUES($1,$2,'equity',9,'approved','x','y','SAR',$3)", [co.id, co.range, co.owner.id])).toBe('SUPPLEMENT_IMMUTABLE');
  });

  it('supplements need an ACTIVE range: a draft range or a voided one is refused', async () => {
    const owner = await h.user('draft-own');
    const id = await h.company('draftco', owner.id);
    await owner.client.login();
    await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const range = (await owner.client.req('POST', '/ledger-source-authority/drafts', { from_date: '2026-01-01', to_date: '2026-06-30', reason: 'Excel', confirm: true })).json.range.id as string;
    const r = await owner.client.req('POST', `/ledger-source-authority/${range}/supplements/equity/drafts`, { source_system: 'x', evidence_reference: 'y', confirm: true, lines: [] });
    expect([r.status, r.json.code]).toEqual([409, 'SUPPLEMENT_AUTHORITY_NOT_ACTIVE']);
    expect(await dbError("INSERT INTO cutover_supplement_versions(company_id,authority_id,kind,version_no,source_system,evidence_reference,functional_currency,prepared_by) VALUES($1,$2,'equity',1,'x','y','SAR',$3)", [id, range, owner.id])).toBe('SUPPLEMENT_AUTHORITY_NOT_ACTIVE');
  });

  it('authorization: independent capabilities, no default grant, same actor only with both; tenant isolation on every route', async () => {
    const co = await setup('auth');
    const mk = async (label: string, caps: string[]) => { const u = await h.user(label); await h.member(co.id, u.id, caps); await u.client.login(); return u; };
    // Custom roles here hold ONLY the S2 capabilities (plus unrelated ones): other suites assert that no role holds source_authority.view/manage/activate.
    const viewer = await mk('a-view', ['accounting.view']);
    const preparer = await mk('a-prep', ['source_authority.supplement_manage']);
    const approver = await mk('a-appr', ['source_authority.supplement_approve']);
    const both = await mk('a-both', ['source_authority.supplement_manage', 'source_authority.supplement_approve']);

    expect((await viewer.client.req('GET', base(co))).status).toBe(403); // reading needs source_authority.view
    for (const u of [viewer, approver]) expect((await createDraft(co, 'cash_flow', cashBody(co), u.client)).status).toBe(403);
    const d = await createDraft(co, 'cash_flow', cashBody(co), preparer.client);
    expect(d.status).toBe(201);
    for (const u of [viewer, preparer]) expect((await approve(co, d.json.version.id, 1, u.client)).status).toBe(403);
    expect((await approve(co, d.json.version.id, 1, approver.client)).status).toBe(200);
    // Same actor with both capabilities: allowed, and both actions are audited under that actor.
    const e = await createDraft(co, 'equity', equityBody(co), both.client);
    expect((await approve(co, e.json.version.id, 1, both.client)).status).toBe(200);
    const audits = await h.q<{ action: string; actor_user_id: string }>("SELECT action,actor_user_id FROM audit_log WHERE entity_id=$1 ORDER BY created_at,id", [e.json.version.id]);
    expect(audits.map((x) => [x.action, x.actor_user_id === both.id])).toEqual([['cutover_supplement.draft_create', true], ['cutover_supplement.approve', true]]);
    // Migration 091 grants no role either capability (Full Access holds them through the wildcard only).
    expect(await h.count("SELECT COUNT(*) n FROM role_capabilities rc JOIN roles r ON r.id=rc.role_id WHERE rc.capability_id LIKE 'source_authority.supplement_%' AND r.name IN ('Viewer','Accountant','Finance Manager','Full Access','Company Manager')")).toBe(0);

    // Cross-company: another company's user (Full Access in their own company) cannot read or write this company's range or versions.
    const other = await setup('auth-other');
    const foreign = [
      () => other.owner.client.req('GET', base(co)),
      () => other.owner.client.req('POST', `${base(co)}/cash_flow/drafts`, cashBody(co)),
      () => other.owner.client.req('PUT', `${base(co)}/${d.json.version.id}`, { ...cashBody(co), expected_row_version: 1 }),
      () => other.owner.client.req('POST', `${base(co)}/${d.json.version.id}/void`, { confirm: true, expected_row_version: 1, reason: 'x' }),
      () => other.owner.client.req('POST', `${base(co)}/${d.json.version.id}/approve`, { confirm: true, expected_row_version: 1 }),
      // ID substitution: own range id + the other company's version id.
      () => other.owner.client.req('POST', `/ledger-source-authority/${other.range}/supplements/${d.json.version.id}/approve`, { confirm: true, expected_row_version: 1 }),
    ];
    for (const call of foreign) expect((await call()).status).toBe(404);
    // A line referencing another company's account is refused by the composite foreign key, nothing is written.
    const x = await createDraft(other, 'equity', equityBody(other, { lines: [{ line_type: 'equity_opening', account_id: co.cap, opening_amount: '1.00' }] }));
    expect([x.status, x.json.code]).toEqual([409, 'SUPPLEMENT_ACCOUNT_NOT_FOUND']);
    expect(await h.count('SELECT COUNT(*) n FROM cutover_supplement_versions WHERE company_id=$1', [other.id])).toBe(0);
  });

  it('a failure after the predecessor was superseded rolls back both version transitions and every audit row', async () => {
    const co = await setup('rollback');
    const v1 = await approved(co, 'equity', equityBody(co));
    const d2 = await createDraft(co, 'equity', equityBody(co, { evidence_reference: 'Corrected resolutions' }));
    const auditBefore = await h.count('SELECT COUNT(*) n FROM audit_log WHERE company_id=$1', [co.id]);
    // TEST-ONLY fault injection, scoped to this company: the approval's own audit insert (written AFTER the predecessor became superseded
    // and its supersession audit was written) fails, so the whole transaction must roll back.
    const fn = `test_fail_supplement_approve_${co.id.replace(/-/g, '')}`;
    await h.q(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_INJECTED_FAILURE'; END $$`);
    await h.q(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.company_id = '${co.id}'::uuid AND NEW.action = 'cutover_supplement.approve') EXECUTE FUNCTION ${fn}()`);
    try {
      expect((await approve(co, d2.json.version.id, d2.json.version.row_version)).status).toBe(500);
    } finally {
      await h.q(`DROP TRIGGER ${fn} ON audit_log`); await h.q(`DROP FUNCTION ${fn}()`);
    }
    const rows = await h.q<{ id: string; status: string; row_version: number; superseded_by_id: string | null; approved_by: string | null }>('SELECT id,status,row_version,superseded_by_id,approved_by FROM cutover_supplement_versions WHERE authority_id=$1 ORDER BY version_no', [co.range]);
    expect(rows).toEqual([
      { id: v1.id, status: 'approved', row_version: v1.row_version, superseded_by_id: null, approved_by: co.owner.id },
      { id: d2.json.version.id, status: 'draft', row_version: 1, superseded_by_id: null, approved_by: null },
    ]);
    expect(await h.count('SELECT COUNT(*) n FROM audit_log WHERE company_id=$1', [co.id])).toBe(auditBefore);
    expect((await soce(co)).json.pre_cutover.completeness.supplement).toEqual({ version_no: 1, state: 'complete', revision_pending: true });
    // The same draft can still be approved afterwards (nothing half-applied blocks it).
    expect((await approve(co, d2.json.version.id, 1)).status).toBe(200);
  });

  it('January-1 company: statements, annual closing and close readiness are unchanged (no pre_cutover, no supplement query effect)', async () => {
    const owner = await h.user('jan-own');
    const id = await h.company('jan', owner.id);
    await owner.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const bank = await h.account(id, 'J-BANK', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [bank]);
    const rev = await h.account(id, 'J-REV', 'revenue', 'revenue');
    await h.q("UPDATE accounts SET cash_flow_category='operating' WHERE id=$1", [rev]);
    await h.postedJournal(id, fy, '2026-03-15', owner.id, [[bank, '100', '0'], [rev, '0', '100']]);
    for (const path of ['cash-flow', 'changes-in-equity', 'profit-or-loss']) {
      const r = (await owner.client.req('GET', `/financial-statements/${path}?fiscal_year_id=${fy}&start_date=2026-01-01&end_date=2026-12-31`)).json;
      expect(r.pre_cutover, path).toBeUndefined();
      expect(r.pre_cutover_equity, path).toBeUndefined();
      expect(r.fx_effect, path).toBeUndefined();
    }
    const c = (await owner.client.req('GET', `/financial-statements/cash-flow?fiscal_year_id=${fy}`)).json;
    expect([c.opening_cash_and_cash_equivalents, c.operating_cash_flow, c.closing_cash_and_cash_equivalents]).toEqual(['0.00', '100.00', '100.00']);
    expect(c.sections[0].pre_cutover_total).toBeUndefined();
    const annual = (await owner.client.req('GET', `/annual-closing/${fy}`)).json;
    expect(annual.domains.pre_cutover_history).toBeUndefined();
    expect(annual.package_manifest.map((m: { section: string }) => m.section).filter((s: string) => s.startsWith('pre_cutover'))).toEqual([]);
  });
});
