import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } as unknown as Pool }));

import { requireAuth, requireCapability } from '../src/modules/auth/auth.middleware';
import { SessionService } from '../src/modules/auth/session.service';

/** P1: a missing capability keeps its 403 and legacy text and adds the stable FORBIDDEN code; nothing about the capability set leaks. */
function app() {
  const server = express();
  server.get('/guarded', requireAuth, requireCapability('vat.close'), (_req, res) => res.json({ ok: true }));
  server.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: 'Internal server error' }));
  return server;
}
const context = (capabilities: string[], activeCompanyId: string | null = 'c1') =>
  ({ user: { id: 'u', email: 'u@x.com' }, allowedCompanies: [], activeCompanyId, capabilities }) as never;

describe('requireCapability FORBIDDEN code', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns 403 with the legacy error and the FORBIDDEN code when the capability is missing', async () => {
    vi.spyOn(SessionService.prototype, 'getContext').mockResolvedValue(context(['vat.view', 'invoice.approve']));
    const response = await request(app()).get('/guarded').set('Cookie', 'eqfal_session=token');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' });
  });

  it('returns the same body without an active company', async () => {
    vi.spyOn(SessionService.prototype, 'getContext').mockResolvedValue(context(['vat.close'], null));
    const response = await request(app()).get('/guarded').set('Cookie', 'eqfal_session=token');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' });
  });

  it('still allows a holder of the capability', async () => {
    vi.spyOn(SessionService.prototype, 'getContext').mockResolvedValue(context(['vat.close']));
    expect((await request(app()).get('/guarded').set('Cookie', 'eqfal_session=token')).status).toBe(200);
  });
});
