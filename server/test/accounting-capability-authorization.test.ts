import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capabilities: [] as string[],
}));

vi.mock('../src/db/pool', () => ({ default: null }));

vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => ({
    user: { id: 'user-1', email: 'user@example.com' },
    allowedCompanies: [{ id: 'co-a', name: 'Alpha', name_ar: null }],
    activeCompanyId: 'co-a',
    capabilities: mocks.capabilities,
  })),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireActiveCompany: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireCapability: (capability: string) =>
    (_req: Request, res: Response, next: NextFunction) => {
      if (!mocks.capabilities.includes(capability)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      next();
    },
}));

import { accountingRouter } from '../src/modules/accounting/accounting.router';

const app = express();
app.use(express.json());
app.use('/api', accountingRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : 'error' });
});

const expectAllowedPastCapabilityGate = (response: request.Response) => {
  expect(response.status).not.toBe(403);
};

describe('Phase 9A.5 accounting capability authorization behavior', () => {
  beforeEach(() => {
    mocks.capabilities.length = 0;
  });

  it('journal.create can create but cannot edit or post', async () => {
    mocks.capabilities.push('accounting.journal.create');

    expectAllowedPastCapabilityGate(await request(app).post('/api/journals').send({}));
    expect((await request(app).patch('/api/journals/22222222-2222-4222-8222-222222222222').send({})).status).toBe(403);
    expect((await request(app).post('/api/journals/22222222-2222-4222-8222-222222222222/post').send({})).status).toBe(403);
  });

  it('journal.edit can edit but cannot create or post', async () => {
    mocks.capabilities.push('accounting.journal.edit');

    expectAllowedPastCapabilityGate(await request(app).patch('/api/journals/22222222-2222-4222-8222-222222222222').send({}));
    expectAllowedPastCapabilityGate(await request(app).put('/api/journals/22222222-2222-4222-8222-222222222222/lines').send({}));
    expect((await request(app).post('/api/journals').send({})).status).toBe(403);
    expect((await request(app).post('/api/journals/22222222-2222-4222-8222-222222222222/post').send({})).status).toBe(403);
  });

  it('chart.create can create but cannot edit', async () => {
    mocks.capabilities.push('accounting.chart.create');

    expectAllowedPastCapabilityGate(await request(app).post('/api/accounts').send({}));
    expect((await request(app).patch('/api/accounts/11111111-1111-4111-8111-111111111111').send({})).status).toBe(403);
  });

  it('chart.edit can edit but cannot create', async () => {
    mocks.capabilities.push('accounting.chart.edit');

    expectAllowedPastCapabilityGate(await request(app).patch('/api/accounts/11111111-1111-4111-8111-111111111111').send({}));
    expect((await request(app).post('/api/accounts').send({})).status).toBe(403);
  });

  it('posting stays independent from journal create and edit', async () => {
    mocks.capabilities.push('accounting.journal.post');

    expectAllowedPastCapabilityGate(await request(app).post('/api/journals/22222222-2222-4222-8222-222222222222/post').send({}));
    expect((await request(app).post('/api/journals').send({})).status).toBe(403);
    expect((await request(app).patch('/api/journals/22222222-2222-4222-8222-222222222222').send({})).status).toBe(403);
  });
});
