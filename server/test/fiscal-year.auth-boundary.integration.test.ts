import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const mocks = vi.hoisted(() => ({
  findByCompany: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({
  default: { query: vi.fn(), connect: vi.fn() } as unknown as Pool,
}));

vi.mock('../src/modules/fiscal-years/fiscal-year.repository', () => ({
  FiscalYearRepository: class {
    findByCompany = mocks.findByCompany;
  },
}));

import { fiscalYearRouter } from '../src/modules/fiscal-years/fiscal-year.router';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const app = express();
app.use(express.json());
app.use('/api', fiscalYearRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : 'error' });
});

const activeSession = {
  id: 'session-1',
  user_id: 'user-1',
  user_email: 'user@example.com',
  token_hash: 'hash',
  active_company_id: 'co-a',
  expires_at: new Date(Date.now() + 60_000),
  created_at: new Date(),
  updated_at: new Date(),
};

const memberships = [
  {
    membership_id: 'membership-1',
    company_id: 'co-a',
    company_name: 'Alpha',
    company_name_ar: null,
    role_id: 'role-1',
  },
];

function getFiscalYears() {
  return request(app)
    .get('/api/fiscal-years')
    .set('Cookie', 'eqfal_session=opaque-token');
}

describe('Fiscal Year composed auth/session boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.findByCompany.mockReset().mockResolvedValue([]);
  });

  it('returns 401 when the server-side session is invalid or expired', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);

    const res = await getFiscalYears();

    expect(res.status).toBe(401);
    expect(mocks.findByCompany).not.toHaveBeenCalled();
  });

  it('removes tenant access on the next request when the active membership/company is no longer allowed', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(activeSession);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([]);
    const reconcile = vi.spyOn(SessionRepository.prototype, 'updateActiveCompany').mockResolvedValue();

    const res = await getFiscalYears();

    expect(res.status).toBe(403);
    expect(reconcile).toHaveBeenCalledWith('session-1', null);
    expect(mocks.findByCompany).not.toHaveBeenCalled();
  });

  it('returns 403 on the next request when the required capability has been revoked', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(activeSession);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(memberships);
    vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue([]);

    const res = await getFiscalYears();

    expect(res.status).toBe(403);
    expect(mocks.findByCompany).not.toHaveBeenCalled();
  });

  it('passes the server-trusted active company to the fiscal-year repository when access remains valid', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(activeSession);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(memberships);
    vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(['fiscal_year.view']);

    const res = await getFiscalYears();

    expect(res.status).toBe(200);
    expect(mocks.findByCompany).toHaveBeenCalledWith('co-a');
  });
});
