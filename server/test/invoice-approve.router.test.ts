import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const query = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
vi.mock('../src/db/pool', () => ({ default: { query, connect } as unknown as Pool }));

import { invoiceRouter } from '../src/modules/invoices/invoice.router';
import { InvoiceApprovalService } from '../src/modules/invoices/invoice-approval.service';
import { InvoiceError } from '../src/modules/invoices/invoice.service';
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
const url = `/api/invoices/${ID}/approve`;

function login(caps: string[]) {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(companies);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
}
const post = (body: unknown) => request(app).post(url).set(...cookie).set('Origin', 'http://127.0.0.1').set('Host', '127.0.0.1').send(body as object);

beforeEach(() => { vi.restoreAllMocks(); query.mockReset(); connect.mockReset(); });

describe('POST /api/invoices/:id/approve authorization and input', () => {
  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await post({ version: 2 })).status).toBe(401);
  });

  it.each([[['invoice.view', 'invoice.submit', 'obligation.confirm', 'accounting.journal.create']], [['invoice.create', 'invoice.edit']], [[]]])('refuses %j without invoice.approve', async (caps) => {
    login(caps);
    const spy = vi.spyOn(InvoiceApprovalService.prototype, 'approve');
    expect((await post({ version: 2 })).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a missing/invalid version and a malformed id before touching the service', async () => {
    login(['invoice.approve']);
    const spy = vi.spyOn(InvoiceApprovalService.prototype, 'approve');
    expect((await post({})).status).toBe(400);
    expect((await post({ version: 0 })).status).toBe(400);
    expect((await request(app).post('/api/invoices/not-a-uuid/approve').set(...cookie).set('Origin', 'http://127.0.0.1').set('Host', '127.0.0.1').send({ version: 2 })).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes the caller, company, capabilities and version to the service and maps its errors', async () => {
    login(['invoice.approve', 'obligation.confirm']);
    const spy = vi.spyOn(InvoiceApprovalService.prototype, 'approve').mockRejectedValue(new InvoiceError(409, 'INVOICE_SELF_APPROVAL', 'The creator of an invoice cannot approve it'));
    const res = await post({ version: 2 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_SELF_APPROVAL');
    expect(spy).toHaveBeenCalledWith('company-a', 'user', expect.arrayContaining(['invoice.approve', 'obligation.confirm']), ID, 2);
  });
});
