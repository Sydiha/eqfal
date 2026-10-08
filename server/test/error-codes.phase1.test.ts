import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pool: { connect: vi.fn(), query: vi.fn() } as null | { connect: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> },
  login: vi.fn(),
  getContext: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({
  get default() { return mocks.pool; },
}));
vi.mock('../src/modules/auth/session.service', async (orig) => ({
  ...(await orig<typeof import('../src/modules/auth/session.service')>()),
  SessionService: class { login = mocks.login; getContext = mocks.getContext; },
}));

import { authRouter, SESSION_COOKIE } from '../src/modules/auth/auth.router';
import { requireActiveCompany, requireAuth } from '../src/modules/auth/auth.middleware';
import { requireSameOrigin } from '../src/modules/auth/origin.middleware';
import { openingBalancesRouter } from '../src/modules/opening-balances/opening-balances.router';

const app = express();
app.use(express.json());
app.use('/api', authRouter);
app.get('/api/needs-company', requireAuth, requireActiveCompany, (_q, res) => { res.json({ ok: true }); });
app.post('/api/origin-check', requireSameOrigin, (_q, res) => { res.json({ ok: true }); });

describe('Phase 1 auth/runtime error codes', () => {
  beforeEach(() => {
    mocks.login.mockReset();
    mocks.pool = { connect: vi.fn(), query: vi.fn() };
  });

  it('returns INVALID_CREDENTIALS (401) for a wrong login', async () => {
    mocks.login.mockResolvedValue(null);
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: 'bad' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
  });

  it('returns INVALID_LOGIN_REQUEST (400) for a malformed login', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: '', password: '' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid login request', code: 'INVALID_LOGIN_REQUEST' });
  });

  it('returns DB_UNAVAILABLE (503) when the database is not configured', async () => {
    mocks.pool = null;
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: 'x' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
    const guarded = await request(app).get('/api/needs-company');
    expect(guarded.status).toBe(503);
    expect(guarded.body.code).toBe('DB_UNAVAILABLE');
  });

  it('returns INVALID_REQUEST_ORIGIN (403) for a cross-origin mutation', async () => {
    const res = await request(app).post('/api/origin-check').set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Invalid request origin', code: 'INVALID_REQUEST_ORIGIN' });
  });

  it('returns NO_ACTIVE_COMPANY (403) from the shared middleware', async () => {
    mocks.getContext.mockResolvedValue({ user: { id: 'u1' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] });
    const res = await request(app).get('/api/needs-company').set('Cookie', `${SESSION_COOKIE}=tok`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'No active company', code: 'NO_ACTIVE_COMPANY' });
  });
});

describe('Phase 1 ACCOUNTING_PERIOD_CLOSED stays consistent', () => {
  it('opening-balance approve into a closed month returns the stable period code', async () => {
    const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });
    const client = {
      release: vi.fn(),
      async query(sql: string) {
        if (sql.includes('FROM fiscal_years') && sql.includes('FOR SHARE')) {
          return rows([{ start_date: '2025-01-01', end_date: '2025-12-31', status: 'open' }]);
        }
        if (sql.includes('monthly_close_periods')) return rows([{ '?column?': 1 }]);
        if (sql.includes('FROM fiscal_years WHERE id=$1 AND company_id=$2')) {
          return rows([{ id: 'fy', start_date: '2025-01-01', end_date: '2025-12-31' }]);
        }
        if (sql.includes('FROM opening_balance_reviews')) return rows([{ id: 'r1', status: 'in_review', journal_entry_id: null }]);
        if (sql.includes('FROM opening_balance_items')) {
          return rows([
            { account_id: 'a1', account_code: '1000', debit: '100.00', credit: '0.00' },
            { account_id: 'a2', account_code: '3000', debit: '0.00', credit: '100.00' },
          ]);
        }
        return rows([]);
      },
    };
    mocks.pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
    const ob = express();
    ob.use(express.json());
    ob.use('/api', openingBalancesRouter);
    mocks.getContext.mockResolvedValue({
      user: { id: 'u1' }, allowedCompanies: [], activeCompanyId: 'co-a',
      capabilities: ['opening_balance.approve', 'opening_balance.view', 'opening_balance.edit', 'opening_balance.post'],
    });
    const res = await request(ob)
      .post('/api/opening-balances/11111111-1111-4111-8111-111111111111/approve')
      .set('Cookie', `${SESSION_COOKIE}=tok`)
      .set('Sec-Fetch-Site', 'same-origin')
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACCOUNTING_PERIOD_CLOSED');
  });
});
