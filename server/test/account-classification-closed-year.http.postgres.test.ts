import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// P2: account classification is locked once the account has activity in a closed fiscal year (real HTTP + PostgreSQL).
// Requires an isolated, disposable database (DATABASE_URL).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('closed-year account classification lock (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  type Owner = Awaited<ReturnType<Awaited<ReturnType<typeof startHarness>>['user']>>;
  type Co = { id: string; owner: Owner; fy25: string; fy26: string; bank: string; capital: string; rev: string; exp: string; unused: string; openOnly: string; zero: string; suspense: string };
  let A: Co; let B: Co;

  const LOCKED = 'ACCOUNT_CLASSIFICATION_CLOSED_YEAR_LOCKED';
  const ACCOUNT_COLUMNS = 'statement_category,is_contra,cash_role,cash_flow_category,updated_at';

  /** FY2025 (closed) with capital, sales, expense; FY2026 open with activity on `openOnly`; `zero` nets to zero inside FY2025. */
  async function setup(label: string, o: { unmappedActivity?: boolean } = {}): Promise<Co> {
    const owner = await h.user(`${label}-own`);
    const id = await h.company(label, owner.id);
    await owner.client.login();
    const fy25 = await h.fiscalYear(id, 'FY25', '2025-01-01', '2025-12-31');
    const fy26 = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const bank = await h.account(id, 'K-BANK', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [bank]);
    const capital = await h.account(id, 'K-CAP', 'equity', 'equity');
    const rev = await h.account(id, 'K-REV', 'revenue', 'revenue');
    const exp = await h.account(id, 'K-EXP', 'expense', 'operating_expense');
    const unused = await h.account(id, 'K-UNUSED', 'asset');
    const openOnly = await h.account(id, 'K-OPEN', 'expense', 'operating_expense');
    const zero = await h.account(id, 'K-ZERO', 'asset', 'current_asset');
    const suspense = await h.account(id, 'K-SUSP', 'liability');
    await h.q("UPDATE accounts SET cash_flow_category='financing' WHERE id=$1", [capital]);
    await h.q("UPDATE accounts SET cash_flow_category='operating' WHERE id = ANY($1)", [[rev, exp, zero, openOnly]]);
    await h.postedJournal(id, fy25, '2025-01-02', owner.id, [[bank, '10000.00', '0'], [capital, '0', '10000.00']]);
    await h.postedJournal(id, fy25, '2025-03-01', owner.id, [[bank, '5000.00', '0'], [rev, '0', '5000.00']]);
    await h.postedJournal(id, fy25, '2025-04-01', owner.id, [[exp, '2000.00', '0'], [bank, '0', '2000.00']]);
    // Zero ending balance: paid out and refunded within the closed year.
    await h.postedJournal(id, fy25, '2025-05-01', owner.id, [[zero, '300.00', '0'], [bank, '0', '300.00']]);
    await h.postedJournal(id, fy25, '2025-05-20', owner.id, [[bank, '300.00', '0'], [zero, '0', '300.00']]);
    await h.postedJournal(id, fy26, '2026-02-01', owner.id, [[openOnly, '50.00', '0'], [bank, '0', '50.00']]);
    // `suspense` is unmapped and carries activity in the closed year (offset inside the same journal).
    // (Statements refuse to render while an unmapped account has activity, so only the company used for that case carries it.)
    if (o.unmappedActivity) {
      await h.postedJournal(id, fy25, '2025-06-01', owner.id, [[bank, '10.00', '0'], [suspense, '0', '10.00']]);
      await h.postedJournal(id, fy25, '2025-06-02', owner.id, [[suspense, '10.00', '0'], [bank, '0', '10.00']]);
    }
    // Closed directly: P2-F1 must hold without any annual closing package.
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [fy25]);
    return { id, owner, fy25, fy26, bank, capital, rev, exp, unused, openOnly, zero, suspense };
  }

  const patch = (co: Co, account: string, body: Record<string, unknown>, client = co.owner.client) =>
    client.req('PATCH', `/accounts/${account}/classification`, body);
  const row = async (account: string) => (await h.q(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id=$1`, [account]))[0];
  const audits = (account: string) =>
    h.count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='account.classification.update'", [account]);
  const statements = async (co: Co) => {
    const q = `fiscal_year_id=${co.fy25}`;
    const get = async (path: string) => {
      const r = await co.owner.client.req('GET', `/financial-statements/${path}?${q}`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json;
    };
    return { fp: await get('financial-position'), pl: await get('profit-or-loss'), ce: await get('changes-in-equity'), cf: await get('cash-flow') };
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await setup('clsA', { unmappedActivity: true });
    B = await setup('clsB');
  });
  afterAll(() => h.close());

  it('allows a classification change on an account with no activity', async () => {
    const res = await patch(A, A.unused, { statement_category: 'non_current_asset' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.statement_category).toBe('non_current_asset');
  });

  it('allows a classification change when activity exists only in open fiscal years', async () => {
    const res = await patch(A, A.openOnly, { statement_category: 'cost_of_sales' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.statement_category).toBe('cost_of_sales');
  });

  it('rejects every protected field on an account used in a closed year, with 409 and the closed year named', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [A.bank, { statement_category: 'non_current_asset' }],
      [A.bank, { is_contra: true }],
      [A.bank, { cash_role: 'non_cash' }],
      [A.exp, { cash_flow_category: 'investing' }],
      [A.rev, { statement_category: 'other_income' }],
      [A.bank, { statement_category: 'current_asset', cash_role: 'cash_equivalent' }],
    ];
    for (const [account, body] of cases) {
      const res = await patch(A, account, body);
      expect([res.status, res.json.code], JSON.stringify(body)).toEqual([409, LOCKED]);
      expect(res.json.fiscal_years).toEqual([{ id: A.fy25, name: 'FY25' }]);
    }
  });

  it('protects unmapped accounts (P2-F2) and accounts whose closed-year balance nets to zero', async () => {
    expect((await patch(A, A.suspense, { statement_category: 'current_liability' })).json.code).toBe(LOCKED);
    expect((await patch(A, A.zero, { statement_category: 'non_current_asset' })).json.code).toBe(LOCKED);
  });

  it('leaves a rejected account unchanged, writes no audit entry, and keeps closed-year statements identical', async () => {
    const before = { row: await row(B.bank), audits: await audits(B.bank), statements: await statements(B) };
    for (const body of [{ statement_category: 'non_current_asset' }, { cash_role: 'non_cash' }, { is_contra: true }]) {
      expect((await patch(B, B.bank, body)).status).toBe(409);
    }
    expect((await patch(B, B.exp, { statement_category: 'cost_of_sales', cash_flow_category: 'investing' })).status).toBe(409);
    expect(await row(B.bank)).toEqual(before.row);
    expect(await audits(B.bank)).toBe(before.audits);
    expect(await statements(B)).toEqual(before.statements);
  });

  it('still accepts a request that changes nothing on a locked account', async () => {
    const res = await patch(A, A.bank, { statement_category: 'current_asset', cash_role: 'cash' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  });

  it('applies only to the active company: another company\'s closed year neither locks nor unlocks', async () => {
    // B's bank is locked by B's own closed year; A cannot reach B's account at all.
    expect((await patch(A, B.unused, { statement_category: 'current_asset' })).status).toBe(404);
    expect((await patch(B, B.bank, { statement_category: 'non_current_asset' })).json.code).toBe(LOCKED);
    // A fresh account in B is unaffected by A's or B's closed years.
    expect((await patch(B, B.unused, { statement_category: 'current_asset' })).status).toBe(200);
    // Reopening B's year (fixture only) unlocks B, and A stays locked.
    await h.q("UPDATE fiscal_years SET status='open' WHERE id=$1", [B.fy25]);
    expect((await patch(B, B.zero, { statement_category: 'non_current_asset' })).status).toBe(200);
    expect((await patch(A, A.zero, { statement_category: 'non_current_asset' })).json.code).toBe(LOCKED);
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [B.fy25]);
  });

  it('keeps the existing capability and origin requirements', async () => {
    const viewer = await h.user('cls-viewer');
    await h.member(A.id, viewer.id, ['accounting.view']);
    await viewer.client.login();
    expect((await patch(A, A.unused, { statement_category: 'current_asset' }, viewer.client)).status).toBe(403);
    expect((await A.owner.client.req('PATCH', `/accounts/${A.unused}/classification`, { statement_category: 'current_asset' }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('serialises against a concurrent fiscal-year close: an update waiting on the close sees the year closed', async () => {
    const co = await setup('clsRace');
    await h.q("UPDATE fiscal_years SET status='open' WHERE id=$1", [co.fy25]);
    const closer = await h.db.connect();
    try {
      // Same row lock closeFiscalYear takes before it changes status.
      await closer.query('BEGIN');
      await closer.query('SELECT id FROM fiscal_years WHERE id=$1 AND company_id=$2 FOR UPDATE', [co.fy25, co.id]);
      await closer.query("UPDATE fiscal_years SET status='closed' WHERE id=$1", [co.fy25]);
      let settled = false;
      const pending = patch(co, co.bank, { statement_category: 'non_current_asset' }).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await closer.query('COMMIT');
      const res = await pending;
      expect([res.status, res.json.code]).toEqual([409, LOCKED]);
    } finally { closer.release(); }
    expect((await row(co.bank))!.statement_category).toBe('current_asset');
  });

  it('serialises against a concurrent fiscal-year close: a close cannot take the year lock while an update is in flight', async () => {
    const co = await setup('clsRace3');
    await h.q("UPDATE fiscal_years SET status='open' WHERE id=$1", [co.fy25]);
    const tx = await h.db.connect();
    const closer = await h.db.connect();
    try {
      await tx.query('BEGIN');
      const { AccountClassificationService } = await import('../src/modules/accounting/account-classification.router');
      // Drive the service on a pool whose connect() returns this held client, so its transaction stays open until we decide.
      let commitNow!: () => void;
      const gate = new Promise<void>((r) => { commitNow = r; });
      const fake = { connect: async () => ({
        query: async (sql: string, p?: unknown[]) => { if (sql === 'COMMIT') await gate; return sql === 'BEGIN' ? { rows: [] } : tx.query(sql, p); },
        release: () => {},
      }) } as never;
      const update = new AccountClassificationService(fake).update(co.id, co.owner.id, co.bank, { statementCategory: 'non_current_asset' });
      await new Promise((r) => setTimeout(r, 200));
      await expect(closer.query('SELECT id FROM fiscal_years WHERE id=$1 FOR UPDATE NOWAIT', [co.fy25])).rejects.toMatchObject({ code: '55P03' });
      commitNow();
      await update;
      await tx.query('COMMIT');
    } finally { tx.release(); closer.release(); }
  });
});

describeDatabase('closed-year account classification lock: cut-over supplement sources (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  const ACKS = { retained_earnings: true, current_year_pnl: true, cash_balances: true, account_level_limitations: true, pre_closing_trial_balance: true };

  it('locks an account referenced only by an approved cash-flow supplement of a closed year', async () => {
    const owner = await h.user('clsCut-own');
    const id = await h.company('clsCut', owner.id);
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
    const loan = await h.account(id, 'S-LOAN', 'liability', 'non_current_liability');
    await h.q("UPDATE accounts SET cash_flow_category='operating' WHERE id=$1", [rev]);
    await h.q("UPDATE accounts SET cash_flow_category='financing' WHERE id = ANY($1)", [[cap, re, loan]]);
    const range = (await owner.client.req('POST', '/ledger-source-authority/drafts', { from_date: '2026-01-01', to_date: '2026-06-30', reason: 'Excel until June', confirm: true })).json.range.id as string;
    const act = await owner.client.req('POST', `/ledger-source-authority/${range}/activate`, {
      lines: [{ account_id: bank, debit: '270000.00', credit: '0' }, { account_id: cap, debit: '0', credit: '150000.00' }, { account_id: re, debit: '0', credit: '20000.00' }, { account_id: rev, debit: '0', credit: '100000.00' }],
      retained_earnings_account_id: re, tb_reference: 'TB-2026-06', tb_prepared_by: 'Accountant A', tb_source_system: 'Legacy ERP', acknowledgements: ACKS,
      idempotency_key: `key-${Math.random().toString(36).slice(2, 10)}`, confirm: true,
    });
    expect(act.status, JSON.stringify(act.json)).toBe(201);
    // `loan` appears in no journal line: it is referenced only by the supplement's financing flow (repaid before the cut-over date).
    const draft = await owner.client.req('POST', `/ledger-source-authority/${range}/supplements/cash_flow/drafts`, {
      source_system: 'Legacy ERP', evidence_reference: 'Bank statements Jan-Jun 2026', confirm: true,
      lines: [
        { line_type: 'cash_balance', account_id: bank, opening_amount: '20000.00', closing_amount: '270000.00' },
        { line_type: 'cash_flow', section: 'operating', label: 'Customer receipts', amount: '240000.00' },
        { line_type: 'cash_flow', section: 'financing', label: 'Capital contribution', account_id: cap, amount: '15000.00' },
        { line_type: 'cash_flow', section: 'financing', label: 'Loan repaid', account_id: loan, amount: '-5000.00' },
      ],
    });
    expect(draft.status, JSON.stringify(draft.json)).toBe(201);
    const approved = await owner.client.req('POST', `/ledger-source-authority/${range}/supplements/${draft.json.version.id}/approve`, { confirm: true, expected_row_version: draft.json.version.row_version });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    expect(await h.count('SELECT COUNT(*)::text n FROM journal_lines WHERE account_id=$1', [loan])).toBe(0);

    // While the year is open the supplement account can still be reclassified.
    const ok = await owner.client.req('PATCH', `/accounts/${loan}/classification`, { statement_category: 'current_liability' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [fy]);
    for (const body of [{ cash_flow_category: 'operating' }, { statement_category: 'non_current_liability' }]) {
      const res = await owner.client.req('PATCH', `/accounts/${loan}/classification`, body);
      expect([res.status, res.json.code], JSON.stringify(res.json)).toEqual([409, 'ACCOUNT_CLASSIFICATION_CLOSED_YEAR_LOCKED']);
    }
    const res = await owner.client.req('PATCH', `/accounts/${bank}/classification`, { cash_role: 'cash_equivalent' });
    expect(res.json.code).toBe('ACCOUNT_CLASSIFICATION_CLOSED_YEAR_LOCKED');
  });
});
