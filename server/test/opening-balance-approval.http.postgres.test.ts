import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { acceptAllIncomplete } from './helpers/ob-exceptions';
import { ACCOUNTANT_CAPABILITIES, FINANCE_MANAGER_DEFAULT_CAPABILITIES } from '../src/modules/memberships/default-role-capabilities';

// Opening-balance posting guard (PR #452) over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('opening-balance posting guard (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  type User = Awaited<ReturnType<Awaited<ReturnType<typeof startHarness>>['user']>>;
  type Co = { id: string; fy: string; owner: User; bank: string; equity: string; review: string; accountant: User; manager: User };

  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  /** Own company per scenario: Full Access owner, a default-matrix Accountant and Finance Manager, FY2026 and an IN_REVIEW opening-balance review (1000 bank / 1000 equity). */
  async function setup(label: string, status: 'draft' | 'in_review' = 'in_review'): Promise<Co> {
    const owner = await h.user(`${label}-own`);
    const accountant = await h.user(`${label}-acc`);
    const manager = await h.user(`${label}-fm`);
    const id = await h.company(label, owner.id);
    await h.member(id, accountant.id, [...ACCOUNTANT_CAPABILITIES]);
    await h.member(id, manager.id, [...FINANCE_MANAGER_DEFAULT_CAPABILITIES]);
    for (const x of [owner, accountant, manager]) await x.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const bank = await h.account(id, 'OB-BANK', 'asset', 'current_asset');
    const equity = await h.account(id, 'OB-EQ', 'equity', 'equity');
    const review = (await h.q<{ id: string }>('INSERT INTO opening_balance_reviews(company_id,fiscal_year_id,prepared_by) VALUES($1,$2,$3) RETURNING id', [id, fy, owner.id]))[0]!.id;
    for (const [acc, cat, side] of [[bank, 'bank', 'debit'], [equity, 'equity', 'credit']] as const) {
      await h.q("INSERT INTO opening_balance_items(company_id,review_id,category,account_id,amount,balance_side,source_type,confidence,created_by) VALUES($1,$2,$3,$4,1000.00,$5,'internal_ledger','high',$6)", [id, review, cat, acc, side, owner.id]);
    }
    if (status === 'in_review') await h.q("UPDATE opening_balance_reviews SET status='in_review',submitted_by=$2,submitted_at=NOW() WHERE id=$1", [review, owner.id]);
    return { id, fy, owner, bank, equity, review, accountant, manager };
  }
  const accept = async (co: Co) => { const r = await acceptAllIncomplete(co.manager.client, co.fy); expect([200, 201]).toContain(r.status); };
  const approve = (who: User, co: Co) => who.client.req('POST', `/opening-balances/${co.fy}/approve`, {});
  const openingJournals = (co: Co, status?: string) => h.count(`SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND entry_type='opening_balance'${status ? ` AND status='${status}'` : ''}`, [co.id]);
  const reviewRow = async (co: Co) => (await h.q<{ status: string; journal_entry_id: string | null }>('SELECT status,journal_entry_id FROM opening_balance_reviews WHERE id=$1', [co.review]))[0]!;
  const approveAudits = (co: Co) => h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='opening_balance.approve'", [co.id]);

  it('rejects manual opening_balance create, update and post for Full Access, even while a review is awaiting approval', async () => {
    const co = await setup('obManual');
    const o = co.owner.client;
    const created = await o.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: '2026-01-01', description: 'manual opening', entry_type: 'opening_balance' });
    expect([created.status, created.json.code]).toEqual([409, 'OPENING_BALANCE_MANUAL_JOURNAL_BLOCKED']);

    const std = await o.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: '2026-01-01', description: 'draft' });
    expect(std.status).toBe(201);
    const upd = await o.req('PATCH', `/journals/${std.json.id}`, { entry_type: 'opening_balance' });
    expect([upd.status, upd.json.code]).toEqual([409, 'OPENING_BALANCE_MANUAL_JOURNAL_BLOCKED']);
    expect((await h.q<{ entry_type: string }>('SELECT entry_type FROM journal_entries WHERE id=$1', [std.json.id]))[0]!.entry_type).toBe('standard');

    // A draft that already carries entry_type=opening_balance (fixture, e.g. legacy) cannot be posted through the manual endpoint.
    await h.q("UPDATE journal_entries SET entry_type='opening_balance' WHERE id=$1", [std.json.id]);
    for (const [a, d] of [[co.bank, '10.00'], [co.equity, '0']] as const) await h.q("INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,$4,$5,$6)", [co.id, std.json.id, a, d, d === '0' ? '10.00' : '0', d === '0' ? 2 : 1]);
    const posted = await o.req('POST', `/journals/${std.json.id}/post`);
    expect([posted.status, posted.json.code]).toEqual([409, 'OPENING_BALANCE_MANUAL_JOURNAL_BLOCKED']);
    expect((await h.q<{ status: string }>('SELECT status FROM journal_entries WHERE id=$1', [std.json.id]))[0]!.status).toBe('draft');
    expect(await openingJournals(co, 'posted')).toBe(0);
    expect((await reviewRow(co)).status).toBe('in_review');
  });

  it('approval posts exactly one opening journal; a repeat approval is refused and creates nothing', async () => {
    const co = await setup('obOnce');
    await accept(co);
    const res = await approve(co.manager, co);
    expect(res.status).toBe(200);
    expect(res.json.journal.status).toBe('posted');
    expect(await openingJournals(co)).toBe(1);
    expect(await reviewRow(co)).toEqual({ status: 'approved', journal_entry_id: res.json.journal.id });
    const again = await approve(co.manager, co);
    expect(again.status).toBe(409);
    expect(await openingJournals(co)).toBe(1);
    expect(await approveAudits(co)).toBe(1);
  });

  it('concurrent approvals of the same review: exactly one succeeds and one posted opening journal exists', async () => {
    const co = await setup('obRace');
    await accept(co);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => approve(i % 2 ? co.manager : co.owner, co)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) expect(r.status).toBe(409);
    expect(await openingJournals(co)).toBe(1);
    expect(await openingJournals(co, 'posted')).toBe(1);
    expect(await h.count('SELECT COUNT(*)::text n FROM journal_lines WHERE company_id=$1', [co.id])).toBe(2);
    expect((await reviewRow(co)).status).toBe('approved');
    expect(await approveAudits(co)).toBe(1);
  });

  it('rolls back journal, lines, review state and audit when a failure is injected at the last step', async () => {
    const co = await setup('obAtomic');
    await accept(co);
    const fn = `fail_ob_approve_${co.id.replace(/-/g, '')}`;
    await h.q(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${co.id}' AND NEW.action='opening_balance.approve' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    await h.q(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const failed = await approve(co.manager, co);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await openingJournals(co)).toBe(0);
      expect(await h.count('SELECT COUNT(*)::text n FROM journal_lines WHERE company_id=$1', [co.id])).toBe(0);
      expect(await reviewRow(co)).toEqual({ status: 'in_review', journal_entry_id: null });
      expect(await approveAudits(co)).toBe(0);
    } finally {
      await h.q(`DROP TRIGGER ${fn} ON audit_log`);
      await h.q(`DROP FUNCTION ${fn}()`);
    }
    // Nothing was consumed by the failed attempt: the same review can still be approved once.
    expect((await approve(co.manager, co)).status).toBe(200);
    expect(await openingJournals(co, 'posted')).toBe(1);
  });

  it('refuses approval for a review that is not in review, an unknown year and another company', async () => {
    const draft = await setup('obDraft', 'draft');
    expect((await approve(draft.manager, draft)).status).toBe(409);
    expect(await openingJournals(draft)).toBe(0);
    expect(await approveAudits(draft)).toBe(0);

    const A = await setup('obIsoA');
    const B = await setup('obIsoB');
    const foreign = await B.manager.client.req('POST', `/opening-balances/${A.fy}/approve`, {});
    expect(foreign.status).toBe(404);
    const unknown = await A.manager.client.req('POST', '/opening-balances/99999999-9999-4999-8999-999999999999/approve', {});
    expect(unknown.status).toBe(404);
    expect(await reviewRow(A)).toEqual({ status: 'in_review', journal_entry_id: null });
    expect(await openingJournals(A)).toBe(0);
  });

  it('the posting guard itself rejects missing, foreign-company, wrong-year, wrong-state and already-linked review context', async () => {
    const { default: pool } = await import('../src/db/pool');
    const { postJournalInTransaction, OpeningBalanceJournalBlockedError } = await import('../src/modules/accounting/journal-posting');
    const A = await setup('obGuardA');
    const B = await setup('obGuardB');
    const fy27 = await h.fiscalYear(A.id, 'FY27', '2027-01-01', '2027-12-31');
    const draftJournal = async (co: Co, fy: string, date: string) => {
      const id = (await h.q<{ id: string }>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,entry_type,created_by) VALUES($1,$2,$3,'guard','opening_balance',$4) RETURNING id", [co.id, fy, date, co.owner.id]))[0]!.id;
      await h.q('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,10,0,1),($1,$2,$4,0,10,2)', [co.id, id, co.bank, co.equity]);
      return id;
    };
    const attempt = async (journalId: string, ctx?: { openingBalanceReviewId?: string }) => {
      const client = await pool!.connect();
      try {
        await client.query('BEGIN');
        await postJournalInTransaction(client, A.id, A.owner.id, journalId, ctx);
        await client.query('COMMIT');
        return 'posted';
      } catch (e) {
        await client.query('ROLLBACK');
        return e instanceof OpeningBalanceJournalBlockedError ? e.code : `other:${(e as Error).message}`;
      } finally { client.release(); }
    };
    const j = await draftJournal(A, A.fy, '2026-01-01');
    expect(await attempt(j)).toBe('OPENING_BALANCE_MANUAL_JOURNAL_BLOCKED');
    expect(await attempt(j, { openingBalanceReviewId: B.review })).toBe('OPENING_BALANCE_REVIEW_CONTEXT_INVALID');
    const j27 = await draftJournal(A, fy27, '2027-01-01');
    expect(await attempt(j27, { openingBalanceReviewId: A.review })).toBe('OPENING_BALANCE_REVIEW_CONTEXT_INVALID');
    await h.q("UPDATE opening_balance_reviews SET status='draft',submitted_by=NULL,submitted_at=NULL WHERE id=$1", [A.review]);
    expect(await attempt(j, { openingBalanceReviewId: A.review })).toBe('OPENING_BALANCE_REVIEW_CONTEXT_INVALID');
    await h.q("UPDATE opening_balance_reviews SET status='in_review',submitted_by=$2,submitted_at=NOW() WHERE id=$1", [A.review, A.owner.id]);
    expect(await attempt(j, { openingBalanceReviewId: A.review })).toBe('posted'); // a valid, locked, in-review context is accepted
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND status='posted' AND entry_type='opening_balance'", [A.id])).toBe(1);
  });

  it('default Accountant cannot approve; default Finance Manager can', async () => {
    const co = await setup('obAuthz');
    await accept(co);
    const denied = await approve(co.accountant, co);
    expect(denied.status).toBe(403);
    expect(await openingJournals(co)).toBe(0);
    expect(await reviewRow(co)).toEqual({ status: 'in_review', journal_entry_id: null });
    const ok = await approve(co.manager, co);
    expect(ok.status).toBe(200);
    expect(await openingJournals(co, 'posted')).toBe(1);
    // Even the Accountant (journal create/post, no opening_balance.approve) cannot create a manual opening journal.
    const co2 = await setup('obAuthz2');
    const manual = await co2.accountant.client.req('POST', '/journals', { fiscal_year_id: co2.fy, accounting_date: '2026-01-01', description: 'x', entry_type: 'opening_balance' });
    expect([manual.status, manual.json.code]).toEqual([409, 'OPENING_BALANCE_MANUAL_JOURNAL_BLOCKED']);
  });
});
