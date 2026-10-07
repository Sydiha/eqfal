import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as null | {
    user: { id: string; email: string };
    allowedCompanies: { id: string; name: string; name_ar: string | null }[];
    activeCompanyId: string | null;
    capabilities: string[];
  },
  findByCompany: vi.fn(),
  createFiscalYear: vi.fn(),
  updateFiscalYear: vi.fn(),
  closeFiscalYear: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({
  default: { query: vi.fn(), connect: vi.fn() },
}));

vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => mocks.context),
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (!mocks.context) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    next();
  },
  requireActiveCompany: (req: Request, res: Response, next: NextFunction) => {
    if (!mocks.context?.activeCompanyId) {
      res.status(403).json({ error: 'No active company' });
      return;
    }
    next();
  },
  requireCapability: (capability: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      if (!mocks.context?.capabilities.includes(capability)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      next();
    },
}));

vi.mock('../src/modules/fiscal-years/fiscal-year.repository', () => ({
  FiscalYearRepository: class {
    findByCompany = mocks.findByCompany;
  },
}));

vi.mock('../src/modules/fiscal-years/fiscal-year.service', () => ({
  FiscalYearService: class {
    createFiscalYear = mocks.createFiscalYear;
    updateFiscalYear = mocks.updateFiscalYear;
    closeFiscalYear = mocks.closeFiscalYear;
  },
}));

import { FiscalYearConflictError } from '../src/modules/fiscal-years/fiscal-year-errors';
import { fiscalYearRouter } from '../src/modules/fiscal-years/fiscal-year.router';

const app = express();
app.use(express.json());
app.use('/api', fiscalYearRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : 'error' });
});

function setContext(capabilities: string[], companyId: string | null = 'co-a') {
  mocks.context = {
    user: { id: 'user-1', email: 'user@example.com' },
    allowedCompanies: [
      { id: 'co-a', name: 'Alpha', name_ar: null },
      { id: 'co-b', name: 'Beta', name_ar: null },
    ],
    activeCompanyId: companyId,
    capabilities,
  };
}

const fiscalYear = {
  id: 'fy-1',
  company_id: 'co-a',
  name: 'FY 2026',
  start_date: '2026-01-01',
  end_date: '2027-01-01',
  status: 'open',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

describe('Fiscal Year API tenant and capability boundary', () => {
  beforeEach(() => {
    mocks.context = null;
    mocks.findByCompany.mockReset();
    mocks.createFiscalYear.mockReset();
    mocks.updateFiscalYear.mockReset();
    mocks.closeFiscalYear.mockReset();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/fiscal-years');
    expect(res.status).toBe(401);
    expect(mocks.findByCompany).not.toHaveBeenCalled();
  });

  it('requires an active company', async () => {
    setContext(['fiscal_year.view'], null);
    const res = await request(app).get('/api/fiscal-years');
    expect(res.status).toBe(403);
    expect(mocks.findByCompany).not.toHaveBeenCalled();
  });

  it('requires fiscal_year.view for list access', async () => {
    setContext([]);
    const res = await request(app).get('/api/fiscal-years');
    expect(res.status).toBe(403);
  });

  it('lists fiscal years only for the active company from session context', async () => {
    setContext(['fiscal_year.view']);
    mocks.findByCompany.mockResolvedValue([fiscalYear]);

    const res = await request(app).get('/api/fiscal-years');

    expect(res.status).toBe(200);
    expect(mocks.findByCompany).toHaveBeenCalledWith('co-a');
    expect(res.body.fiscalYears).toHaveLength(1);
  });

  it('uses the newly active company on the next request', async () => {
    setContext(['fiscal_year.view'], 'co-a');
    mocks.findByCompany.mockResolvedValue([]);
    await request(app).get('/api/fiscal-years');

    setContext(['fiscal_year.view'], 'co-b');
    await request(app).get('/api/fiscal-years');

    expect(mocks.findByCompany.mock.calls).toEqual([['co-a'], ['co-b']]);
  });

  it('keeps create, edit, and close on independent capability boundaries', async () => {
    setContext(['fiscal_year.create']);
    mocks.createFiscalYear.mockResolvedValue(fiscalYear);
    const create = await request(app)
      .post('/api/fiscal-years')
      .send({ name: 'FY 2026', start_date: '2026-01-01', end_date: '2027-01-01' });
    const edit = await request(app).patch('/api/fiscal-years/fy-1').send({ name: 'Updated' });
    const close = await request(app).post('/api/fiscal-years/fy-1/close').send({});

    expect(create.status).toBe(201);
    expect(edit.status).toBe(403);
    expect(close.status).toBe(403);
  });

  it('does not accept legacy fiscal_year.manage for any mutation', async () => {
    setContext(['fiscal_year.manage']);
    expect((await request(app).post('/api/fiscal-years').send({ name: 'FY 2026', start_date: '2026-01-01', end_date: '2027-01-01' })).status).toBe(403);
    expect((await request(app).patch('/api/fiscal-years/fy-1').send({ name: 'Updated' })).status).toBe(403);
    expect((await request(app).post('/api/fiscal-years/fy-1/close').send({})).status).toBe(403);
  });

  it('rejects cross-origin create, update, and close before any mutation runs', async () => {
    setContext(['fiscal_year.create', 'fiscal_year.edit', 'fiscal_year.close']);

    const create = await request(app)
      .post('/api/fiscal-years')
      .set('Origin', 'https://evil.example')
      .send({ name: 'FY 2026', start_date: '2026-01-01', end_date: '2027-01-01' });
    const update = await request(app)
      .patch('/api/fiscal-years/fy-1')
      .set('Origin', 'https://evil.example')
      .send({ name: 'Updated' });
    const close = await request(app)
      .post('/api/fiscal-years/fy-1/close')
      .set('Origin', 'https://evil.example')
      .send({});

    expect(create.status).toBe(403);
    expect(update.status).toBe(403);
    expect(close.status).toBe(403);
    expect(mocks.createFiscalYear).not.toHaveBeenCalled();
    expect(mocks.updateFiscalYear).not.toHaveBeenCalled();
    expect(mocks.closeFiscalYear).not.toHaveBeenCalled();
  });

  it('rejects client-supplied company_id instead of trusting it', async () => {
    setContext(['fiscal_year.create']);
    const res = await request(app)
      .post('/api/fiscal-years')
      .send({
        company_id: 'co-b',
        name: 'FY 2026',
        start_date: '2026-01-01',
        end_date: '2027-01-01',
      });

    expect(res.status).toBe(400);
    expect(mocks.createFiscalYear).not.toHaveBeenCalled();
  });

  it('creates using active company and authenticated actor only', async () => {
    setContext(['fiscal_year.create']);
    mocks.createFiscalYear.mockResolvedValue(fiscalYear);

    const res = await request(app)
      .post('/api/fiscal-years')
      .send({ name: ' FY 2026 ', start_date: '2026-01-01', end_date: '2027-01-01' });

    expect(res.status).toBe(201);
    expect(mocks.createFiscalYear).toHaveBeenCalledWith(
      {
        company_id: 'co-a',
        name: 'FY 2026',
        start_date: '2026-01-01',
        end_date: '2027-01-01',
      },
      'user-1',
    );
  });

  it('rejects invalid dates and unknown fields at the HTTP boundary', async () => {
    setContext(['fiscal_year.create', 'fiscal_year.edit']);

    const invalidDate = await request(app)
      .post('/api/fiscal-years')
      .send({ name: 'FY', start_date: '2026-02-31', end_date: '2027-01-01' });
    const unknownField = await request(app)
      .patch('/api/fiscal-years/fy-1')
      .send({ status: 'closed' });

    expect(invalidDate.status).toBe(400);
    expect(unknownField.status).toBe(400);
  });

  it('maps cross-company/not-found updates to the same 404', async () => {
    setContext(['fiscal_year.edit']);
    mocks.updateFiscalYear.mockRejectedValue(new Error('Fiscal year not found or access denied'));

    const res = await request(app)
      .patch('/api/fiscal-years/fy-other')
      .send({ name: 'Updated' });

    expect(res.status).toBe(404);
    expect(mocks.updateFiscalYear).toHaveBeenCalledWith(
      'fy-other',
      'co-a',
      { name: 'Updated' },
      'user-1',
    );
  });

  it('maps overlap and closed-state domain errors to 409', async () => {
    setContext(['fiscal_year.create']);
    mocks.createFiscalYear.mockRejectedValue(
      new FiscalYearConflictError('FISCAL_YEAR_OVERLAP', 'x'),
    );

    const res = await request(app)
      .post('/api/fiscal-years')
      .send({ name: 'FY 2026', start_date: '2026-01-01', end_date: '2027-01-01' });

    expect(res.status).toBe(409);
  });

  it('maps a blocked close to 409 with structured blockers and warnings', async () => {
    setContext(['fiscal_year.close']);
    const { FiscalYearCloseBlockedError } = await import('../src/modules/fiscal-years/fiscal-year-close-readiness');
    mocks.closeFiscalYear.mockRejectedValue(
      new FiscalYearCloseBlockedError([{ code: 'draft_journals', count: 1 }], [{ code: 'zakat_tax_workpaper_not_ready', count: 1 }]),
    );

    const res = await request(app)
      .post('/api/fiscal-years/fy-1/close')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FISCAL_YEAR_CLOSE_BLOCKED');
    expect(res.body.blockers).toEqual([{ code: 'draft_journals', count: 1 }]);
    expect(res.body.warnings).toEqual([{ code: 'zakat_tax_workpaper_not_ready', count: 1 }]);
  });

  it('returns stable codes for overlap, already-closed and immutable-closed fiscal years', async () => {
    setContext(['fiscal_year.create', 'fiscal_year.close', 'fiscal_year.edit']);
    mocks.createFiscalYear.mockRejectedValue(new FiscalYearConflictError('FISCAL_YEAR_OVERLAP', 'any text'));
    const overlap = await request(app)
      .post('/api/fiscal-years')
      .send({ name: 'FY 2026', start_date: '2026-01-01', end_date: '2027-01-01' });
    expect(overlap.status).toBe(409);
    expect(overlap.body).toEqual({ error: 'Fiscal year state conflict', code: 'FISCAL_YEAR_OVERLAP' });

    mocks.closeFiscalYear.mockRejectedValue(new FiscalYearConflictError('FISCAL_YEAR_ALREADY_CLOSED', 'any text'));
    const closed = await request(app).post('/api/fiscal-years/fy-1/close').send({});
    expect(closed.status).toBe(409);
    expect(closed.body).toEqual({ error: 'Fiscal year state conflict', code: 'FISCAL_YEAR_ALREADY_CLOSED' });

    mocks.updateFiscalYear.mockRejectedValue(new FiscalYearConflictError('FISCAL_YEAR_CLOSED_IMMUTABLE', 'any text'));
    const immutable = await request(app).patch('/api/fiscal-years/fy-1').send({ name: 'X' });
    expect(immutable.status).toBe(409);
    expect(immutable.body).toEqual({ error: 'Fiscal year state conflict', code: 'FISCAL_YEAR_CLOSED_IMMUTABLE' });
  });

  it('closes inside active company and forwards the authenticated actor and reason', async () => {
    setContext(['fiscal_year.close']);
    mocks.closeFiscalYear.mockResolvedValue({ ...fiscalYear, status: 'closed' });

    const res = await request(app)
      .post('/api/fiscal-years/fy-1/close')
      .send({ reason: 'Year-end approved' });

    expect(res.status).toBe(200);
    expect(mocks.closeFiscalYear).toHaveBeenCalledWith(
      'fy-1',
      'co-a',
      'user-1',
      'Year-end approved',
    );
  });
});
