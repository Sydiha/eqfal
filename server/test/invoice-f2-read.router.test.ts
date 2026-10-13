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
});

describe('F2 read filters', () => {
  it('serves the supplier picker for direction=purchase (non-customer counterparties only)', async () => {
    login(['invoice.view']);
    query.mockResolvedValue({ rows: [{ id: 's1', name: 'Supplier', type: 'supplier' }] });
    const res = await request(app).get('/api/invoices/customers?direction=purchase').set(...cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suppliers: [{ id: 's1', name: 'Supplier', type: 'supplier' }] });
    expect(String(query.mock.calls[0]![0])).toContain("type <> 'customer'");
    expect(query.mock.calls[0]![1]).toEqual(['company-a']);
  });

  it('keeps the customer picker for sales, ignores unrelated parameters and rejects an unknown direction', async () => {
    login(['invoice.view']);
    query.mockResolvedValue({ rows: [] });
    expect((await request(app).get('/api/invoices/customers?direction=sales').set(...cookie)).body).toEqual({ customers: [] });
    expect(String(query.mock.calls[0]![0])).toContain("type <> 'supplier'");
    for (const bad of ['?direction=other', '?direction=a&direction=b']) {
      expect((await request(app).get(`/api/invoices/customers${bad}`).set(...cookie)).status).toBe(400);
    }
  });

  it('applies the q search as a single escaped, company-scoped parameter in both count and rows queries', async () => {
    login(['invoice.view']);
    query.mockResolvedValueOnce({ rows: [{ n: '0' }] }).mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/invoices').query({ direction: 'purchase', q: '50%_a\\b' }).set(...cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ invoices: [], total: 0 });
    for (const call of query.mock.calls) {
      expect(String(call[0])).toContain('ILIKE');
      expect(String(call[0])).toContain('c.name');
      expect(call[1][0]).toBe('company-a');
      expect(call[1]).toContain('%50\\%\\_a\\\\b%');
    }
  });

  it('omits the search condition when q is blank and rejects an over-long or repeated q', async () => {
    login(['invoice.view']);
    query.mockResolvedValueOnce({ rows: [{ n: '0' }] }).mockResolvedValueOnce({ rows: [] });
    expect((await request(app).get('/api/invoices?q=%20%20').set(...cookie)).status).toBe(200);
    expect(String(query.mock.calls[0]![0])).not.toContain('ILIKE');
    expect((await request(app).get(`/api/invoices?q=${'x'.repeat(101)}`).set(...cookie)).status).toBe(400);
    expect((await request(app).get('/api/invoices?q=a&q=b').set(...cookie)).status).toBe(400);
  });

  it('still requires invoice.view for the list', async () => {
    login(['invoice.create']);
    expect((await request(app).get('/api/invoices?q=a').set(...cookie)).status).toBe(403);
  });
});
