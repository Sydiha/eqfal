import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const YEAR = '33333333-3333-4333-8333-333333333333';
const SOURCE = '44444444-4444-4444-8444-444444444444';
const OTHER_SOURCE = '55555555-5555-4555-8555-555555555555';
const REVIEW = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';

const mocks = vi.hoisted(() => ({ context: null as null | { user: { id: string }; activeCompanyId: string | null; capabilities: string[] }, pool: null as unknown, audit: vi.fn() }));
vi.mock('../src/db/pool', () => ({ get default() { return mocks.pool; } }));
vi.mock('../src/modules/audit-log/audit-log.repository', () => ({ AuditLogRepository: class { logEvent = (event: unknown, client: unknown) => mocks.audit(event, client); } }));
vi.mock('../src/modules/auth/origin.middleware', () => ({ requireSameOrigin: (_request: Request, _response: Response, next: NextFunction) => next() }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: () => mocks.context,
  requireAuth: (_request: Request, response: Response, next: NextFunction) => mocks.context ? next() : response.status(401).end(),
  requireActiveCompany: (_request: Request, response: Response, next: NextFunction) => mocks.context?.activeCompanyId ? next() : response.status(403).end(),
  requireCapability: (capability: string) => (_request: Request, response: Response, next: NextFunction) => mocks.context?.capabilities.includes(capability) ? next() : response.status(403).end(),
}));

const { whtReviewRouter } = await import('../src/modules/wht-reviews/wht-review.router');
const { WhtReviewConflictError, WhtReviewService, WhtReviewValidationError } = await import('../src/modules/wht-reviews/wht-review.service');
const app = express();
app.use(express.json());
app.use('/api', whtReviewRouter);
app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => response.status(500).end());

type Row = Record<string, unknown> & { id: string; company_id: string; fiscal_year_id: string; source_type: string; source_id: string; workflow_status: string; assessment_result: string | null; reviewer_note: string | null; professional_review_required: boolean; version: number };
const initial = (): Row => ({ id: REVIEW, company_id: COMPANY, fiscal_year_id: YEAR, source_type: 'document', source_id: SOURCE, counterparty_id: null, non_resident_assessment: 'unknown', payment_service_category: 'Services', basis_reference: 'Contract', reviewer_note: null, professional_review_required: true, workflow_status: 'needs_review', assessment_result: null, reviewed_by_user_id: null, reviewed_at: null, version: 1 });

function database(seed: Row[] = []) {
  const rows = seed.map(row => ({ ...row }));
  const sql: string[] = [];
  const query = async (statement: string, values: unknown[] = []) => {
    const normalized = statement.replace(/\s+/g, ' ').trim(); sql.push(normalized);
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) return { rows: [], rowCount: 0 };
    if (normalized.startsWith('SELECT r.*')) return { rows: rows.filter(row => row.company_id === values[0] && row.fiscal_year_id === values[1]), rowCount: rows.length };
    if (normalized.startsWith('SELECT 1 FROM fiscal_years')) return { rows: values[1] === COMPANY && values[0] === YEAR ? [{ one: 1 }] : [], rowCount: values[1] === COMPANY && values[0] === YEAR ? 1 : 0 };
    if (/^SELECT 1 FROM (documents|obligations|bank_transactions)/.test(normalized)) { const found = values[1] === COMPANY && values[0] === SOURCE; return { rows: found ? [{ one: 1 }] : [], rowCount: found ? 1 : 0 }; }
    if (normalized.startsWith('SELECT 1 FROM counterparties')) return { rows: [], rowCount: 0 };
    if (normalized.startsWith('SELECT * FROM wht_reviews')) { const row = rows.find(item => item.id === values[0] && item.company_id === values[1] && item.fiscal_year_id === values[2]); return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }; }
    if (normalized.startsWith('INSERT INTO wht_reviews')) {
      const row = { ...initial(), source_type: String(values[3]), source_id: String(values[4]), counterparty_id: values[5], non_resident_assessment: values[6], payment_service_category: values[7], basis_reference: values[8], reviewer_note: values[9], professional_review_required: Boolean(values[10]) } as Row;
      rows.push(row); return { rows: [{ ...row }], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE wht_reviews')) {
      const version = Number(values.at(-1)); const id = String(values.at(-4)); const company = String(values.at(-3)); const year = String(values.at(-2));
      const row = rows.find(item => item.id === id && item.company_id === company && item.fiscal_year_id === year && item.version === version);
      if (!row) return { rows: [], rowCount: 0 };
      if (normalized.includes('workflow_status=$1')) {
        row.workflow_status = String(values[0]); row.assessment_result = values[1] as string | null; row.reviewer_note = (values[2] ?? row.reviewer_note) as string | null;
        row.professional_review_required = Boolean(values[3]); row.reviewed_by_user_id = values[4]; row.reviewed_at = values[5];
      } else {
        const assignments = normalized.slice(normalized.indexOf(' SET ') + 5, normalized.indexOf(',version=')).split(',');
        assignments.forEach((assignment, index) => { const key = assignment.split('=')[0]!; row[key] = values[index]; });
        if (normalized.includes("workflow_status='needs_review'")) { row.workflow_status = 'needs_review'; row.assessment_result = null; row.reviewed_by_user_id = null; row.reviewed_at = null; }
      }
      row.version += 1; return { rows: [{ ...row }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };
  const client = { query, release: vi.fn() };
  return { rows, sql, query: vi.fn(query), connect: vi.fn(async () => client) };
}

const values = { source_type: 'document' as const, source_id: SOURCE, non_resident_assessment: 'unknown' as const, payment_service_category: 'Services', basis_reference: 'Contract', professional_review_required: true };
const setContext = (capabilities: string[]) => { mocks.context = { user: { id: USER }, activeCompanyId: COMPANY, capabilities }; };

beforeEach(() => { mocks.context = null; mocks.audit.mockReset(); mocks.pool = database(); });

describe('WHT review API authorization and validation', () => {
  const endpoints = {
    view: () => request(app).get(`/api/wht-reviews/${YEAR}`),
    create: () => request(app).post(`/api/wht-reviews/${YEAR}`).send(values),
    edit: () => request(app).patch(`/api/wht-reviews/${YEAR}/${REVIEW}`).send({ version: 1, basis_reference: 'Updated' }),
    submit: () => request(app).post(`/api/wht-reviews/${YEAR}/${REVIEW}/submit`).send({ version: 1 }),
    review: () => request(app).post(`/api/wht-reviews/${YEAR}/${REVIEW}/review`).send({ version: 1, result: 'applicable' }),
  };
  const mapping = { view: 'wht_review.view', create: 'wht_review.create', edit: 'wht_review.edit', submit: 'wht_review.submit', review: 'wht_review.review' } as const;

  it.each(Object.entries(mapping))('%s requires its dedicated capability', async (name, capability) => {
    setContext([]); expect((await endpoints[name as keyof typeof endpoints]()).status).toBe(403);
    setContext([capability]); expect((await endpoints[name as keyof typeof endpoints]()).status).not.toBe(403);
  });

  it.each([
    {}, { version: 1 }, { version: 1, unexpected: true }, { version: 1, basis_reference: '' },
    { version: 1, professional_review_required: 'yes' }, { version: 1, source_id: 'not-a-uuid' },
  ])('rejects an invalid or empty partial PATCH: %j', async body => {
    const db = database([initial()]); mocks.pool = db; setContext(['wht_review.edit']);
    expect((await request(app).patch(`/api/wht-reviews/${YEAR}/${REVIEW}`).send(body)).status).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('accepts and validates only the supplied PATCH fields', async () => {
    mocks.pool = database([initial()]); setContext(['wht_review.edit']);
    expect((await request(app).patch(`/api/wht-reviews/${YEAR}/${REVIEW}`).send({ version: 1, reviewer_note: 'Evidence checked' })).status).toBe(200);
  });
});

describe('WHT review tenant and lifecycle protections', () => {
  it('scopes reads by both company and fiscal year', async () => {
    const other = { ...initial(), id: OTHER_SOURCE, company_id: OTHER_COMPANY };
    const db = database([initial(), other]);
    const result = await new WhtReviewService(db as unknown as Pool).list(COMPANY, YEAR);
    expect(result).toHaveLength(1); expect(result[0]?.company_id).toBe(COMPANY);
    expect(db.sql[0]).toContain('r.company_id=$1 AND r.fiscal_year_id=$2');
  });

  it('rejects cross-company sources and counterparties', async () => {
    const db = database(); const service = new WhtReviewService(db as unknown as Pool);
    await expect(service.create(COMPANY, YEAR, USER, { ...values, source_id: OTHER_SOURCE })).rejects.toBeInstanceOf(WhtReviewValidationError);
    await expect(service.create(COMPANY, YEAR, USER, { ...values, counterparty_id: OTHER_SOURCE })).rejects.toBeInstanceOf(WhtReviewValidationError);
  });

  it('enforces optimistic concurrency across edits and transitions', async () => {
    const db = database([initial()]); const service = new WhtReviewService(db as unknown as Pool);
    await service.update(COMPANY, YEAR, REVIEW, USER, { version: 1, basis_reference: 'Changed' });
    await expect(service.update(COMPANY, YEAR, REVIEW, USER, { version: 1, reviewer_note: 'stale' })).rejects.toBeInstanceOf(WhtReviewConflictError);
    await expect(service.transition(COMPANY, YEAR, REVIEW, USER, 1, 'submit')).rejects.toBeInstanceOf(WhtReviewConflictError);
  });

  it('supports create, edit, submit, and review with transactional audit events', async () => {
    const db = database(); const service = new WhtReviewService(db as unknown as Pool);
    const created = await service.create(COMPANY, YEAR, USER, values);
    const edited = await service.update(COMPANY, YEAR, created.id, USER, { version: created.version, basis_reference: 'Updated contract' });
    const submitted = await service.transition(COMPANY, YEAR, created.id, USER, edited.version, 'submit');
    const reviewed = await service.transition(COMPANY, YEAR, created.id, USER, submitted.version, 'review', 'not_applicable', 'Reviewed evidence');
    expect(reviewed).toMatchObject({ workflow_status: 'reviewed', assessment_result: 'not_applicable', professional_review_required: false });
    expect(mocks.audit.mock.calls.map(call => (call[0] as { action: string }).action)).toEqual(['wht_review.created', 'wht_review.materially_changed', 'wht_review.submit', 'wht_review.review']);
    expect(db.sql.filter(statement => statement === 'COMMIT')).toHaveLength(4);
  });

  it('preserves review for a note-only edit but invalidates review after a material edit', async () => {
    const reviewed = { ...initial(), workflow_status: 'reviewed', assessment_result: 'applicable', professional_review_required: false, reviewed_by_user_id: USER, reviewed_at: new Date(), version: 4 };
    const db = database([reviewed]); const service = new WhtReviewService(db as unknown as Pool);
    const noted = await service.update(COMPANY, YEAR, REVIEW, USER, { version: 4, reviewer_note: 'Clarified' });
    expect(noted).toMatchObject({ workflow_status: 'reviewed', assessment_result: 'applicable' });
    const changed = await service.update(COMPANY, YEAR, REVIEW, USER, { version: 5, payment_service_category: 'Royalties' });
    expect(changed).toMatchObject({ workflow_status: 'needs_review', assessment_result: null, reviewed_by_user_id: null, reviewed_at: null });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'wht_review.materially_changed' }), expect.anything());
  });

  it('contains no automatic rate, liability, treaty, filing, or posting behavior', () => {
    const source = readFileSync(new URL('../src/modules/wht-reviews/wht-review.service.ts', import.meta.url), 'utf8');
    for (const prohibited of ['tax_rate', 'withholding_rate', 'tax_liability', 'treaty_outcome', 'filing_status', 'journal_entries']) expect(source).not.toContain(prohibited);
  });
});
