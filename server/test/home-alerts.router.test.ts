import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const mocks = vi.hoisted(() => ({ context: null as any, pool: null as any }));
vi.mock('../src/db/pool', () => ({ get default() { return mocks.pool; } }));
vi.mock('../src/operational-date', () => ({ operationalDate: () => '2026-09-17' }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: () => mocks.context,
  requireAuth: (_req: Request, res: Response, next: NextFunction) => mocks.context ? next() : res.status(401).end(),
  requireActiveCompany: (_req: Request, res: Response, next: NextFunction) => mocks.context?.activeCompanyId ? next() : res.status(403).end(),
}));

const { homeAlertsRouter } = await import('../src/modules/home-alerts/home-alerts.router');
const app = express();
app.use('/api', homeAlertsRouter);
app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).end());

describe('home alerts', () => {
  beforeEach(() => { mocks.context = null; mocks.pool = null; });

  it('queries only authorized modules, scopes every query to the active company, and uses the operational date', async () => {
    const query = vi.fn(async (sql: string, args: unknown[]) => {
      expect(args[0]).toBe(COMPANY);
      if (sql.includes('WITH remaining')) {
        expect(args).toEqual([COMPANY, '2026-09-17', '2026-10-17']);
        return { rows: [{ overdue: '2', upcoming: '3', unconfirmed: '1' }] };
      }
      throw new Error(`Unauthorized query: ${sql}`);
    });
    mocks.pool = { query };
    mocks.context = { activeCompanyId: COMPANY, capabilities: ['obligation.view'], user: { id: 'user' } };

    const response = await request(app).get('/api/home-alerts');
    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledOnce();
    expect(response.body).toEqual({
      as_of: '2026-09-17',
      alerts: [
        expect.objectContaining({ key: 'overdue_obligations', count: 2, parameters: { overdue: '1' } }),
        expect.objectContaining({ key: 'upcoming_obligations', count: 3, parameters: { dueFrom: '2026-09-17', dueTo: '2026-10-17' } }),
        expect.objectContaining({ key: 'unconfirmed_obligations', count: 1, parameters: { confirmation: 'unconfirmed' } }),
      ],
    });
  });

  it('returns no module counts and performs no data queries when no view capability is present', async () => {
    const query = vi.fn();
    mocks.pool = { query };
    mocks.context = { activeCompanyId: COMPANY, capabilities: [], user: { id: 'user' } };
    const response = await request(app).get('/api/home-alerts');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ as_of: '2026-09-17', alerts: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps document and bank aggregates separate and tenant scoped', async () => {
    const query = vi.fn(async (sql: string, args: unknown[]) => {
      expect(args).toEqual([COMPANY]);
      if (sql.includes('FROM documents')) return { rows: [{ status: 'needs_review', count: '4' }] };
      if (sql.includes('FROM bank_transactions')) return { rows: [{ reconciliation_status: 'unmatched', count: '5' }] };
      throw new Error(sql);
    });
    mocks.pool = { query };
    mocks.context = { activeCompanyId: COMPANY, capabilities: ['document.view', 'bank.view'], user: { id: 'user' } };
    const response = await request(app).get('/api/home-alerts');
    expect(response.status).toBe(200);
    expect(response.body.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'documents_needs_review', count: 4 }),
      expect.objectContaining({ key: 'bank_transactions_unmatched', count: 5 }),
    ]));
    expect(query).toHaveBeenCalledTimes(2);
  });
});
