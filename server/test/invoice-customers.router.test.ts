import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const query = vi.hoisted(() => vi.fn());
vi.mock('../src/db/pool', () => ({ default: { query, connect: vi.fn() } as unknown as Pool }));

import { invoiceRouter } from '../src/modules/invoices/invoice.router';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const app = express();
app.use(express.json());
app.use('/api', invoiceRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));

const session = { id: 's', user_id: 'user', user_email: 'u@example.com', token_hash: 'h', active_company_id: 'company-a', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const companies = [{ membership_id: 'm', company_id: 'company-a', company_name: 'A', company_name_ar: null, role_id: 'r' }];
const cookie = ['Cookie', 'eqfal_session=token'] as const;

function login(caps: string[], activeCompanyId: string | null = 'company-a') {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue({ ...session, active_company_id: activeCompanyId });
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(activeCompanyId ? companies : []);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
}

beforeEach(() => {
  vi.restoreAllMocks();
  query.mockReset();
  query.mockResolvedValue({ rows: [{ id: 'c1', name: 'Acme', type: 'customer' }] });
});

describe('GET /api/invoices/customers authorization', () => {
  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await request(app).get('/api/invoices/customers')).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('requires an active company', async () => {
    login(['invoice.create'], null);
    expect((await request(app).get('/api/invoices/customers').set(...cookie)).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([['invoice.view'], ['invoice.create'], ['invoice.edit']])('allows %s alone, without obligation.view', async (capability) => {
    login([capability]);
    const res = await request(app).get('/api/invoices/customers').set(...cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ customers: [{ id: 'c1', name: 'Acme', type: 'customer' }] });
  });

  it.each([[['obligation.view']], [['document.view', 'obligation.view', 'counterparty.create']], [['invoice.submit']], [[]]])('rejects %j (no view/create/edit invoice capability)', async (caps) => {
    login(caps);
    expect((await request(app).get('/api/invoices/customers').set(...cookie)).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('is read-only', async () => {
    login(['invoice.view', 'invoice.create', 'invoice.edit']);
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect([404, 400, 403]).toContain((await request(app)[method]('/api/invoices/customers').set('Origin', 'http://localhost').set(...cookie).send({})).status);
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /api/invoices/customers query', () => {
  it('is scoped to the active company, active non-supplier counterparties, and selects only id, name, type', async () => {
    login(['invoice.create']);
    await request(app).get('/api/invoices/customers').set(...cookie);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['company-a']);
    expect(sql).toMatch(/WHERE company_id = \$1/);
    expect(sql).toMatch(/is_active = TRUE/);
    expect(sql).toMatch(/type <> 'supplier'/);
    expect(sql).toMatch(/SELECT id, name, type FROM counterparties/);
  });

  it('does not take the company from the request', async () => {
    login(['invoice.create']);
    await request(app).get('/api/invoices/customers?company_id=company-b').set('X-Company-Id', 'company-b').set(...cookie);
    expect((query.mock.calls[0] as [string, unknown[]])[1]).toEqual(['company-a']);
  });

  it('is not shadowed by the /invoices/:id route', async () => {
    login(['invoice.view']);
    const res = await request(app).get('/api/invoices/customers').set(...cookie);
    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
  });
});
