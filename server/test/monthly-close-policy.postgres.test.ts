import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { FiscalYearService } from '../src/modules/fiscal-years/fiscal-year.service';
import { FiscalYearCloseBlockedError, getFiscalYearCloseReadiness } from '../src/modules/fiscal-years/fiscal-year-close-readiness';
import { AnnualClosingService } from '../src/modules/annual-closing/annual-closing.service';
import { finalizationBlockers, fingerprint, packageManifest } from '../src/modules/annual-closing/annual-package.service';
import { AccountingFiscalYearClosedError, AccountingPeriodClosedError, assertAccountingDateWritable } from '../src/modules/monthly-close/accounting-period.guard';

// Optional monthly closing policy (migration 102) over real PostgreSQL + HTTP. Disposable DATABASE_URL only.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('optional monthly closing policy (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let owner: Awaited<ReturnType<typeof h.user>>;
  let service: FiscalYearService;

  type World = { company: string; fy: string };
  async function world(monthsClosed = 0, policy?: 'required' | 'optional'): Promise<World> {
    const company = await h.company(`mcp${Math.random().toString(36).slice(2, 8)}`, owner.id);
    const fy = await h.fiscalYear(company, 'FY 2026', '2026-01-01', '2026-12-31');
    // The preceding year is closed and empty, so no carry-forward is required; the approved profile makes FY 2026 not the first live year.
    await h.fiscalYear(company, 'FY 2025', '2025-01-01', '2025-12-31', 'closed');
    await h.q(
      `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,prepared_by_user_id,approved_by_user_id,approved_at)
       VALUES($1,1,'approved','IFRS','SAR','SAR','2025-01-01','not_registered','zakat_applicable','saudi_gcc_only','not_currently_applicable','no','2025-01-01',$2,$2,NOW())`, [company, owner.id]);
    for (let m = 1; m <= 12; m++) {
      const start = new Date(Date.UTC(2026, m - 1, 1)).toISOString().slice(0, 10);
      const end = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10);
      await h.q('INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,$3,$4,$5)', [company, fy, start, end, m <= monthsClosed ? 'closed' : 'open']);
    }
    if (policy) await h.q('UPDATE fiscal_years SET monthly_close_policy=$2 WHERE id=$1', [fy, policy]);
    return { company, fy };
  }
  const status = async (w: World) => (await h.q<{ status: string; monthly_close_policy: string }>('SELECT status,monthly_close_policy FROM fiscal_years WHERE id=$1', [w.fy]))[0]!;
  const monthly = async (w: World) => (await h.q<{ status: string }>('SELECT status FROM monthly_close_periods WHERE fiscal_year_id=$1 ORDER BY period_start', [w.fy])).map((r) => r.status);
  const tryClose = async (w: World): Promise<string[]> => {
    try { await service.closeFiscalYear(w.fy, w.company, owner.id, 'test'); return []; }
    catch (e) { if (e instanceof FiscalYearCloseBlockedError) return e.blockers.map((b) => b.code); throw e; }
  };
  const readiness = async (w: World) => { const c = await h.db.connect(); try { return await getFiscalYearCloseReadiness(c, w.company, { id: w.fy, start_date: '2026-01-01', end_date: '2026-12-31' }); } finally { c.release(); } };
  const audits = (w: World) => h.count("SELECT COUNT(*) n FROM audit_log WHERE company_id=$1 AND action='fiscal_year.monthly_close_policy_change'", [w.company]);

  beforeAll(async () => {
    h = await startHarness();
    service = new FiscalYearService(h.db);
    owner = await h.user('mcp-owner');
    await owner.client.login();
  });
  afterAll(() => h.close());

  it('defaults to required and keeps blocking on open months', async () => {
    const w = await world(5);
    expect((await status(w)).monthly_close_policy).toBe('required');
    expect(await tryClose(w)).toContain('monthly_period_open');
    expect((await status(w)).status).toBe('open');
    const all = await world(12);
    expect(await tryClose(all)).toEqual([]);
    expect((await status(all)).status).toBe('closed');
  });

  it.each([[0], [5], [12]])('optional policy closes the year with %i closed months and never closes the others', async (closed) => {
    const w = await world(closed, 'optional');
    const before = await monthly(w);
    expect(await tryClose(w)).toEqual([]);
    expect(await monthly(w)).toEqual(before);
    expect((await status(w)).status).toBe('closed');
  });

  it('optional policy reports open months as a warning, not a blocker', async () => {
    const w = await world(5, 'optional');
    const r = await readiness(w);
    expect(r.blockers.map((b) => b.code)).not.toContain('monthly_period_open');
    expect(r.warnings).toContainEqual({ code: 'monthly_periods_left_open', count: 7 });
    const required = await world(5);
    expect((await readiness(required)).blockers).toContainEqual({ code: 'monthly_period_open', count: 7 });
  });

  it('keeps every other annual gate mandatory under optional', async () => {
    const w = await world(0, 'optional');
    await h.q("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,entry_type,created_by) VALUES($1,$2,'2026-03-01','draft','standard',$3)", [w.company, w.fy, owner.id]);
    const codes = await tryClose(w);
    expect(codes).toContain('draft_journals');
    expect(codes).not.toContain('monthly_period_open');
    expect((await status(w)).status).toBe('open');
  });

  it('closed fiscal year rejects writes in open months; an individually closed month stays protected in an open year', async () => {
    const w = await world(1, 'optional');
    const c = await h.db.connect();
    try {
      await c.query('BEGIN');
      await expect(assertAccountingDateWritable(w.company, '2026-01-15', c)).rejects.toBeInstanceOf(AccountingPeriodClosedError);
      await expect(assertAccountingDateWritable(w.company, '2026-06-15', c)).resolves.toBeUndefined();
      await c.query('ROLLBACK');
    } finally { c.release(); }
    expect(await tryClose(w)).toEqual([]);
    const d = await h.db.connect();
    try {
      await d.query('BEGIN');
      await expect(assertAccountingDateWritable(w.company, '2026-06-15', d)).rejects.toBeInstanceOf(AccountingFiscalYearClosedError);
      await d.query('ROLLBACK');
    } finally { d.release(); }
  });

  it('locks the policy after the annual close (service and database trigger)', async () => {
    const w = await world(0, 'optional');
    expect(await tryClose(w)).toEqual([]);
    await expect(service.setMonthlyClosePolicy(w.fy, w.company, 'required', owner.id)).rejects.toMatchObject({ code: 'MONTHLY_CLOSE_POLICY_LOCKED' });
    await expect(h.q("UPDATE fiscal_years SET monthly_close_policy='required' WHERE id=$1", [w.fy])).rejects.toThrow(/cannot change after the fiscal year is closed/);
    expect((await status(w)).monthly_close_policy).toBe('optional');
  });

  describe('HTTP authorization, isolation and audit', () => {
    const labels = ['full', 'viewOnly', 'manageOnly', 'both', 'other'] as const;
    const u: Record<string, Awaited<ReturnType<typeof h.user>>> = {};
    let A: World; let B: World; let bOwner: Awaited<ReturnType<typeof h.user>>;
    const put = (who: string, fy: string, body: unknown) => u[who]!.client.req('PUT', `/fiscal-years/${fy}/monthly-close-policy`, body);

    beforeAll(async () => {
      for (const l of labels) u[l] = await h.user(`mcp-${l}`);
      bOwner = u['other']!;
      const company = await h.company('mcpA', u['full']!.id);
      const fy = await h.fiscalYear(company, 'FY 2026', '2026-01-01', '2026-12-31');
      A = { company, fy };
      const companyB = await h.company('mcpB', bOwner.id);
      B = { company: companyB, fy: await h.fiscalYear(companyB, 'FY 2026', '2026-01-01', '2026-12-31') };
      await h.member(company, u['viewOnly']!.id, ['fiscal_year.view']);
      await h.member(company, u['manageOnly']!.id, ['fiscal_year.monthly_close_policy.manage']);
      await h.member(company, u['both']!.id, ['fiscal_year.view', 'fiscal_year.monthly_close_policy.manage']);
      for (const l of labels) await u[l]!.client.login();
    });

    it('rejects users without both capabilities and changes nothing', async () => {
      for (const who of ['viewOnly', 'manageOnly']) expect((await put(who, A.fy, { policy: 'optional' })).status).toBe(403);
      expect((await status(A)).monthly_close_policy).toBe('required');
      expect(await audits(A)).toBe(0);
    });

    it('validates the body', async () => {
      for (const body of [{}, { policy: 'maybe' }, { policy: 'optional', extra: 1 }, { policy: 'optional', reason: 5 }, []]) expect((await put('both', A.fy, body)).status).toBe(400);
      expect((await put('both', 'not-a-uuid', { policy: 'optional' })).status).toBe(400);
    });

    it('lets an authorised user change the policy and audits before/after; same value is a no-op', async () => {
      const res = await put('both', A.fy, { policy: 'optional', reason: 'small company' });
      expect([res.status, res.json.fiscalYear.monthly_close_policy]).toEqual([200, 'optional']);
      const log = (await h.q<{ before_data: any; after_data: any; reason: string; actor_user_id: string }>("SELECT before_data,after_data,reason,actor_user_id FROM audit_log WHERE company_id=$1 AND action='fiscal_year.monthly_close_policy_change'", [A.company]))[0]!;
      expect([log.before_data, log.after_data, log.reason, log.actor_user_id]).toEqual([{ monthly_close_policy: 'required' }, { monthly_close_policy: 'optional' }, 'small company', u['both']!.id]);
      expect((await put('both', A.fy, { policy: 'optional' })).status).toBe(200);
      expect(await audits(A)).toBe(1);
      expect((await put('full', A.fy, { policy: 'required' })).status).toBe(200);
      expect(await audits(A)).toBe(2);
    });

    it('is company isolated: another company cannot read or change the policy', async () => {
      expect((await put('other', A.fy, { policy: 'optional' })).status).toBe(404);
      expect((await put('full', B.fy, { policy: 'optional' })).status).toBe(404);
      expect((await status(B)).monthly_close_policy).toBe('required');
      expect(await audits(B)).toBe(0);
      expect((await u['other']!.client.req('GET', `/annual-closing/${A.fy}`)).status).toBe(404);
    });

    it('answers 409 MONTHLY_CLOSE_POLICY_LOCKED once the year is closed', async () => {
      await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [A.fy]);
      const res = await put('full', A.fy, { policy: 'optional' });
      expect([res.status, res.json.code]).toEqual([409, 'MONTHLY_CLOSE_POLICY_LOCKED']);
    });

    it('shows policy and actual monthly statuses in annual readiness', async () => {
      const w = await world(5, 'optional');
      const r = await new AnnualClosingService(h.db).readiness(w.company, w.fy);
      expect(r.fiscal_year.monthly_close_policy).toBe('optional');
      expect(r.domains['monthly_close']).toMatchObject({ ready: true, blocker_count: 0, status: 'ready', summary: { monthly_close_policy: 'optional', expected_periods: 12, closed_periods: 5, open_periods: 7, missing_periods: 0 } });
    });
  });

  it('annual package: critical monthly section follows the policy and a required summary stays unchanged', async () => {
    const svc = (w: World) => new AnnualClosingService(h.db).readiness(w.company, w.fy);
    const req = await world(5);
    const opt = await world(5, 'optional');
    const reqReadiness = await svc(req); const optReadiness = await svc(opt);
    const reqSection = packageManifest(reqReadiness).find((s) => s.section === 'monthly_close')!;
    const optSection = packageManifest(optReadiness).find((s) => s.section === 'monthly_close')!;
    expect(reqSection.status).toBe('blocked');
    expect(finalizationBlockers(packageManifest(reqReadiness))).toContain('monthly_close:blocked');
    expect(optSection).toMatchObject({ status: 'ready', blocker_count: 0, critical: true });
    expect(optSection.summary).toMatchObject({ monthly_close_policy: 'optional', closed_periods: 5, open_periods: 7 });
    expect(finalizationBlockers(packageManifest(optReadiness)).filter((x) => x.startsWith('monthly_close'))).toEqual([]);
    // Pre-102 summaries had no policy key; a 'required' year must not gain one (no fingerprint drift for existing packages).
    expect(Object.keys(reqSection.summary)).not.toContain('monthly_close_policy');
    expect(fingerprint(optSection.summary)).not.toBe(fingerprint({ ...optSection.summary, monthly_close_policy: undefined }));
  });

  it('missing monthly_close_periods rows: blocked under required, allowed and reported accurately under optional (readiness, close, package)', async () => {
    const missing = async (w: World) => h.q("DELETE FROM monthly_close_periods WHERE fiscal_year_id=$1 AND period_start IN ('2026-03-01','2026-09-01')", [w.fy]);
    const annual = (w: World) => new AnnualClosingService(h.db).readiness(w.company, w.fy);

    const req = await world(12);
    await missing(req);
    expect(await monthly(req)).toHaveLength(10);
    const reqR = await annual(req);
    expect(reqR.domains['monthly_close']).toMatchObject({ ready: false, blocker_count: 2, summary: { missing_periods: 2, open_periods: 0, closed_periods: 10 } });
    expect((await readiness(req)).blockers).toContainEqual({ code: 'monthly_period_missing', count: 2 });
    const reqSection = packageManifest(reqR).find((x) => x.section === 'monthly_close')!;
    expect([reqSection.status, reqSection.blocker_count]).toEqual(['blocked', 2]);
    expect(finalizationBlockers(packageManifest(reqR))).toContain('monthly_close:blocked');
    expect(await tryClose(req)).toContain('monthly_period_missing');
    expect((await status(req)).status).toBe('open');

    const opt = await world(12, 'optional');
    await missing(opt);
    const optR = await annual(opt);
    expect(optR.domains['monthly_close']).toMatchObject({ ready: true, blocker_count: 0, status: 'ready', summary: { monthly_close_policy: 'optional', expected_periods: 12, missing_periods: 2, open_periods: 0, closed_periods: 10 } });
    const gate = await readiness(opt);
    expect(gate.ready).toBe(true);
    expect(gate.warnings).toContainEqual({ code: 'monthly_periods_left_open', count: 2 });
    const optSection = packageManifest(optR).find((x) => x.section === 'monthly_close')!;
    expect([optSection.status, optSection.blocker_count]).toEqual(['ready', 0]);
    expect(optSection.summary).toMatchObject({ monthly_close_policy: 'optional', missing_periods: 2, closed_periods: 10 });
    expect(finalizationBlockers(packageManifest(optR)).filter((x) => x.startsWith('monthly_close'))).toEqual([]);
    expect(await tryClose(opt)).toEqual([]);
    expect(await monthly(opt)).toHaveLength(10);
    expect((await status(opt)).status).toBe('closed');
  });

  it('concurrent policy change and annual close never close a year with open months under required', async () => {
    for (let i = 0; i < 4; i++) {
      const w = await world(3);
      const [set, close] = await Promise.allSettled([
        service.setMonthlyClosePolicy(w.fy, w.company, 'optional', owner.id),
        service.closeFiscalYear(w.fy, w.company, owner.id),
      ]);
      const end = await status(w);
      // Either the policy committed first (then the close succeeds) or the close ran first on 'required' (blocked, then the policy is set).
      if (end.status === 'closed') { expect(end.monthly_close_policy).toBe('optional'); expect(set.status).toBe('fulfilled'); }
      else { expect(close.status).toBe('rejected'); expect((close as PromiseRejectedResult).reason).toBeInstanceOf(FiscalYearCloseBlockedError); }
    }
    const w = await world(12);
    const [set, close] = await Promise.allSettled([service.setMonthlyClosePolicy(w.fy, w.company, 'optional', owner.id), service.closeFiscalYear(w.fy, w.company, owner.id)]);
    const end = await status(w);
    expect(close.status).toBe('fulfilled');
    expect(end.monthly_close_policy).toBe(set.status === 'fulfilled' ? 'optional' : 'required');
  });
});
