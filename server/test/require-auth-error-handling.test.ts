import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } as unknown as Pool }));

import { requireAuth } from '../src/modules/auth/auth.middleware';
import { SessionService } from '../src/modules/auth/session.service';

function appWithCentralHandler() {
  const app = express();
  app.get('/protected', requireAuth, (_req, res) => res.json({ ok: true }));
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: 'Internal server error' }));
  return app;
}

describe('H2 requireAuth async failure handling', () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  afterEach(() => { process.off('unhandledRejection', onRejection); vi.restoreAllMocks(); rejections.length = 0; });

  it('returns a controlled 500 without details and no unhandled rejection when the DB fails', async () => {
    process.on('unhandledRejection', onRejection);
    vi.spyOn(SessionService.prototype, 'getContext').mockRejectedValue(new Error('connection to pg-secret-host:5432 refused'));
    const response = await request(appWithCentralHandler()).get('/protected').set('Cookie', 'eqfal_session=token').timeout(2000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/pg-secret-host|5432|refused/);
    expect(rejections).toEqual([]);
  });

  it('still authenticates normally', async () => {
    vi.spyOn(SessionService.prototype, 'getContext').mockResolvedValue({ user: { id: 'u', email: 'u@x.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] } as never);
    expect((await request(appWithCentralHandler()).get('/protected').set('Cookie', 'eqfal_session=token')).status).toBe(200);
  });
});
