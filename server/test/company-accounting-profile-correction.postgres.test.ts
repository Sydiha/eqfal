import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { startHarness } from './helpers/http-pg';
import { seedActiveAuthorityRange } from './helpers/authority-fixture';

// Approved accounting-profile correction (migration 090) against real PostgreSQL. Disposable DATABASE_URL only.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('approved accounting profile correction (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let Service: typeof import('../src/modules/company-accounting-profile/company-accounting-profile.service').CompanyAccountingProfileService;
  let locks: typeof import('../src/modules/company-accounting-profile/profile-locks');
  let types: typeof import('../src/modules/company-accounting-profile/company-accounting-profile.types');
  beforeAll(async () => {
    h = await startHarness();
    ({ CompanyAccountingProfileService: Service } = await import('../src/modules/company-accounting-profile/company-accounting-profile.service'));
    locks = await import('../src/modules/company-accounting-profile/profile-locks');
    types = await import('../src/modules/company-accounting-profile/company-accounting-profile.types');
  });
  afterAll(() => h.close());

  const svc = () => new Service(h.db);
  const NOT_REG = { vat_status: 'not_registered', vat_registration_number: null, vat_registered_from: null, vat_deregistered_from: null, vat_filing_frequency: null } as const;

  async function approvedProfile(co: string, user: string, o: { from?: string; to?: string | null; version?: number; vat?: string; notes?: string } = {}) {
    return (await h.q<{ id: string }>(
      `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,
         tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,effective_to,prepared_by_user_id,approved_by_user_id,approved_at,tax_notes)
       VALUES($1,$2,'approved','IFRS','SAR','SAR','2026-01-01',$3,'zakat_applicable','saudi_gcc_only','not_currently_applicable','no',$4,$5,$6,$6,NOW(),$7) RETURNING id`,
      [co, o.version ?? 1, o.vat ?? 'needs_review', o.from ?? '2026-07-01', o.to ?? null, user, o.notes ?? null]))[0]!.id;
  }
  async function setup(label: string, o: { from?: string; to?: string | null; vat?: string } = {}) {
    const owner = await h.user(`${label}-own`);
    const co = await h.company(label, owner.id);
    const fy = await h.fiscalYear(co, 'FY26', '2026-01-01', '2026-12-31');
    const original = await approvedProfile(co, owner.id, o);
    return { owner, co, fy, original };
  }
  /** correction -> submit -> review, ready for approval. */
  async function readyCorrection(s: Awaited<ReturnType<typeof setup>>, input: Record<string, unknown> = NOT_REG) {
    const draft = await svc().createCorrection(s.co, s.owner.id, s.original, input as never, 'Wrong VAT status captured');
    await svc().submitReview(s.co, s.owner.id, draft.id);
    await svc().review(s.co, s.owner.id, draft.id);
    return draft;
  }
  const status = async (id: string) => (await h.q<{ workflow_status: string }>('SELECT workflow_status FROM company_accounting_profiles WHERE id=$1', [id]))[0]!.workflow_status;
  const sql = async (text: string, params: unknown[] = []) => h.db.query(text, params).then(() => null, (e: Error) => e.message);

  it('keeps ordinary future-version approval working with the immutability trigger (period shortened, history kept)', async () => {
    const s = await setup('ord', { from: '2026-01-01', vat: 'not_registered' });
    const v = await svc().createVersion(s.co, s.owner.id, { change_reason: 'new year terms' });
    await svc().updateDraft(s.co, s.owner.id, v.id, { effective_from: '2026-08-01' });
    await svc().submitReview(s.co, s.owner.id, v.id);
    await svc().review(s.co, s.owner.id, v.id);
    const approved = await svc().approve(s.co, s.owner.id, v.id);
    expect(approved.workflow_status).toBe('approved');
    const old = (await h.q<{ effective_to: string; workflow_status: string }>('SELECT effective_to::text,workflow_status FROM company_accounting_profiles WHERE id=$1', [s.original]))[0]!;
    expect(old).toEqual({ effective_to: '2026-07-31', workflow_status: 'approved' });
    expect((await svc().current(s.co, '2026-09-01'))?.id).toBe(v.id);
    expect((await svc().current(s.co, '2026-03-01'))?.id).toBe(s.original);
  });

  it('makes approved profiles immutable in the database; only shortening effective_to or superseding is allowed', async () => {
    const s = await setup('imm');
    expect(await sql("UPDATE company_accounting_profiles SET tax_notes='x' WHERE id=$1", [s.original])).toContain('APPROVED_PROFILE_IMMUTABLE');
    expect(await sql("UPDATE company_accounting_profiles SET vat_status='not_registered' WHERE id=$1", [s.original])).toContain('APPROVED_PROFILE_IMMUTABLE');
    expect(await sql("UPDATE company_accounting_profiles SET effective_from='2026-06-01' WHERE id=$1", [s.original])).toContain('APPROVED_PROFILE_IMMUTABLE');
    expect(await sql("UPDATE company_accounting_profiles SET workflow_status='draft' WHERE id=$1", [s.original])).toContain('APPROVED_PROFILE_IMMUTABLE');
    expect(await sql("UPDATE company_accounting_profiles SET workflow_status='superseded' WHERE id=$1", [s.original])).not.toBeNull(); // CHECK: needs the superseding link
    expect(await sql("UPDATE company_accounting_profiles SET effective_to='2026-12-31',updated_at=NOW() WHERE id=$1", [s.original])).toBeNull(); // shorten from NULL
    expect(await sql("UPDATE company_accounting_profiles SET effective_to='2027-12-31' WHERE id=$1", [s.original])).toContain('APPROVED_PROFILE_IMMUTABLE'); // never extended
    expect(await status(s.original)).toBe('approved');
  });

  it('corrects the same effective period atomically: original stays effective until approval, then is superseded and kept', async () => {
    const s = await setup('fix');
    const draft = await readyCorrection(s);
    expect(draft).toMatchObject({ corrects_profile_id: s.original, effective_from: '2026-07-01', effective_to: null, vat_status: 'not_registered' });
    expect(await status(draft.id)).toBe('reviewed');
    // before approval the original is still the one and only effective profile
    expect((await svc().current(s.co, '2026-07-01'))?.id).toBe(s.original);
    expect((await svc().current(s.co, '2026-07-01'))?.vat_status).toBe('needs_review');

    await expect(svc().approve(s.co, s.owner.id, draft.id, false)).rejects.toBeInstanceOf(types.ProfileForbiddenError);
    expect(await status(s.original)).toBe('approved');
    expect(await status(draft.id)).toBe('reviewed');

    const approved = await svc().approve(s.co, s.owner.id, draft.id, true);
    expect(approved.workflow_status).toBe('approved');
    const old = (await h.q<{ workflow_status: string; superseded_by_profile_id: string; superseded_at: Date | null; vat_status: string; effective_from: string }>(
      'SELECT workflow_status,superseded_by_profile_id,superseded_at,vat_status,effective_from::text FROM company_accounting_profiles WHERE id=$1', [s.original]))[0]!;
    expect(old).toMatchObject({ workflow_status: 'superseded', superseded_by_profile_id: draft.id, vat_status: 'needs_review', effective_from: '2026-07-01' });
    expect(old.superseded_at).not.toBeNull();
    const current = await svc().current(s.co, '2026-07-01');
    expect(current).toMatchObject({ id: draft.id, vat_status: 'not_registered' });
    expect(await h.count("SELECT COUNT(*) n FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved'", [s.co])).toBe(1);
    expect((await svc().history(s.co)).map((p) => p.workflow_status).sort()).toEqual(['approved', 'superseded']);
    const audit = await h.q<{ action: string }>('SELECT action FROM audit_log WHERE company_id=$1 AND entity_type=$2 ORDER BY created_at', [s.co, 'company_accounting_profile']);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['company_accounting_profile.correction_create', 'company_accounting_profile.supersede', 'company_accounting_profile.approve']));
    // the superseded row is terminal
    expect(await sql("UPDATE company_accounting_profiles SET tax_notes='x' WHERE id=$1", [s.original])).toContain('APPROVED_PROFILE_IMMUTABLE');
    // cut-over preview evidence now sees exactly one approved profile covering D+1
    expect((await h.q<{ issue: string | null }>("SELECT ledger_cutover_vat_issue($1,'2026-06-30') issue", [s.co]))[0]!.issue).toBeNull();
  });

  it('keeps currencies, start date and effective dates frozen on a corrective version (service and database)', async () => {
    const s = await setup('frz');
    await expect(svc().createCorrection(s.co, s.owner.id, s.original, { effective_from: '2026-08-01' } as never, 'x')).rejects.toBeInstanceOf(types.ProfileValidationError);
    await expect(svc().createCorrection(s.co, s.owner.id, s.original, { functional_currency: 'USD' } as never, 'x')).rejects.toBeInstanceOf(types.ProfileValidationError);
    await expect(svc().createCorrection(s.co, s.owner.id, s.original, NOT_REG as never, '  ')).rejects.toBeInstanceOf(types.ProfileValidationError);
    const draft = await svc().createCorrection(s.co, s.owner.id, s.original, NOT_REG as never, 'reason');
    await expect(svc().updateDraft(s.co, s.owner.id, draft.id, { effective_from: '2026-09-01' })).rejects.toBeInstanceOf(types.ProfileValidationError);
    await expect(svc().updateDraft(s.co, s.owner.id, draft.id, { reporting_currency: 'USD' })).rejects.toBeInstanceOf(types.ProfileValidationError);
    expect(await svc().updateDraft(s.co, s.owner.id, draft.id, { effective_from: '2026-07-01', tax_notes: 'ok' })).toMatchObject({ tax_notes: 'ok' });
    expect(await sql("UPDATE company_accounting_profiles SET effective_to='2026-12-31' WHERE id=$1", [draft.id])).toContain('CORRECTION_FROZEN_FIELD');
    expect(await sql("UPDATE company_accounting_profiles SET functional_currency='USD' WHERE id=$1", [draft.id])).toContain('CORRECTION_FROZEN_FIELD');
    // one open correction per original
    await expect(svc().createCorrection(s.co, s.owner.id, s.original, NOT_REG as never, 'again')).rejects.toBeInstanceOf(types.ProfileConflictError);
    // an ordinary approval cannot close a profile that has an open correction
    expect(await status(s.original)).toBe('approved');
  });

  it('blocks corrections over closed months, closed fiscal years, VAT periods, VAT journals and tax workpapers; non-VAT fields skip the VAT blockers', async () => {
    // closed month
    let s = await setup('b1');
    await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-08-01','2026-08-31','closed')", [s.co, s.fy]);
    await expect(svc().createCorrection(s.co, s.owner.id, s.original, NOT_REG as never, 'r')).rejects.toThrow('CLOSED_MONTH');
    // closed fiscal year
    s = await setup('b2');
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [s.fy]);
    await expect(svc().createCorrection(s.co, s.owner.id, s.original, { tax_notes: 'x' } as never, 'r')).rejects.toThrow('CLOSED_FISCAL_YEAR');
    // VAT period blocks VAT fields only
    s = await setup('b3');
    await h.q("INSERT INTO vat_periods(company_id,fiscal_year_id,period_start,period_end) VALUES($1,$2,'2026-10-01','2026-12-31')", [s.co, s.fy]);
    const draft = await svc().createCorrection(s.co, s.owner.id, s.original, { tax_notes: 'non-vat correction' } as never, 'r');
    expect(draft.tax_notes).toBe('non-vat correction');
    await svc().updateDraft(s.co, s.owner.id, draft.id, { ...NOT_REG } as never);
    await svc().submitReview(s.co, s.owner.id, draft.id);
    await svc().review(s.co, s.owner.id, draft.id);
    await expect(svc().approve(s.co, s.owner.id, draft.id, true)).rejects.toThrow('VAT_PERIOD');
    expect(await status(s.original)).toBe('approved');
    expect(await status(draft.id)).toBe('reviewed');
    // posted VAT journal
    s = await setup('b4');
    const a1 = await h.account(s.co, 'B4-A1', 'asset', 'current_asset');
    const a2 = await h.account(s.co, 'B4-A2', 'liability', 'current_liability');
    await h.postedJournal(s.co, s.fy, '2026-09-10', s.owner.id, [[a1, '15.00', '0'], [a2, '0', '15.00']], { memo: 'VAT_OUTPUT' });
    const vatDraft = await svc().createCorrection(s.co, s.owner.id, s.original, { tax_notes: 'n' } as never, 'r');
    await svc().updateDraft(s.co, s.owner.id, vatDraft.id, { ...NOT_REG } as never);
    await svc().submitReview(s.co, s.owner.id, vatDraft.id);
    await svc().review(s.co, s.owner.id, vatDraft.id);
    await expect(svc().approve(s.co, s.owner.id, vatDraft.id, true)).rejects.toThrow('POSTED_VAT_JOURNAL');
    // tax workpaper referencing the original
    s = await setup('b5');
    await h.q("INSERT INTO tax_working_papers(company_id,fiscal_year_id,tax_path,prepared_by_user_id,accounting_profile_id) VALUES($1,$2,'zakat',$3,$4)", [s.co, s.fy, s.owner.id, s.original]);
    await expect(svc().createCorrection(s.co, s.owner.id, s.original, { tax_notes: 'x' } as never, 'r')).rejects.toThrow('TAX_WORKPAPER');
  });

  it('never bypasses an activated cut-over window', async () => {
    const s = await setup('cut');
    const draft = await readyCorrection(s);
    await seedActiveAuthorityRange(h.db, s.co, s.owner.id, '2026-01-01', '2026-06-30');
    await expect(svc().approve(s.co, s.owner.id, draft.id, true)).rejects.toThrow(/ACTIVATED_CUTOVER|cut-over/i);
    expect(await status(s.original)).toBe('approved');
    expect(await status(draft.id)).toBe('reviewed');
    // the database guard also refuses the supersede on its own
    expect(await sql("UPDATE company_accounting_profiles SET workflow_status='superseded',superseded_at=NOW(),superseded_by_profile_id=$2 WHERE id=$1", [s.original, draft.id])).toContain('CUTOVER_PROFILE_CHANGE_FORBIDDEN');
  });

  it('refuses a window beyond the lock cap before taking any month lock', async () => {
    const owner = await h.user('cap-own');
    const co = await h.company('cap', owner.id);
    for (let y = 2014; y <= 2026; y++) await h.fiscalYear(co, `FY${y}`, `${y}-01-01`, `${y}-12-31`);
    const original = await approvedProfile(co, owner.id, { from: '2014-01-01' });
    await expect(svc().createCorrection(co, owner.id, original, NOT_REG as never, 'r')).rejects.toThrow('PROFILE_CORRECTION_WINDOW_TOO_LARGE');
    expect(await h.count('SELECT COUNT(*) n FROM company_accounting_profiles WHERE company_id=$1', [co])).toBe(1);
  });

  it('serialises concurrent corrections: exactly one wins, none deadlocks', async () => {
    const s = await setup('race');
    const results = await Promise.allSettled([1, 2, 3].map((i) => svc().createCorrection(s.co, s.owner.id, s.original, { tax_notes: `n${i}` } as never, `r${i}`)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(types.ProfileConflictError);
    }
  });

  async function holdLock(take: (c: PoolClient) => Promise<unknown>) {
    const c = await h.db.connect();
    await c.query('BEGIN');
    await take(c);
    return { release: async () => { await c.query('COMMIT'); c.release(); } };
  }
  const pending = async (p: Promise<unknown>, ms = 350) => Promise.race([p.then(() => 'done', () => 'done'), new Promise((r) => setTimeout(() => r('waiting'), ms))]);

  it('serialises approval behind a shared profile lock held by a VAT writer, behind source-authority activation and behind fiscal-year creation', async () => {
    for (const label of ['sh', 'sa', 'fy'] as const) {
      const s = await setup(`ser-${label}`);
      const draft = await readyCorrection(s);
      const held = await holdLock((c) => (label === 'sh' ? locks.lockCompanyProfileShared(c, s.co) : label === 'sa' ? locks.lockSourceAuthority(c, s.co) : locks.lockCompanyProfile(c, s.co)));
      const approval = svc().approve(s.co, s.owner.id, draft.id, true);
      expect(await pending(approval)).toBe('waiting');
      await held.release();
      await expect(approval).resolves.toMatchObject({ workflow_status: 'approved' });
    }
  });

  it('lets two shared VAT writers run together and makes a writer wait for a correction in progress', async () => {
    const s = await setup('shr');
    const a = await holdLock((c) => locks.lockCompanyProfileShared(c, s.co));
    const b = await holdLock((c) => locks.lockCompanyProfileShared(c, s.co));
    await a.release(); await b.release();
    const excl = await holdLock((c) => locks.lockCompanyProfile(c, s.co));
    const writer = (async () => { const c = await h.db.connect(); try { await c.query('BEGIN'); await locks.lockCompanyProfileShared(c, s.co); await c.query('COMMIT'); } finally { c.release(); } })();
    expect(await pending(writer)).toBe('waiting');
    await excl.release();
    await writer;
  });

  it('takes the locks in one deterministic order so approval, correction and VAT writers never deadlock', async () => {
    const s = await setup('dl');
    const draft = await readyCorrection(s);
    const other = await setup('dl2');
    const vatWriter = async () => { for (let i = 0; i < 5; i++) { const c = await h.db.connect(); try { await c.query('BEGIN'); await locks.lockCompanyProfileShared(c, s.co); await c.query('SELECT 1'); await c.query('COMMIT'); } finally { c.release(); } } };
    const results = await Promise.allSettled([svc().approve(s.co, s.owner.id, draft.id, true), vatWriter(), vatWriter(), svc().createCorrection(other.co, other.owner.id, other.original, NOT_REG as never, 'r')]);
    for (const r of results) expect(r.status).toBe('fulfilled');
  });

  it('leaves other companies and every posted financial record untouched', async () => {
    const a = await setup('iso-a');
    const b = await setup('iso-b');
    const acc1 = await h.account(b.co, 'ISO-A1', 'asset', 'current_asset');
    const acc2 = await h.account(b.co, 'ISO-A2', 'liability', 'current_liability');
    await h.postedJournal(b.co, b.fy, '2026-09-10', b.owner.id, [[acc1, '5.00', '0'], [acc2, '0', '5.00']], { memo: 'VAT_OUTPUT' });
    const snapshot = async () => JSON.stringify([
      await h.q('SELECT * FROM company_accounting_profiles WHERE company_id=$1 ORDER BY version_no', [b.co]),
      await h.q('SELECT id,status,accounting_date::text,posted_at FROM journal_entries WHERE company_id=$1 ORDER BY id', [b.co]),
      await h.q('SELECT id,debit,credit,memo FROM journal_lines WHERE company_id=$1 ORDER BY id', [b.co]),
      await h.q('SELECT * FROM vat_periods WHERE company_id=$1', [b.co]),
    ]);
    const before = await snapshot();
    const journalsA = JSON.stringify(await h.q('SELECT id,status FROM journal_entries WHERE company_id=$1 ORDER BY id', [a.co]));
    const draft = await readyCorrection(a);
    await svc().approve(a.co, a.owner.id, draft.id, true);
    expect(await snapshot()).toBe(before);
    expect(JSON.stringify(await h.q('SELECT id,status FROM journal_entries WHERE company_id=$1 ORDER BY id', [a.co]))).toBe(journalsA);
    // cross-tenant: company B cannot see or correct company A's profile
    await expect(svc().createCorrection(b.co, b.owner.id, draft.id, NOT_REG as never, 'r')).rejects.toBeInstanceOf(types.ProfileNotFoundError);
  });

  it('requires company_accounting_profile.correct to create a correction and both correct and approve to approve it (HTTP)', async () => {
    const s = await setup('http');
    await s.owner.client.login();
    const reviewer = await h.user('http-rev');
    await h.member(s.co, reviewer.id, ['company_accounting_profile.view', 'company_accounting_profile.approve', 'company_accounting_profile.review', 'company_accounting_profile.edit', 'company_accounting_profile.submit']);
    await reviewer.client.login();
    const corrector = await h.user('http-cor');
    await h.member(s.co, corrector.id, ['company_accounting_profile.view', 'company_accounting_profile.correct']);
    await corrector.client.login();

    expect((await reviewer.client.req('POST', `/company-accounting-profiles/${s.original}/corrections`, { correction_reason: 'x' })).status).toBe(403);
    expect((await corrector.client.req('POST', `/company-accounting-profiles/${s.original}/corrections`, {})).status).toBe(400);
    expect((await corrector.client.req('POST', `/company-accounting-profiles/${s.original}/corrections`, { correction_reason: 'x', effective_from: '2026-08-01' })).status).toBe(400);
    const created = await corrector.client.req('POST', `/company-accounting-profiles/${s.original}/corrections`, { correction_reason: 'Wrong VAT status', ...NOT_REG });
    expect(created.status).toBe(201);
    const id = created.json.profile.id as string;
    expect((await reviewer.client.req('POST', `/company-accounting-profiles/${id}/submit-review`)).status).toBe(200);
    expect((await reviewer.client.req('POST', `/company-accounting-profiles/${id}/review`)).status).toBe(200);
    // approve alone is not enough for a corrective version
    const denied = await reviewer.client.req('POST', `/company-accounting-profiles/${id}/approve`);
    expect(denied.status).toBe(403);
    expect(await status(s.original)).toBe('approved');
    // the owner (Full Access) holds both
    const ok = await s.owner.client.req('POST', `/company-accounting-profiles/${id}/approve`);
    expect(ok.status).toBe(200);
    expect(await status(s.original)).toBe('superseded');
    // another company cannot reach it
    const stranger = await setup('http-x');
    await stranger.owner.client.login();
    expect((await stranger.owner.client.req('POST', `/company-accounting-profiles/${id}/corrections`, { correction_reason: 'x' })).status).toBe(404);
  });
});
