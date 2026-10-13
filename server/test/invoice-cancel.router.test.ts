import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const query = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
vi.mock('../src/db/pool', () => ({ default: { query, connect } as unknown as Pool }));

import { invoiceRouter } from '../src/modules/invoices/invoice.router';
import { InvoiceDraftService, InvoiceError } from '../src/modules/invoices/invoice.service';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const app = express();
app.use(express.json());
app.use('/api', invoiceRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));

const session = { id: 's', user_id: 'user', user_email: 'u@example.com', token_hash: 'h', active_company_id: 'company-a', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const companies = [{ membership_id: 'm', company_id: 'company-a', company_name: 'A', company_name_ar: null, role_id: 'r' }];
const cookie = ['Cookie', 'eqfal_session=token'] as const;
const ID = '11111111-1111-4111-8111-111111111111';
const url = `/api/invoices/${ID}/cancel`;

function login(caps: string[]) {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(companies);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
}
const post = (body: unknown, origin = 'http://127.0.0.1') => request(app).post(url).set(...cookie).set('Origin', origin).set('Host', '127.0.0.1').send(body as object);

beforeEach(() => { vi.restoreAllMocks(); query.mockReset(); connect.mockReset(); });

describe('POST /api/invoices/:id/cancel authorization and input', () => {
  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await post({ version: 2, reason: 'x' })).status).toBe(401);
  });

  it.each([[['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit', 'invoice.approve']], [[]]])('refuses %j without invoice.cancel', async (caps) => {
    login(caps);
    const spy = vi.spyOn(InvoiceDraftService.prototype, 'cancel');
    expect((await post({ version: 2, reason: 'duplicate' })).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a cross-origin request before the service', async () => {
    login(['invoice.cancel']);
    const spy = vi.spyOn(InvoiceDraftService.prototype, 'cancel');
    expect((await post({ version: 2, reason: 'duplicate' }, 'https://evil.example')).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a missing/invalid version, a missing/blank/oversized reason and a malformed id without touching the service', async () => {
    login(['invoice.cancel']);
    const spy = vi.spyOn(InvoiceDraftService.prototype, 'cancel');
    expect((await post({ reason: 'x' })).status).toBe(400);
    expect((await post({ version: 0, reason: 'x' })).status).toBe(400);
    expect((await post({ version: 2 })).status).toBe(400);
    expect((await post({ version: 2, reason: '   ' })).status).toBe(400);
    expect((await post({ version: 2, reason: 5 })).status).toBe(400);
    expect((await post({ version: 2, reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await request(app).post('/api/invoices/not-a-uuid/cancel').set(...cookie).set('Origin', 'http://127.0.0.1').set('Host', '127.0.0.1').send({ version: 2, reason: 'x' })).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes the company, actor, version and trimmed reason to the service and maps its errors', async () => {
    login(['invoice.cancel']);
    const spy = vi.spyOn(InvoiceDraftService.prototype, 'cancel').mockRejectedValue(new InvoiceError(409, 'INVOICE_CANCEL_NOT_ALLOWED', 'An approved invoice cannot be cancelled'));
    const res = await post({ version: 2, reason: '  duplicate entry  ' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_CANCEL_NOT_ALLOWED');
    expect(spy).toHaveBeenCalledWith('company-a', 'user', ID, 2, 'duplicate entry');
  });
});
