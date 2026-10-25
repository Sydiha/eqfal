import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { startHarness } from './helpers/http-pg';
import { AnnualClosingService } from '../src/modules/annual-closing/annual-closing.service';
import type { AnnualClosingResponse } from '../src/modules/annual-closing/annual-closing.types';

// P3: annual package finalization prerequisite, fingerprint V2 and V1 legacy compatibility (real PostgreSQL, disposable DATABASE_URL only).
// The readiness aggregate (tax workpaper, VAT, banking, ...) is stubbed as "ready" so the suite isolates package, fiscal-year and ledger behaviour;
// everything else (fiscal-year locks, ledger source, snapshots, audit log, immutability triggers, HTTP authorization) is real.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('annual package integrity P3 (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let Svc: typeof import('../src/modules/annual-closing/annual-package.service');
  let posting: typeof import('../src/modules/accounting/journal-posting');
  let blockedDomain: string | null = null;
  let bump = 0;

  const readyResponse = (fy: string): AnnualClosingResponse => {
    const domain = (key: string) => ({ ready: key !== blockedDomain, status: key === blockedDomain ? 'blocked' as const : 'ready' as const, blocker_count: key === blockedDomain ? 1 : 0, summary: { blockers: key === blockedDomain ? `${key}_blocker` : '', bump } });
    const domains = Object.fromEntries(['monthly_close', 'ledger', 'vat', 'banking', 'receivables_payables', 'documents', 'partners', 'assets', 'adjustments', 'opening_balances', 'zakat'].map((k) => [k, domain(k)]));
    const fb = ['monthly_close', 'ledger', 'documents', 'assets', 'adjustments', 'opening_balances'].filter((k) => k === blockedDomain).length;
    return { fiscal_year: { id: fy, start_date: '2025-01-01', end_date: '2025-12-31', status: 'closed' }, ready: fb === 0, blocker_count: fb, domains, financial_statements_readiness: { status: fb ? 'needs_review' : 'ready', label: '', label_ar: '' }, zakat_readiness: { status: 'ready' } as never, package_manifest: [{ section: 'financial_statements_readiness', status: fb ? 'blocked' : 'ready', blocker_count: fb, source: 'annual-closing' }] } as unknown as AnnualClosingResponse;
  };

  beforeAll(async () => {
    h = await startHarness();
    Svc = await import('../src/modules/annual-closing/annual-package.service');
    posting = await import('../src/modules/accounting/journal-posting');
    vi.spyOn(AnnualClosingService.prototype, 'readiness').mockImplementation(async (_c, fy) => readyResponse(fy));
  });
  afterAll(() => { vi.restoreAllMocks(); h.close(); });

  const svc = () => new Svc.AnnualPackageService(h.db);
  const FIN = 'ANNUAL_PACKAGE_FISCAL_YEAR_NOT_CLOSED';

  async function setup(label: string, status = 'closed') {
    const owner = await h.user(`${label}-own`);
    const co = await h.company(label, owner.id);
    await owner.client.login();
    const fy = await h.fiscalYear(co, 'FY25', '2025-01-01', '2025-12-31');
    const bank = await h.account(co, 'P3-BANK', 'asset', 'current_asset');
    const rev = await h.account(co, 'P3-REV', 'revenue', 'revenue');
    const exp = await h.account(co, 'P3-EXP', 'expense', 'operating_expense');
    await h.postedJournal(co, fy, '2025-02-01', owner.id, [[bank, '100.00', '0'], [rev, '0', '100.00']]);
    if (status === 'closed') await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [fy]);
    return { co, owner, fy, bank, rev, exp };
  }
  const auditCount = (co: string, action: string) => h.count('SELECT COUNT(*) n FROM audit_log WHERE company_id=$1 AND action=$2', [co, action]);
  const fp = async (t: { co: string; fy: string }) => ((await (svc() as any).live(t.co, t.fy, h.db)).source_fingerprint as string);

  it('1+16. finalization is rejected with 409 and a stable code while the year is open, without a transition audit', async () => {
    const t = await setup('open', 'open');
    await svc().create(t.co, t.fy, t.owner.id);
    await expect(svc().finalize(t.co, t.fy, t.owner.id, 1)).rejects.toMatchObject({ code: FIN });
    const r = await t.owner.client.req('POST', `/annual-closing/${t.fy}/package/finalize`, { version: 1 });
    expect(r.status).toBe(409); expect(r.json.code).toBe(FIN);
    expect((await svc().get(t.co, t.fy)).package).toMatchObject({ status: 'draft', version: 1, final_snapshot_id: null });
    expect(await h.count("SELECT COUNT(*) n FROM annual_closing_package_snapshots WHERE company_id=$1", [t.co])).toBe(0);
    expect(await auditCount(t.co, 'annual_package.finalized')).toBe(0);
    expect(await auditCount(t.co, 'annual_package.snapshot_created')).toBe(0);
  });

  it('2+4. finalization succeeds once the year is closed and stores a V2 fingerprint', async () => {
    const t = await setup('closed');
    await svc().create(t.co, t.fy, t.owner.id);
    const r = await t.owner.client.req('POST', `/annual-closing/${t.fy}/package/finalize`, { version: 1 });
    expect(r.status).toBe(200); expect(r.json.package.status).toBe('finalized');
    const snap = (await h.q<{ source_fingerprint: string }>("SELECT source_fingerprint FROM annual_closing_package_snapshots WHERE company_id=$1 AND snapshot_type='final'", [t.co]))[0]!;
    expect(snap.source_fingerprint).toMatch(/^v2:[0-9a-f]{64}$/);
    const got = await svc().get(t.co, t.fy);
    expect(got).toMatchObject({ drift: false, fingerprint_version: 2, financial_coverage: true, legacy_fingerprint: false });
    expect(await auditCount(t.co, 'annual_package.finalized')).toBe(1);
  });

  it('3. a concurrent fiscal-year close cannot be bypassed: finalize waits on the close lock and sees its outcome', async () => {
    for (const outcome of ['commit', 'rollback'] as const) {
      const t = await setup(`conc-${outcome}`, 'open');
      await svc().create(t.co, t.fy, t.owner.id);
      const closer: PoolClient = await h.db.connect();
      await closer.query('BEGIN');
      await closer.query('SELECT id FROM fiscal_years WHERE id=$1 AND company_id=$2 FOR UPDATE', [t.fy, t.co]);
      await closer.query("UPDATE fiscal_years SET status='closed' WHERE id=$1", [t.fy]);
      let settled = false;
      const attempt = svc().finalize(t.co, t.fy, t.owner.id, 1).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error').finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // blocked behind the close transaction
      await closer.query(outcome === 'commit' ? 'COMMIT' : 'ROLLBACK');
      closer.release();
      expect(await attempt).toBe(outcome === 'commit' ? 'ok' : FIN);
    }
  });

  it('5+9. V2 is deterministic and identical for unchanged sources', async () => {
    const t = await setup('det');
    const a = await fp(t); const b = await fp(t);
    expect(a).toBe(b); expect(a.startsWith('v2:')).toBe(true);
  });

  it('6. a posted amount change alters V2', async () => {
    const t = await setup('amt');
    const base = await fp(t);
    await h.postedJournal(t.co, t.fy, '2025-03-01', t.owner.id, [[t.exp, '10.00', '0'], [t.bank, '0', '10.00']]);
    expect(await fp(t)).not.toBe(base);
  });

  it('8. statement and cash-flow classification changes alter V2', async () => {
    const t = await setup('cls');
    const base = await fp(t);
    await h.q("UPDATE accounts SET statement_category='non_current_asset' WHERE id=$1", [t.bank]);
    const mid = await fp(t);
    expect(mid).not.toBe(base);
    await h.q("UPDATE accounts SET cash_flow_category='operating' WHERE id=$1", [t.rev]);
    expect(await fp(t)).not.toBe(mid);
  });

  it('7. per-account changes are detected even when debit and credit totals are equal', async () => {
    const t = await setup('acct', 'closed');
    const fy2 = await h.fiscalYear(t.co, 'FY26', '2026-01-01', '2026-12-31');
    const other = await h.account(t.co, 'P3-OTHER', 'revenue', 'revenue');
    await h.postedJournal(t.co, fy2, '2026-02-01', t.owner.id, [[t.bank, '100.00', '0'], [other, '0', '100.00']]);
    const a = await Svc.loadLedgerFingerprintSource(t.co, t.fy, h.db); const b = await Svc.loadLedgerFingerprintSource(t.co, fy2, h.db);
    expect(a.total_debit_halalas).toBe(b.total_debit_halalas); expect(a.total_credit_halalas).toBe(b.total_credit_halalas); expect(a.posted_journals).toBe(b.posted_journals);
    expect(a.total_debit_halalas).toBe('10000'); // exact integer halalas
    expect(Svc.fingerprintV2('x', a)).not.toBe(Svc.fingerprintV2('x', b));
  });

  async function legacyPackage(t: { co: string; fy: string; owner: { id: string } }, status = 'approved') {
    const live = await (svc() as any).live(t.co, t.fy, h.db);
    const pkg = (await h.q<{ id: string }>("INSERT INTO annual_closing_packages(company_id,fiscal_year_id) VALUES($1,$2) RETURNING id", [t.co, t.fy]))[0]!.id;
    const snap = (await h.q<{ id: string }>("INSERT INTO annual_closing_package_snapshots(company_id,package_id,fiscal_year_id,snapshot_no,snapshot_type,manifest,readiness,source_fingerprint,created_by_user_id) VALUES($1,$2,$3,1,'final','[]','{}',$4,$5) RETURNING id", [t.co, pkg, t.fy, live.source_fingerprint_v1, t.owner.id]))[0]!.id;
    await h.q("UPDATE annual_closing_packages SET status='finalized',final_snapshot_id=$2,finalized_by_user_id=$3,finalized_at=NOW() WHERE id=$1", [pkg, snap, t.owner.id]);
    if (status !== 'finalized') await h.q("UPDATE annual_closing_packages SET status='handed_off',handed_off_by_user_id=$2,handed_off_at=NOW() WHERE id=$1", [pkg, t.owner.id]);
    if (status === 'approved') await h.q("UPDATE annual_closing_packages SET status='approved',reviewed_by_user_id=$2,reviewed_at=NOW(),approved_by_user_id=$2,approved_at=NOW() WHERE id=$1", [pkg, t.owner.id]);
    return { pkg, snap, v1: live.source_fingerprint_v1 as string };
  }

  it('10+11+12. a V1 package keeps its fingerprint and status, uses V1 semantics and is flagged as lacking V2 coverage', async () => {
    const t = await setup('v1');
    const { pkg, snap, v1 } = await legacyPackage(t);
    let got = await svc().get(t.co, t.fy);
    expect(got).toMatchObject({ drift: false, fingerprint_version: 1, financial_coverage: false, legacy_fingerprint: true });
    expect(got.package.status).toBe('approved');
    // Ledger amounts are outside V1: a new posted journal does not register as drift (documented legacy limitation).
    await h.postedJournal(t.co, t.fy, '2025-04-01', t.owner.id, [[t.exp, '5.00', '0'], [t.bank, '0', '5.00']]);
    got = await svc().get(t.co, t.fy);
    expect(got.drift).toBe(false); expect(got.legacy_fingerprint).toBe(true);
    // V1-covered drift (readiness change) is still detected.
    blockedDomain = 'documents';
    try { expect((await svc().get(t.co, t.fy)).drift).toBe(true); } finally { blockedDomain = null; }
    const stored = (await h.q<{ source_fingerprint: string }>('SELECT source_fingerprint FROM annual_closing_package_snapshots WHERE id=$1', [snap]))[0]!;
    expect(stored.source_fingerprint).toBe(v1);
    expect((await h.q<{ status: string }>('SELECT status FROM annual_closing_packages WHERE id=$1', [pkg]))[0]!.status).toBe('approved');
  });

  it('13. profile corrections are blocked for finalized, handed_off, reviewed and approved packages (not draft)', async () => {
    const { findCorrectionBlocker } = await import('../src/modules/company-accounting-profile/profile-correction-guards');
    const probe = async (status: string) => {
      const t = await setup(`g-${status}`, 'open');
      const pkg = (await h.q<{ id: string }>('INSERT INTO annual_closing_packages(company_id,fiscal_year_id) VALUES($1,$2) RETURNING id', [t.co, t.fy]))[0]!.id;
      if (status !== 'draft') {
        const snap = (await h.q<{ id: string }>("INSERT INTO annual_closing_package_snapshots(company_id,package_id,fiscal_year_id,snapshot_no,snapshot_type,manifest,readiness,source_fingerprint,created_by_user_id) VALUES($1,$2,$3,1,'final','[]','{}','x',$4) RETURNING id", [t.co, pkg, t.fy, t.owner.id]))[0]!.id;
        const extra = status === 'reviewed' || status === 'approved' ? ',reviewed_by_user_id=$3,reviewed_at=NOW()' : '';
        const extra2 = status === 'approved' ? ',approved_by_user_id=$3,approved_at=NOW()' : '';
        const hand = status === 'handed_off' || status === 'reviewed' || status === 'approved' ? ',handed_off_by_user_id=$3,handed_off_at=NOW()' : '';
        await h.q(`UPDATE annual_closing_packages SET status=$4,final_snapshot_id=$2,finalized_by_user_id=$3,finalized_at=NOW()${hand}${extra}${extra2} WHERE id=$1`, [pkg, snap, t.owner.id, status]);
      }
      const client = await h.db.connect();
      try {
        const original = { company_id: t.co, id: randomId(), effective_from: '2025-01-01', effective_to: '2025-12-31' } as never;
        return await findCorrectionBlocker(client, original, ['notes']);
      } finally { client.release(); }
    };
    expect(await probe('draft')).not.toBe('ANNUAL_PACKAGE');
    for (const s of ['finalized', 'handed_off', 'reviewed', 'approved']) expect(await probe(s)).toBe('ANNUAL_PACKAGE');
  });

  it('14. permissions and company isolation still apply', async () => {
    const a = await setup('iso-a'); const b = await setup('iso-b');
    await svc().create(a.co, a.fy, a.owner.id);
    expect((await b.owner.client.req('POST', `/annual-closing/${a.fy}/package/finalize`, { version: 1 })).status).toBe(404);
    const viewer = await h.user('iso-viewer');
    await h.member(a.co, viewer.id, ['annual_close.package.view']);
    await viewer.client.login();
    expect((await viewer.client.req('POST', `/annual-closing/${a.fy}/package/finalize`, { version: 1 })).status).toBe(403);
    expect((await b.owner.client.req('GET', `/annual-closing/${a.fy}/package`)).status).toBe(404);
    expect((await svc().get(a.co, a.fy)).package.status).toBe('draft');
  });

  it('15. a closed fiscal year cannot receive postings even when the monthly period is reopened', async () => {
    const t = await setup('post');
    await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2025-05-01','2025-05-31','open')", [t.co, t.fy]);
    const j = (await h.q<{ id: string }>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,entry_type,created_by) VALUES($1,$2,'2025-05-10','draft','standard',$3) RETURNING id", [t.co, t.fy, t.owner.id]))[0]!.id;
    await h.q('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,10,0,1),($1,$2,$4,0,10,2)', [t.co, j, t.exp, t.bank]);
    const c = await h.db.connect();
    try {
      await c.query('BEGIN');
      await expect(posting.postJournalInTransaction(c, t.co, t.owner.id, j)).rejects.toBeInstanceOf(posting.FiscalYearClosedError);
    } finally { await c.query('ROLLBACK'); c.release(); }
    expect((await h.q<{ status: string }>('SELECT status FROM journal_entries WHERE id=$1', [j]))[0]!.status).toBe('draft');
  });

  it('17+16. a final snapshot is immutable and a rejected review after drift writes no success audit', async () => {
    const t = await setup('imm');
    await svc().create(t.co, t.fy, t.owner.id);
    await svc().finalize(t.co, t.fy, t.owner.id, 1);
    await svc().handoff(t.co, t.fy, t.owner.id, { version: 2, note: null, reference: null });
    await expect(h.q("UPDATE annual_closing_package_snapshots SET source_fingerprint='v2:tampered' WHERE company_id=$1", [t.co])).rejects.toThrow(/immutable/);
    // V2 drift from a ledger amount change blocks professional acceptance.
    await h.postedJournal(t.co, t.fy, '2025-06-01', t.owner.id, [[t.exp, '7.00', '0'], [t.bank, '0', '7.00']]);
    expect((await svc().get(t.co, t.fy)).drift).toBe(true);
    await expect(svc().review(t.co, t.fy, t.owner.id, { version: 3, note: null })).rejects.toBeInstanceOf(Svc.AnnualPackageConflictError);
    expect(await auditCount(t.co, 'annual_package.reviewed')).toBe(0);
    expect((await svc().get(t.co, t.fy)).package.status).toBe('handed_off');
  });
});

const randomId = () => '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0');
