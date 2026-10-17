import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedActiveAuthorityRange } from './helpers/authority-fixture';
import { startHarness } from './helpers/http-pg';

// C1B-2 draft state over real HTTP + PostgreSQL. Requires an isolated, disposable database (DATABASE_URL).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('ledger source authority drafts (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let Service: typeof import('../src/modules/accounting/ledger-source-authority').LedgerSourceAuthorityService;
  beforeAll(async () => {
    h = await startHarness();
    ({ LedgerSourceAuthorityService: Service } = await import('../src/modules/accounting/ledger-source-authority'));
  });
  afterAll(() => h.close());

  async function setup(label: string) {
    const owner = await h.user(`${label}-own`);
    const viewer = await h.user(`${label}-vw`);
    const id = await h.company(label, owner.id);
    // No role grants the authority capabilities (a sibling suite asserts that globally): the owner holds them through Full Access,
    // and the viewer holds an unrelated capability only, so every authority route must answer 403 for it.
    await h.member(id, viewer.id, ['accounting.view']);
    const manager = owner;
    for (const u of [owner, viewer]) await u.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const bank = await h.account(id, 'D-BANK', 'asset', 'current_asset');
    const rev = await h.account(id, 'D-REV', 'revenue', 'revenue');
    return { id, fy, owner, manager, viewer, bank, rev };
  }
  type Co = Awaited<ReturnType<typeof setup>>;
  const body = (extra: Record<string, unknown> = {}) => ({ from_date: '2026-01-01', to_date: '2026-06-30', reason: 'Books kept in Excel until June', confirm: true, ...extra });
  const mkDraft = async (co: Co, extra: Record<string, unknown> = {}) => co.manager.client.req('POST', '/ledger-source-authority/drafts', body(extra));
  const journal = async (co: Co, date: string) => {
    const id = (await h.q<{ id: string }>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,$3,'draft fixture',$4) RETURNING id", [co.id, co.fy, date, co.owner.id]))[0]!.id;
    await h.q('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,100,0,1),($1,$2,$4,0,100,2)', [co.id, id, co.bank, co.rev]);
    return id;
  };

  it('creates a draft with manage permission, confirmation and a reason, and audits it', async () => {
    const co = await setup('drCreate');
    const res = await mkDraft(co);
    expect([res.status, res.json.range.status]).toEqual([201, 'draft']);
    const list = await co.manager.client.req('GET', '/ledger-source-authority');
    expect(list.json.ranges.map((r: { status: string }) => r.status)).toEqual(['draft']);
    const audit = await h.q<{ action: string; reason: string }>("SELECT action,reason FROM audit_log WHERE company_id=$1 AND action='ledger_source_authority.draft_create'", [co.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toBe('Books kept in Excel until June');
  });

  it('enforces permissions, confirmation, reason and body shape server-side', async () => {
    const co = await setup('drPerm');
    expect((await co.viewer.client.req('POST', '/ledger-source-authority/drafts', body())).status).toBe(403);
    expect((await co.viewer.client.req('GET', '/ledger-source-authority')).status).toBe(403);
    expect((await co.manager.client.req('POST', '/ledger-source-authority/drafts', body({ confirm: undefined }))).json.code).toBe('CONFIRMATION_REQUIRED');
    expect((await co.manager.client.req('POST', '/ledger-source-authority/drafts', body({ confirm: 'yes' }))).status).toBe(400);
    expect((await mkDraft(co, { reason: '   ' })).status).toBe(400);
    expect((await mkDraft(co, { company_id: co.id })).status).toBe(400);
    expect((await h.q('SELECT 1 FROM ledger_source_authority WHERE company_id=$1', [co.id]))).toHaveLength(0);
  });

  it('requires a fiscal-year start and an end before the year end; rejects a closed year', async () => {
    const co = await setup('drFy');
    for (const extra of [{ from_date: '2026-02-01' }, { to_date: '2026-12-31' }, { from_date: '2025-01-01', to_date: '2025-06-30' }]) {
      const res = await mkDraft(co, extra);
      expect([res.status, res.json.code]).toEqual([409, 'AUTHORITY_DRAFT_FISCAL_YEAR_INVALID']);
    }
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [co.fy]);
    expect((await mkDraft(co)).json.code).toBe('AUTHORITY_DRAFT_FISCAL_YEAR_INVALID');
  });

  it('has no accounting effect: posting, opening-balance path and the active guard are untouched', async () => {
    const co = await setup('drNoEffect');
    const j = await journal(co, '2026-03-10');
    expect((await mkDraft(co)).status).toBe(201);
    expect((await co.owner.client.req('POST', `/journals/${j}/post`)).status).toBe(200);
    const { assertFiscalYearNotInCutoverPath } = await import('../src/modules/accounting/ledger-source-authority');
    await expect(assertFiscalYearNotInCutoverPath(h.db as never, co.id, co.fy)).resolves.toBeUndefined();
    // an ACTIVE range elsewhere in the company (test fixture) is still enforced while a draft exists
    const active = await seedActiveAuthorityRange(h.db, co.id, co.owner.id, '2026-09-01', '2026-09-30');
    const blocked = await co.owner.client.req('POST', `/journals/${await journal(co, '2026-09-05')}/post`);
    expect([blocked.status, blocked.json.code]).toEqual([409, 'LEDGER_SOURCE_AUTHORITY_BLOCKED']);
    expect(active.status).toBe('active');
  });

  it('refuses a draft that overlaps another draft or an active range', async () => {
    const co = await setup('drOverlap');
    expect((await mkDraft(co)).status).toBe(201);
    const dup = await mkDraft(co, { to_date: '2026-03-31' });
    expect([dup.status, dup.json.code]).toEqual([409, 'AUTHORITY_RANGE_OVERLAP']);
    const co2 = await setup('drOverlap2');
    await seedActiveAuthorityRange(h.db, co2.id, co2.owner.id, '2026-01-01', '2026-02-28');
    expect((await mkDraft(co2)).json.code).toBe('AUTHORITY_RANGE_OVERLAP');
  });

  it('no path creates an active range (raw SQL refused even when disjoint), and a voided draft frees the period for a new draft', async () => {
    const co = await setup('drSym');
    const draftId = (await mkDraft(co)).json.range.id as string; // 2026-01-01..2026-06-30
    const raw = async (from: string, to: string, status: string) => {
      try { await h.db.query("INSERT INTO ledger_source_authority(company_id,from_date,to_date,authority,status,reason,created_by) VALUES($1,$2,$3,'external_reference_only',$4,'r',$5)", [co.id, from, to, status, co.owner.id]); return null; } catch (e) { return (e as { message: string }).message; }
    };
    expect(await raw('2026-06-30', '2026-07-15', 'active')).toBe('AUTHORITY_ACTIVE_INSERT_FORBIDDEN');
    expect(await raw('2026-07-01', '2026-07-31', 'active')).toBe('AUTHORITY_ACTIVE_INSERT_FORBIDDEN');
    expect(await h.count("SELECT COUNT(*)::text n FROM ledger_source_authority WHERE company_id=$1 AND status='active'", [co.id])).toBe(0);
    await co.manager.client.req('POST', `/ledger-source-authority/${draftId}/void-draft`, { reason: 'plan changed', confirm: true });
    expect((await mkDraft(co)).status).toBe(201);
  });

  it('concurrent draft inserts over the same dates: exactly one wins', async () => {
    for (let i = 0; i < 5; i += 1) {
      const co = await setup(`drRace${i}`);
      const results = await Promise.all([mkDraft(co), mkDraft(co, { to_date: '2026-02-28' })]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    }
  });

  it('refuses a draft for a year already on the opening-balance path', async () => {
    const co = await setup('drOpening');
    await h.q("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by,entry_type) VALUES($1,$2,'2026-01-01','opening',$3,'opening_balance')", [co.id, co.fy, co.owner.id]);
    const res = await mkDraft(co);
    expect([res.status, res.json.code]).toEqual([409, 'AUTHORITY_ONBOARDING_PATH_CONFLICT']);
  });

  it('voids a draft only with manage, confirmation and a reason; history is kept; a voided draft cannot be voided again', async () => {
    const co = await setup('drVoid');
    const id = (await mkDraft(co)).json.range.id as string;
    expect((await co.viewer.client.req('POST', `/ledger-source-authority/${id}/void-draft`, { reason: 'x', confirm: true })).status).toBe(403);
    expect((await co.manager.client.req('POST', `/ledger-source-authority/${id}/void-draft`, { reason: 'x' })).json.code).toBe('CONFIRMATION_REQUIRED');
    expect((await co.manager.client.req('POST', `/ledger-source-authority/${id}/void-draft`, { reason: '', confirm: true })).status).toBe(400);
    const ok = await co.manager.client.req('POST', `/ledger-source-authority/${id}/void-draft`, { reason: 'Changed plan', confirm: true });
    expect([ok.status, ok.json.range.status, ok.json.range.void_reason]).toEqual([200, 'voided', 'Changed plan']);
    expect((await co.manager.client.req('POST', `/ledger-source-authority/${id}/void-draft`, { reason: 'again', confirm: true })).status).toBe(409);
    expect((await h.q('SELECT 1 FROM ledger_source_authority WHERE id=$1', [id]))).toHaveLength(1);
    expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='ledger_source_authority.draft_void'", [co.id])).toBe(1);
    expect((await mkDraft(co)).status).toBe(201); // a voided draft frees the period
  });

  it('void-draft refuses an active range and is company scoped', async () => {
    const co = await setup('drScopeA');
    const other = await setup('drScopeB');
    const active = await seedActiveAuthorityRange(h.db, co.id, co.owner.id, '2026-01-01', '2026-01-31');
    expect((await co.manager.client.req('POST', `/ledger-source-authority/${active.id}/void-draft`, { reason: 'x', confirm: true })).status).toBe(409);
    const dB = (await mkDraft(other)).json.range.id as string;
    expect((await co.manager.client.req('POST', `/ledger-source-authority/${dB}/void-draft`, { reason: 'x', confirm: true })).status).toBe(404);
    expect((await co.manager.client.req('GET', '/ledger-source-authority')).json.ranges.map((r: { id: string }) => r.id)).not.toContain(dB);
    expect((await h.q<{ status: string }>('SELECT status FROM ledger_source_authority WHERE id=$1', [dB]))[0]!.status).toBe('draft');
  });

  it('the database refuses draft -> active, edits, deletes and a voided->anything change, even by raw SQL', async () => {
    const co = await setup('drRaw');
    const id = (await mkDraft(co)).json.range.id as string;
    const fails = async (sql: string) => { try { await h.db.query(sql, [id]); return null; } catch (e) { return (e as { message: string }).message; } };
    expect(await fails("UPDATE ledger_source_authority SET status='active' WHERE id=$1")).toBe('LEDGER_SOURCE_AUTHORITY_IMMUTABLE');
    expect(await fails("UPDATE ledger_source_authority SET to_date='2026-05-31' WHERE id=$1")).toBe('LEDGER_SOURCE_AUTHORITY_IMMUTABLE');
    expect(await fails('DELETE FROM ledger_source_authority WHERE id=$1')).toBe('LEDGER_SOURCE_AUTHORITY_IMMUTABLE');
    expect(await fails("INSERT INTO ledger_source_authority(company_id,from_date,to_date,authority,status,reason,created_by) SELECT company_id,'2026-08-01','2026-08-31','imported_ledger','draft','r',created_by FROM ledger_source_authority WHERE id=$1")).toMatch(/check/i);
    expect((await h.q<{ status: string }>('SELECT status FROM ledger_source_authority WHERE id=$1', [id]))[0]!.status).toBe('draft');
  });
});
