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
const url = `/api/invoices/${ID}?version=3`;

function login(caps: string[]) {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(companies);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
}
const del = (path = url, origin = 'http://127.0.0.1') => request(app).delete(path).set(...cookie).set('Origin', origin).set('Host', '127.0.0.1');

beforeEach(() => { vi.restoreAllMocks(); query.mockReset(); connect.mockReset(); });

describe('DELETE /api/invoices/:id authorization and input', () => {
  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await del()).status).toBe(401);
  });

  it.each([[['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit', 'invoice.approve', 'invoice.cancel']], [[]]])('refuses %j without invoice.delete', async (caps) => {
    login(caps);
    const spy = vi.spyOn(InvoiceDraftService.prototype, 'deleteDraft');
    expect((await del()).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a cross-origin request before the service', async () => {
    login(['invoice.delete']);
    const spy = vi.spyOn(InvoiceDraftService.prototype, 'deleteDraft');
    expect((await del(url, 'https://evil.example')).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a missing, zero, fractional or non-numeric version and a malformed id without touching the service', async () => {
    login(['invoice.delete']);
    const spy = vi.spyOn(InvoiceDraftService.prototype, 'deleteDraft');
    for (const q of ['', '?version=0', '?version=1.5', '?version=abc', '?version=-2', '?version=3&version=4']) expect((await del(`/api/invoices/${ID}${q}`)).status).toBe(400);
    expect((await del('/api/invoices/not-a-uuid?version=3')).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes the active company, actor, id and version to the service and answers { deleted: true }', async () => {
    login(['invoice.delete']);
    const spy = vi.spyOn(InvoiceDraftService.prototype, 'deleteDraft').mockResolvedValue(undefined);
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: ID });
    expect(spy).toHaveBeenCalledWith('company-a', 'user', ID, 3);
  });

  it.each([[409, 'INVOICE_DELETE_NOT_ALLOWED'], [409, 'INVOICE_VERSION_CONFLICT'], [404, 'INVOICE_NOT_FOUND']] as const)('maps service error %s %s', async (status, code) => {
    login(['invoice.delete']);
    vi.spyOn(InvoiceDraftService.prototype, 'deleteDraft').mockRejectedValue(new InvoiceError(status, code, 'x'));
    const res = await del();
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });
});

describe('InvoiceDraftService.deleteDraft (mocked database)', () => {
  const client = { query: vi.fn(), release: vi.fn() };
  const run = (status: string, version = 3, footprint = 0) => {
    client.query.mockReset(); client.release.mockReset();
    client.query.mockImplementation(async (sql: string) => {
      if (/FOR UPDATE/.test(sql)) return { rows: status === 'missing' ? [] : [{ status, version }], rowCount: status === 'missing' ? 0 : 1 };
      if (/SELECT 1 WHERE EXISTS/.test(sql)) return { rows: [], rowCount: footprint };
      return { rows: [], rowCount: 0 };
    });
    connect.mockResolvedValue(client);
    return new InvoiceDraftService({ connect } as unknown as Pool).deleteDraft('company-a', 'user', ID, 3);
  };
  const issued = () => client.query.mock.calls.map(([sql]) => String(sql));

  it.each(['submitted', 'approved', 'cancelled'])('refuses a %s invoice and never issues a DELETE', async (status) => {
    await expect(run(status)).rejects.toMatchObject({ code: 'INVOICE_DELETE_NOT_ALLOWED' });
    expect(issued().some((s) => /DELETE FROM/.test(s))).toBe(false);
    expect(issued()).toContain('ROLLBACK');
  });

  it('refuses a draft that already has financial records', async () => {
    await expect(run('draft', 3, 1)).rejects.toMatchObject({ code: 'INVOICE_DELETE_NOT_ALLOWED' });
    expect(issued().some((s) => /DELETE FROM/.test(s))).toBe(false);
  });

  it('refuses a missing invoice and a stale version', async () => {
    await expect(run('missing')).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    await expect(run('draft', 9)).rejects.toMatchObject({ code: 'INVOICE_VERSION_CONFLICT' });
  });

  it('deletes only a draft of the active company and audits it in the same transaction', async () => {
    await run('draft');
    const deletes = client.query.mock.calls.filter(([sql]) => /DELETE FROM invoices/.test(String(sql)));
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0]![0])).toMatch(/company_id = \$2 AND status = 'draft'/);
    expect(deletes[0]![1]).toEqual([ID, 'company-a']);
    expect(issued().some((s) => /INSERT INTO audit_log/.test(s))).toBe(true);
    expect(issued()).toContain('COMMIT');
  });
});
