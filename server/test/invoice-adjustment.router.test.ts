import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const query = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
vi.mock('../src/db/pool', () => ({ default: { query, connect } as unknown as Pool }));

import { invoiceRouter } from '../src/modules/invoices/invoice.router';
import { InvoiceError } from '../src/modules/invoices/invoice.service';
import { InvoiceAdjustmentService } from '../src/modules/invoices/invoice-adjustment.service';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const app = express();
app.use(express.json());
app.use('/api', invoiceRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));

const session = { id: 's', user_id: 'user', user_email: 'u@example.com', token_hash: 'h', active_company_id: 'company-a', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const companies = [{ membership_id: 'm', company_id: 'company-a', company_name: 'A', company_name_ar: null, role_id: 'r' }];
const ID = '11111111-1111-4111-8111-111111111111';
const login = (caps: string[]) => {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(companies);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
};
const call = (method: 'get' | 'post' | 'put', path: string, body?: unknown, origin = 'http://127.0.0.1') =>
  request(app)[method](path).set('Cookie', 'eqfal_session=token').set('Origin', origin).set('Host', '127.0.0.1').send(body as object);
const note = { adjustment_type: 'credit', external_number: 'CN-1', adjustment_date: '2026-03-20', reason: 'returned goods', lines: [{ description: 'x', vat_treatment: 'standard', vat_rate: '15', net_amount: '10.00' }] };

beforeEach(() => { vi.restoreAllMocks(); query.mockReset(); connect.mockReset(); });

describe('credit / debit note routes: authorization and input', () => {
  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await call('post', `/api/invoices/${ID}/adjustments`, note)).status).toBe(401);
  });

  it.each([
    ['post', `/api/invoices/${ID}/adjustments`, 'create', note],
    ['put', `/api/invoice-adjustments/${ID}`, 'update', { version: 1, ...note, adjustment_type: undefined }],
    ['post', `/api/invoice-adjustments/${ID}/cancel`, 'cancel', { version: 1, reason: 'x' }],
  ] as const)('%s %s needs invoice.adjust (the invoice and approval capabilities do not suffice)', async (method, path, fn, body) => {
    login(['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.approve', 'invoice.cancel', 'invoice.adjust_approve', 'obligation.confirm', 'accounting.journal.create']);
    const spy = vi.spyOn(InvoiceAdjustmentService.prototype, fn);
    expect((await call(method, path, body)).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('approve needs invoice.adjust_approve; invoice.adjust alone is refused', async () => {
    login(['invoice.adjust', 'invoice.view', 'obligation.confirm', 'accounting.journal.create']);
    const spy = vi.spyOn(InvoiceAdjustmentService.prototype, 'approve');
    expect((await call('post', `/api/invoice-adjustments/${ID}/approve`, { version: 1 })).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reads need invoice.view', async () => {
    login(['invoice.adjust']);
    const spy = vi.spyOn(InvoiceAdjustmentService.prototype, 'listForInvoice');
    expect((await call('get', `/api/invoices/${ID}/adjustments`)).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a cross-origin write before the service', async () => {
    login(['invoice.adjust']);
    const spy = vi.spyOn(InvoiceAdjustmentService.prototype, 'create');
    expect((await call('post', `/api/invoices/${ID}/adjustments`, note, 'https://evil.example')).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects client-supplied amounts, a bad type, missing lines and malformed ids without touching the service', async () => {
    login(['invoice.adjust']);
    const spy = vi.spyOn(InvoiceAdjustmentService.prototype, 'create');
    const url = `/api/invoices/${ID}/adjustments`;
    expect((await call('post', url, { ...note, vat_amount: '1.50' })).status).toBe(400);
    expect((await call('post', url, { ...note, total_amount: '11.50' })).status).toBe(400);
    expect((await call('post', url, { ...note, adjustment_type: 'refund' })).status).toBe(400);
    expect((await call('post', url, { ...note, lines: [] })).status).toBe(400);
    expect((await call('post', url, { ...note, lines: [{ ...note.lines[0], net_amount: '0.00' }] })).status).toBe(400);
    expect((await call('post', '/api/invoices/not-a-uuid/adjustments', note)).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('cancel requires a version and a reason; the note type cannot be changed by an update', async () => {
    login(['invoice.adjust']);
    const cancel = vi.spyOn(InvoiceAdjustmentService.prototype, 'cancel');
    const update = vi.spyOn(InvoiceAdjustmentService.prototype, 'update');
    expect((await call('post', `/api/invoice-adjustments/${ID}/cancel`, { reason: 'x' })).status).toBe(400);
    expect((await call('post', `/api/invoice-adjustments/${ID}/cancel`, { version: 1, reason: '  ' })).status).toBe(400);
    expect((await call('put', `/api/invoice-adjustments/${ID}`, { version: 1, ...note })).status).toBe(400);
    expect(cancel).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('passes company and actor to the service, returns 201, and maps service errors', async () => {
    login(['invoice.adjust']);
    const create = vi.spyOn(InvoiceAdjustmentService.prototype, 'create').mockResolvedValue({ id: ID } as never);
    const res = await call('post', `/api/invoices/${ID}/adjustments`, note);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ adjustment: { id: ID } });
    expect(create).toHaveBeenCalledWith('company-a', 'user', ID, expect.objectContaining({ adjustment_type: 'credit', external_number: 'CN-1', totals: { subtotal_amount: '10.00', vat_amount: '1.50', total_amount: '11.50' } }));
    create.mockRejectedValue(new InvoiceError(409, 'INVOICE_ADJUSTMENT_VAT_PERIOD_UNSUPPORTED', 'ambiguous VAT period'));
    const blocked = await call('post', `/api/invoices/${ID}/adjustments`, note);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('INVOICE_ADJUSTMENT_VAT_PERIOD_UNSUPPORTED');
  });

  it('approve forwards the caller capabilities and returns the draft journal id', async () => {
    login(['invoice.adjust_approve', 'obligation.confirm', 'accounting.journal.create']);
    const approve = vi.spyOn(InvoiceAdjustmentService.prototype, 'approve').mockResolvedValue({ adjustment: { id: ID }, journal_id: 'j1' } as never);
    const res = await call('post', `/api/invoice-adjustments/${ID}/approve`, { version: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ adjustment: { id: ID }, journal_id: 'j1' });
    expect(approve).toHaveBeenCalledWith('company-a', 'user', expect.arrayContaining(['obligation.confirm', 'accounting.journal.create']), ID, 3);
  });
  it('void needs invoice.adjust_void: invoice.adjust, invoice.adjust_approve and the invoice capabilities do not suffice', async () => {
    login(['invoice.adjust', 'invoice.adjust_approve', 'invoice.view', 'invoice.cancel', 'invoice.approve', 'obligation.confirm', 'accounting.journal.create']);
    const spy = vi.spyOn(InvoiceAdjustmentService.prototype, 'voidApproved');
    expect((await call('post', `/api/invoice-adjustments/${ID}/void`, { version: 1, reason: 'x' })).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('void requires a version, a 1-500 character reason and a valid id; a cross-origin write is refused', async () => {
    login(['invoice.adjust_void']);
    const spy = vi.spyOn(InvoiceAdjustmentService.prototype, 'voidApproved');
    expect((await call('post', `/api/invoice-adjustments/${ID}/void`, { reason: 'x' })).status).toBe(400);
    expect((await call('post', `/api/invoice-adjustments/${ID}/void`, { version: 1 })).status).toBe(400);
    expect((await call('post', `/api/invoice-adjustments/${ID}/void`, { version: 1, reason: '   ' })).status).toBe(400);
    expect((await call('post', `/api/invoice-adjustments/${ID}/void`, { version: 1, reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await call('post', '/api/invoice-adjustments/not-a-uuid/void', { version: 1, reason: 'x' })).status).toBe(404);
    expect((await call('post', `/api/invoice-adjustments/${ID}/void`, { version: 1, reason: 'x' }, 'https://evil.example')).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('void forwards company, actor, capabilities, version and the trimmed reason, and maps service errors', async () => {
    login(['invoice.adjust_void']);
    const voided = vi.spyOn(InvoiceAdjustmentService.prototype, 'voidApproved').mockResolvedValue({ id: ID, status: 'cancelled' } as never);
    const res = await call('post', `/api/invoice-adjustments/${ID}/void`, { version: 4, reason: '  wrong amount  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ adjustment: { id: ID, status: 'cancelled' } });
    expect(voided).toHaveBeenCalledWith('company-a', 'user', ['invoice.adjust_void'], ID, 4, 'wrong amount');
    voided.mockRejectedValue(new InvoiceError(409, 'INVOICE_ADJUSTMENT_JOURNAL_NOT_DRAFT', 'posted'));
    const blocked = await call('post', `/api/invoice-adjustments/${ID}/void`, { version: 4, reason: 'x' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('INVOICE_ADJUSTMENT_JOURNAL_NOT_DRAFT');
  });
});
