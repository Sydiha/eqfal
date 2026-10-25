import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { HistoricalRecordsService, provenanceOf } from '../src/modules/historical-records/historical-records.service';

// C5-P3 static contract: capability wiring, no accounting reach, and service-level capability checks that run without a database.
const dir = path.resolve(__dirname, '../src/modules/historical-records');
const router = readFileSync(path.join(dir, 'historical-records.router.ts'), 'utf8');
const service = readFileSync(path.join(dir, 'historical-records.service.ts'), 'utf8');
const app = readFileSync(path.resolve(__dirname, '../src/app.ts'), 'utf8');

describe('historical records router (static)', () => {
  it('is mounted and every route sits behind a capability guard', () => {
    expect(app).toContain("app.use('/api', historicalRecordsRouter)");
    const routes = router.match(/historicalRecordsRouter\.(get|post|patch|delete)\(/g) ?? [];
    expect(routes).toHaveLength(18);
    expect(router.match(/\.\.\.VIEW/g)).toHaveLength(6);
    expect(router.match(/\.\.\.WRITE/g)).toHaveLength(10);
    expect(router.match(/\.\.\.APPROVE/g)).toHaveLength(2);
    expect(router).toMatch(/WRITE = \[requireSameOrigin, requireAuth, requireActiveCompany, requireCapability\('historical\.manage'\)\]/);
    expect(router).toMatch(/APPROVE = \[requireSameOrigin, requireAuth, requireActiveCompany, requireCapability\('historical\.approve'\)\]/);
  });
  it('takes the company only from the authenticated session', () => {
    expect(router).toContain('ctx.activeCompanyId!');
    expect(router).not.toMatch(/req\.(body|query|params)\[?\.?'?company/);
  });
});

describe('historical records service (static)', () => {
  it('never touches the ledger, opening balances, fiscal years or closing tables', () => {
    expect(service).not.toMatch(/journal_entries|journal_lines|opening_balance|fiscal_years|monthly_close|annual_closing|ledger_source_authority|accounts\b/);
  });
  it('writes an audit event through the transaction client for every mutation', () => {
    expect(service.match(/this\.log\(client/g)?.length).toBeGreaterThanOrEqual(12);
    expect(service).not.toMatch(/this\.pool\.query\(\s*`(INSERT|UPDATE|DELETE)/);
  });
});

describe('historical records service (no database)', () => {
  const pool = { connect: vi.fn(), query: vi.fn() };
  const svc = new HistoricalRecordsService(pool as never);
  const actor = (capabilities: string[]) => ({ userId: 'u', companyId: 'c', capabilities });
  it('re-checks capabilities before touching the database', async () => {
    await expect(svc.listPeriods(actor([]))).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(svc.createPeriod(actor(['historical.view']), {})).rejects.toMatchObject({ status: 403 });
    await expect(svc.review(actor(['historical.manage']), 'x', {})).rejects.toMatchObject({ status: 403 });
    await expect(svc.reopenReconstruction(actor(['historical.manage']), 'x', {})).rejects.toMatchObject({ status: 403 });
    await expect(svc.seal(actor(['historical.view']), 'x')).rejects.toMatchObject({ status: 403 });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
  it('rejects malformed input before opening a transaction', async () => {
    const a = actor(['historical.manage']);
    await expect(svc.createPeriod(a, { label: 'x', period_start: '2020-02-30', period_end: '2020-12-31', completeness: 'complete', reason: 'r', company_id: 'other' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.createPeriod(a, { label: 'x', period_start: '2020-02-01', period_end: '2020-12-31', completeness: 'maybe', reason: 'r' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.createPeriod(a, { label: 'x', period_start: '2020-02-01', period_end: '2020-12-31', completeness: 'complete', reason: '  ' })).rejects.toMatchObject({ status: 400 });
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('labels what kind of information a record is', () => {
    expect(provenanceOf({ kind: 'official', proof_level: 'proof_attached', internal_purpose: null })).toBe('official_submitted_with_proof');
    expect(provenanceOf({ kind: 'official', proof_level: 'declared_unverified', internal_purpose: null })).toBe('official_declared_unverified');
    expect(provenanceOf({ kind: 'internal', proof_level: null, internal_purpose: 'reconstruction' })).toBe('internal_reconstruction');
    expect(provenanceOf({ kind: 'internal', proof_level: null, internal_purpose: 'correction' })).toBe('internal_correction');
  });
});
