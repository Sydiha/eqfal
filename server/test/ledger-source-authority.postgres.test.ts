import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// Ledger source authority (C1B-1) over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('ledger source authority (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let Service: typeof import('../src/modules/accounting/ledger-source-authority').LedgerSourceAuthorityService;
  type User = Awaited<ReturnType<Awaited<ReturnType<typeof startHarness>>['user']>>;
  type Co = { id: string; fy: string; owner: User; viewer: User; bank: string; rev: string; svc: InstanceType<typeof Service> };

  beforeAll(async () => {
    h = await startHarness();
    ({ LedgerSourceAuthorityService: Service } = await import('../src/modules/accounting/ledger-source-authority'));
  });
  afterAll(() => h.close());

  async function setup(label: string): Promise<Co> {
    const owner = await h.user(`${label}-own`);
    const viewer = await h.user(`${label}-vw`);
    const id = await h.company(label, owner.id);
    await h.member(id, viewer.id, ['accounting.view']);
    await owner.client.login();
    await viewer.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const bank = await h.account(id, 'LSA-BANK', 'asset', 'current_asset');
    const rev = await h.account(id, 'LSA-REV', 'revenue', 'revenue');
    return { id, fy, owner, viewer, bank, rev, svc: new Service(h.db) };
  }
  const draft = async (co: Co, date: string) => {
    const id = (await h.q<{ id: string }>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,$3,'authority fixture',$4) RETURNING id", [co.id, co.fy, date, co.owner.id]))[0]!.id;
    await h.q('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,100,0,1),($1,$2,$4,0,100,2)', [co.id, id, co.bank, co.rev]);
    return id;
  };
  const status = async (id: string) => (await h.q<{ status: string }>('SELECT status FROM journal_entries WHERE id=$1', [id]))[0]!.status;
  const post = (co: Co, id: string) => co.owner.client.req('POST', `/journals/${id}/post`);
  const postedInActiveRange = (co: Co) => h.count(
    `SELECT COUNT(*)::text n FROM journal_entries j JOIN ledger_source_authority a ON a.company_id=j.company_id AND a.status='active' AND j.accounting_date BETWEEN a.from_date AND a.to_date WHERE j.company_id=$1 AND j.status='posted'`, [co.id]);
  const rawFails = async (sql: string, params: unknown[] = []) => { try { await h.db.query(sql, params); return null; } catch (e) { return (e as { message: string }).message; } };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('behaves exactly as before when no range exists: posting works, the endpoint is empty, and only holders of the capability can read it', async () => {
    const co = await setup('lsaNone');
    const j = await draft(co, '2026-02-10');
    expect((await post(co, j)).status).toBe(200);
    const list = await co.owner.client.req('GET', '/ledger-source-authority');
    expect([list.status, list.json.ranges]).toEqual([200, []]);
    expect((await co.viewer.client.req('GET', '/ledger-source-authority')).status).toBe(403);
    expect(await h.count("SELECT COUNT(*)::text n FROM role_capabilities WHERE capability_id IN ('source_authority.view','source_authority.manage')")).toBe(0);
    expect((await h.q('SELECT implicit_full_access FROM capabilities WHERE id=$1', ['source_authority.manage']))[0]!.implicit_full_access).toBe(true);
  });

  it('refuses to post inside an active range (boundaries inclusive), leaves the draft untouched, and posts outside; voiding reopens the dates', async () => {
    const co = await setup('lsaGuard');
    const range = await co.svc.create(co.id, co.owner.id, { fromDate: '2026-01-01', toDate: '2026-03-31', reason: 'Books kept in Excel until March' });
    expect(range.status).toBe('active');
    const [first, mid, last, after] = [await draft(co, '2026-01-01'), await draft(co, '2026-02-15'), await draft(co, '2026-03-31'), await draft(co, '2026-04-01')];
    for (const j of [first, mid, last]) {
      const res = await post(co, j);
      expect([res.status, res.json.code]).toEqual([409, 'LEDGER_SOURCE_AUTHORITY_BLOCKED']);
      expect(await status(j)).toBe('draft');
    }
    expect((await post(co, after)).status).toBe(200);
    expect(await postedInActiveRange(co)).toBe(0);
    const listed = await co.owner.client.req('GET', '/ledger-source-authority');
    expect(listed.json.ranges.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([[range.id, 'active']]);

    await co.svc.void(co.id, co.owner.id, range.id, 'Entered in EQFAL instead');
    expect((await post(co, mid)).status).toBe(200);
    expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action IN ('ledger_source_authority.create','ledger_source_authority.void')", [co.id])).toBe(2);
  });

  it('refuses a reversal dated inside a range without leaving a journal behind', async () => {
    const co = await setup('lsaRev');
    const original = await h.postedJournal(co.id, co.fy, '2026-04-05', co.owner.id, [[co.bank, '50.00', '0'], [co.rev, '0', '50.00']]);
    await co.svc.create(co.id, co.owner.id, { fromDate: '2026-05-01', toDate: '2026-05-31', reason: 'External May' });
    const res = await co.owner.client.req('POST', `/journals/${original}/reverse`, { accounting_date: '2026-05-10', reason: 'wrong account' });
    expect([res.status, res.json.code]).toEqual([409, 'LEDGER_SOURCE_AUTHORITY_BLOCKED']);
    expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND reversal_of_journal_id=$2', [co.id, original])).toBe(0);
  });

  it('protects every direct-SQL write path: update to posted, insert as posted, and the range table itself', async () => {
    const co = await setup('lsaRaw');
    const range = await co.svc.create(co.id, co.owner.id, { fromDate: '2026-06-01', toDate: '2026-06-30', reason: 'External June' });
    const d = await draft(co, '2026-06-15');
    expect(await rawFails("UPDATE journal_entries SET status='posted',posted_by=$2,posted_at=NOW() WHERE id=$1", [d, co.owner.id])).toBe('LEDGER_SOURCE_AUTHORITY_BLOCKED');
    expect(await rawFails("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,status,created_by,posted_by,posted_at) VALUES($1,$2,'2026-06-20','raw','posted',$3,$3,NOW())", [co.id, co.fy, co.owner.id])).toBe('LEDGER_SOURCE_AUTHORITY_BLOCKED');
    expect(await rawFails("UPDATE ledger_source_authority SET to_date='2026-07-31' WHERE id=$1", [range.id])).toBe('LEDGER_SOURCE_AUTHORITY_IMMUTABLE');
    expect(await rawFails("UPDATE ledger_source_authority SET status='voided' WHERE id=$1", [range.id])).toMatch(/ledger_source_authority_check|violates check constraint/);
    expect(await rawFails('DELETE FROM ledger_source_authority WHERE id=$1', [range.id])).toBe('LEDGER_SOURCE_AUTHORITY_IMMUTABLE');
    expect(await rawFails("INSERT INTO ledger_source_authority(company_id,from_date,to_date,authority,reason,created_by) VALUES($1,'2026-08-01','2026-08-31','imported_ledger','x',$2)", [co.id, co.owner.id])).toMatch(/authority_check|violates check constraint/);
    expect(await postedInActiveRange(co)).toBe(0);
    await co.svc.void(co.id, co.owner.id, range.id, 'Done');
    expect(await rawFails("UPDATE journal_entries SET status='posted',posted_by=$2,posted_at=NOW() WHERE id=$1", [d, co.owner.id])).toBeNull();
  });

  it('rejects ranges that overlap, cover journals of any status, touch closed periods or a fiscal year already on the opening path', async () => {
    const co = await setup('lsaRules');
    const mk = (from: string, to: string) => co.svc.create(co.id, co.owner.id, { fromDate: from, toDate: to, reason: 'External' });
    const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } };

    await mk('2026-01-01', '2026-01-31');
    expect(await code(mk('2026-01-15', '2026-02-15'))).toBe('AUTHORITY_RANGE_OVERLAP');
    expect(await code(mk('2026-02-01', '2026-01-01'))).toBe('AUTHORITY_RANGE_INVALID');

    await draft(co, '2026-03-10');
    expect(await code(mk('2026-03-01', '2026-03-31'))).toBe('AUTHORITY_RANGE_HAS_JOURNALS');

    await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-04-01','2026-04-30','closed')", [co.id, co.fy]);
    expect(await code(mk('2026-04-10', '2026-04-20'))).toBe('AUTHORITY_RANGE_CLOSED_PERIOD');

    const closed = await h.fiscalYear(co.id, 'FY25', '2025-01-01', '2025-12-31', 'closed');
    expect(closed).toBeTruthy();
    expect(await code(mk('2025-03-01', '2025-03-31'))).toBe('AUTHORITY_RANGE_CLOSED_PERIOD');

    // Opening path: an opening review (any status) or a carry-forward-derived opening on the year blocks a range over that year.
    const fy27 = await h.fiscalYear(co.id, 'FY27', '2027-01-01', '2027-12-31');
    await h.q('INSERT INTO opening_balance_reviews(company_id,fiscal_year_id,prepared_by) VALUES($1,$2,$3)', [co.id, fy27, co.owner.id]);
    expect(await code(mk('2027-01-01', '2027-02-28'))).toBe('AUTHORITY_ONBOARDING_PATH_CONFLICT');
  });

  it('blocks approving an opening balance for a year that follows the cut-over path, but not for another year', async () => {
    const co = await setup('lsaOpen');
    const fy27 = await h.fiscalYear(co.id, 'FY27', '2027-01-01', '2027-12-31');
    await co.svc.create(co.id, co.owner.id, { fromDate: '2026-01-01', toDate: '2026-09-30', reason: 'External until September' });
    const equity = await h.account(co.id, 'LSA-EQ', 'equity', 'equity');
    const review = async (fy: string) => {
      const r = (await h.q<{ id: string }>('INSERT INTO opening_balance_reviews(company_id,fiscal_year_id,prepared_by) VALUES($1,$2,$3) RETURNING id', [co.id, fy, co.owner.id]))[0]!.id;
      for (const [acc, cat, side] of [[co.bank, 'bank', 'debit'], [equity, 'equity', 'credit']] as const) {
        await h.q("INSERT INTO opening_balance_items(company_id,review_id,category,account_id,amount,balance_side,source_type,confidence,created_by) VALUES($1,$2,$3,$4,1000.00,$5,'internal_ledger','high',$6)", [co.id, r, cat, acc, side, co.owner.id]);
      }
      await h.q("UPDATE opening_balance_reviews SET status='in_review',submitted_by=$2,submitted_at=NOW() WHERE id=$1", [r, co.owner.id]);
      return r;
    };
    const r26 = await review(co.fy);
    // A review created before/after the range does not make the range legal; the posting path refuses.
    const blocked = await co.owner.client.req('POST', `/opening-balances/${co.fy}/approve`, {});
    expect([blocked.status, blocked.json.code]).toEqual([409, 'ONBOARDING_PATH_CUTOVER_ACTIVE']);
    expect((await h.q<{ status: string; journal_entry_id: string | null }>('SELECT status,journal_entry_id FROM opening_balance_reviews WHERE id=$1', [r26]))[0]).toEqual({ status: 'in_review', journal_entry_id: null });
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND entry_type='opening_balance'", [co.id])).toBe(0);

    await review(fy27);
    const ok = await co.owner.client.req('POST', `/opening-balances/${fy27}/approve`, {});
    expect(ok.status).toBe(200);
  });

  // Deterministic ordering: no sleeps decide who goes first. A transaction holds the month lock and signals; the other side is started and we
  // poll pg_locks (bounded) until ITS backend is observed waiting on an advisory lock; only then is the holder released.
  const waitUntilBlocked = async (pid: number) => {
    for (let i = 0; i < 400; i++) {
      if ((await h.count("SELECT COUNT(*)::text n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted", [pid])) > 0) return;
      await sleep(25);
    }
    throw new Error('backend never started waiting on the month lock');
  };
  const rawDraft = async (c: { query: (...a: any[]) => Promise<any> }, co: Co, date: string) => {
    const id = (await c.query("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,$3,'raw race',$4) RETURNING id", [co.id, co.fy, date, co.owner.id])).rows[0].id as string;
    await c.query('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,10,0,1),($1,$2,$4,0,10,2)', [co.id, id, co.bank, co.rev]);
    return id;
  };
  const postSql = "UPDATE journal_entries SET status='posted',posted_by=$2,posted_at=NOW() WHERE id=$1";

  it('serialises a range insert against a concurrent raw posting in both orders (no posted journal ever lands inside an active range)', async () => {
    const co = await setup('lsaRace');
    // Order 1: the range transaction holds the month lock; the raw posting waits on it, and once the range commits it is refused.
    const rangeTx = await h.db.connect();
    const poster = await h.db.connect();
    try {
      await poster.query('BEGIN');
      const draftId = await rawDraft(poster, co, '2026-07-10'); // uncommitted draft: invisible to the range insert
      const posterPid = (await poster.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      await rangeTx.query('BEGIN');
      await rangeTx.query("INSERT INTO ledger_source_authority(company_id,from_date,to_date,authority,reason,created_by) VALUES($1,'2026-07-01','2026-07-31','external_reference_only','External July',$2)", [co.id, co.owner.id]);
      const posting = poster.query(postSql, [draftId, co.owner.id]).then(() => 'posted', (e: Error) => e.message);
      await waitUntilBlocked(posterPid);
      await rangeTx.query('COMMIT');
      expect(await posting).toBe('LEDGER_SOURCE_AUTHORITY_BLOCKED');
      await poster.query('ROLLBACK');
    } finally { await rangeTx.query('ROLLBACK').catch(() => undefined); await poster.query('ROLLBACK').catch(() => undefined); rangeTx.release(); poster.release(); }
    expect(await postedInActiveRange(co)).toBe(0);

    // Order 2: the posting transaction holds the month lock; the range insert waits on it, and once the posting commits the range is refused.
    const first = await h.db.connect();
    const ranger = await h.db.connect();
    try {
      await first.query('BEGIN');
      const id = await rawDraft(first, co, '2026-08-10');
      await first.query(postSql, [id, co.owner.id]); // trigger takes the August lock here
      const rangerPid = (await ranger.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      const inserting = ranger.query("INSERT INTO ledger_source_authority(company_id,from_date,to_date,authority,reason,created_by) VALUES($1,'2026-08-01','2026-08-31','external_reference_only','External August',$2)", [co.id, co.owner.id])
        .then(() => 'created', (e: Error) => e.message);
      await waitUntilBlocked(rangerPid);
      await first.query('COMMIT');
      expect(await inserting).toBe('AUTHORITY_RANGE_HAS_JOURNALS');
    } finally { await first.query('ROLLBACK').catch(() => undefined); first.release(); ranger.release(); }
    expect(await postedInActiveRange(co)).toBe(0);
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND status='posted' AND accounting_date='2026-08-10'", [co.id])).toBe(1);
  });

  it('a posted journal cannot be moved (accounting_date, company_id, fiscal_year_id, status) by direct SQL, so the authority trigger cannot be bypassed after posting', async () => {
    const co = await setup('lsaMove');
    const other = await setup('lsaMoveOther');
    const j = await draft(co, '2026-02-10');
    expect((await post(co, j)).status).toBe(200);
    await co.svc.create(co.id, co.owner.id, { fromDate: '2026-05-01', toDate: '2026-05-31', reason: 'External May' });
    const fy2 = await h.fiscalYear(co.id, 'FY27', '2027-01-01', '2027-12-31');
    for (const [sql, params] of [
      ["UPDATE journal_entries SET accounting_date='2026-05-10' WHERE id=$1", [j]],
      ['UPDATE journal_entries SET fiscal_year_id=$2 WHERE id=$1', [j, fy2]],
      ['UPDATE journal_entries SET company_id=$2 WHERE id=$1', [j, other.id]],
      ["UPDATE journal_entries SET status='draft' WHERE id=$1", [j]],
      ['DELETE FROM journal_entries WHERE id=$1', [j]],
    ] as const) {
      expect(await rawFails(sql, [...params])).toBe('posted journal is immutable');
    }
    expect((await h.q<{ accounting_date: string; status: string }>("SELECT accounting_date::text,status FROM journal_entries WHERE id=$1", [j]))[0]).toEqual({ accounting_date: '2026-02-10', status: 'posted' });
    // The only way into the ledger is the draft -> posted transition, and it is judged on the NEW date even when the same UPDATE changes it.
    const d = await draft(co, '2026-06-10');
    expect(await rawFails("UPDATE journal_entries SET status='posted',accounting_date='2026-05-12',posted_by=$2,posted_at=NOW() WHERE id=$1", [d, co.owner.id])).toBe('LEDGER_SOURCE_AUTHORITY_BLOCKED');
    expect(await status(d)).toBe('draft');
    expect(await postedInActiveRange(co)).toBe(0);
  });


  it('concurrent overlapping inserts: exactly one wins', async () => {
    const co = await setup('lsaOver');
    const results = await Promise.all(Array.from({ length: 8 }, () => co.svc.create(co.id, co.owner.id, { fromDate: '2026-02-01', toDate: '2026-02-28', reason: 'External' }).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error')));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'AUTHORITY_RANGE_OVERLAP')).toHaveLength(7);
    expect(await h.count("SELECT COUNT(*)::text n FROM ledger_source_authority WHERE company_id=$1 AND status='active'", [co.id])).toBe(1);
  });

  it('mixed concurrent workload (posting, range create/void, monthly close, fiscal-year close, opening approval) never deadlocks and never leaves a posted journal inside a range', async () => {
    const co = await setup('lsaMix');
    const drafts: string[] = [];
    for (let m = 1; m <= 12; m++) drafts.push(await draft(co, `2026-${String(m).padStart(2, '0')}-10`));
    const errors: string[] = [];
    const note = (label: string) => (e: unknown) => { errors.push(`${label}: ${(e as Error).message}`); };
    const work: Array<Promise<unknown>> = [];
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      work.push(post(co, drafts[m - 1]!).catch(note('post')));
      // Ranges on days with no journal (the 20th..25th) race with postings of the 10th in the same month locks.
      work.push(co.svc.create(co.id, co.owner.id, { fromDate: `2026-${mm}-20`, toDate: `2026-${mm}-25`, reason: 'External stub' })
        .then((r) => co.svc.void(co.id, co.owner.id, r.id, 'Reverted'), (e: { code?: string }) => { if (!e.code) throw e; }).catch(note('range')));
    }
    work.push(co.owner.client.req('POST', `/fiscal-years/${co.fy}/close`, {}).catch(note('fy-close')));
    work.push(co.owner.client.req('POST', `/opening-balances/${co.fy}/approve`, {}).catch(note('opening')));
    const timeout = sleep(30_000).then(() => 'timeout');
    expect(await Promise.race([Promise.all(work).then(() => 'done'), timeout])).toBe('done');
    expect(errors).toEqual([]);
    expect(await postedInActiveRange(co)).toBe(0);
  }, 60_000);

  it('isolates tenants: another company neither sees nor is blocked by this company ranges', async () => {
    const a = await setup('lsaIsoA');
    const b = await setup('lsaIsoB');
    await a.svc.create(a.id, a.owner.id, { fromDate: '2026-01-01', toDate: '2026-12-31', reason: 'External all year' });
    expect((await b.owner.client.req('GET', '/ledger-source-authority')).json.ranges).toEqual([]);
    expect((await post(b, await draft(b, '2026-05-05'))).status).toBe(200);
    expect((await post(a, await draft(a, '2026-05-05'))).status).toBe(409);
    expect((await a.owner.client.req('GET', '/ledger-source-authority')).json.ranges).toHaveLength(1);
  });
});
