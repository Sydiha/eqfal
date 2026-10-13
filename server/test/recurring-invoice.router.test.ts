import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const query = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
vi.mock('../src/db/pool', () => ({ default: { query, connect } as unknown as Pool }));

import { recurringInvoiceRouter } from '../src/modules/invoices/recurring-invoice.router';
import { RecurringInvoiceService } from '../src/modules/invoices/recurring-invoice.service';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const app = express();
app.use(express.json());
app.use('/api', recurringInvoiceRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));

const session = { id: 's', user_id: 'user', user_email: 'u@example.com', token_hash: 'h', active_company_id: 'company-a', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const companies = [{ membership_id: 'm', company_id: 'company-a', company_name: 'A', company_name_ar: null, role_id: 'r' }];
const ID = '11111111-1111-4111-8111-111111111111';
const CP = '22222222-2222-4222-8222-222222222222';
const body = { direction: 'sales', name: 'Rent', counterparty_id: CP, frequency: 'monthly', start_date: '2031-01-31', lines: [{ description: 'x', quantity: '1', unit_price: '100.00', vat_rate: '15', vat_treatment: 'standard' }] };

function login(caps: string[]) {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(companies);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
}
const send = (method: 'post' | 'put' | 'get', url: string, payload?: unknown, origin = 'http://127.0.0.1') =>
  request(app)[method](url).set('Cookie', 'eqfal_session=token').set('Origin', origin).set('Host', '127.0.0.1').send(payload as object);

beforeEach(() => { vi.restoreAllMocks(); query.mockReset(); connect.mockReset(); });

describe('recurring invoice API authorization (no database)', () => {
  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await send('get', '/api/recurring-invoices')).status).toBe(401);
    expect((await send('post', '/api/recurring-invoices', body)).status).toBe(401);
  });

  it('reads need invoice.view; invoice.recurring alone does not read', async () => {
    login(['invoice.recurring']);
    const spy = vi.spyOn(RecurringInvoiceService.prototype, 'list');
    expect((await send('get', '/api/recurring-invoices')).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([['post', '/api/recurring-invoices'], ['put', `/api/recurring-invoices/${ID}`], ['post', `/api/recurring-invoices/${ID}/pause`],
    ['post', `/api/recurring-invoices/${ID}/resume`], ['post', `/api/recurring-invoices/${ID}/end`], ['post', '/api/recurring-invoices/run-due']] as const)(
    'refuses %s %s without invoice.recurring even with every other invoice capability', async (method, url) => {
      login(['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit', 'invoice.approve', 'invoice.cancel']);
      const create = vi.spyOn(RecurringInvoiceService.prototype, 'create'); const run = vi.spyOn(RecurringInvoiceService.prototype, 'runDueForCompany');
      expect((await send(method, url, { ...body, version: 1 })).status).toBe(403);
      expect(create).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    });

  it('refuses a cross-origin write before the service', async () => {
    login(['invoice.recurring']);
    const spy = vi.spyOn(RecurringInvoiceService.prototype, 'create');
    expect((await send('post', '/api/recurring-invoices', body, 'https://evil.example')).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('manual run also needs invoice.create', async () => {
    login(['invoice.recurring']);
    const spy = vi.spyOn(RecurringInvoiceService.prototype, 'runDueForCompany');
    expect((await send('post', '/api/recurring-invoices/run-due', {})).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown field', { ...body, status: 'active' }],
    ['bad direction', { ...body, direction: 'other' }],
    ['bad frequency', { ...body, frequency: 'weekly' }],
    ['bad date', { ...body, start_date: '2031-02-30' }],
    ['end before start', { ...body, end_date: '2030-01-01' }],
    ['no lines', { ...body, lines: [] }],
    ['numeric amount', { ...body, lines: [{ ...body.lines[0], unit_price: 100 }] }],
    ['blank name', { ...body, name: '  ' }],
    ['due_days out of range', { ...body, due_days: 400 }],
  ])('rejects invalid input (%s) with 400 before the service', async (_label, payload) => {
    login(['invoice.recurring']);
    const spy = vi.spyOn(RecurringInvoiceService.prototype, 'create');
    expect((await send('post', '/api/recurring-invoices', payload)).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a malformed id and a missing version', async () => {
    login(['invoice.recurring', 'invoice.view']);
    expect((await send('get', '/api/recurring-invoices/not-a-uuid')).status).toBe(404);
    expect((await send('post', `/api/recurring-invoices/${ID}/pause`, {})).status).toBe(400);
  });
});
