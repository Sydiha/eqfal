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
import { invoiceAccountMappingRouter } from '../src/modules/invoices/invoice-account-mapping.router';
import { InvoiceAccountMappingService } from '../src/modules/invoices/invoice-account-mapping.service';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';
import { AuditLogRepository } from '../src/modules/audit-log/audit-log.repository';

const app = express();
app.use(express.json());
app.use('/api', invoiceAccountMappingRouter);
app.use('/api', invoiceRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));

const session = { id: 's', user_id: 'user', user_email: 'u@example.com', token_hash: 'h', active_company_id: 'company-a', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const companies = [{ membership_id: 'm', company_id: 'company-a', company_name: 'A', company_name_ar: null, role_id: 'r' }];
const login = (caps: string[]) => {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(companies);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
};
const call = (method: 'get' | 'put' | 'delete', path: string, body?: unknown, origin = 'http://127.0.0.1') =>
  request(app)[method](path).set('Cookie', 'eqfal_session=token').set('Origin', origin).set('Host', '127.0.0.1').send(body as object);

beforeEach(() => { vi.restoreAllMocks(); query.mockReset(); connect.mockReset(); });

describe('invoice account mapping routes: permissions', () => {
  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await call('get', '/api/invoice-account-mappings')).status).toBe(401);
  });

  it('view alone can read but cannot set or clear', async () => {
    login(['invoice.mapping.view']);
    const overview = vi.spyOn(InvoiceAccountMappingService.prototype, 'overview').mockResolvedValue([]);
    const set = vi.spyOn(InvoiceAccountMappingService.prototype, 'set');
    const clear = vi.spyOn(InvoiceAccountMappingService.prototype, 'clear');
    expect((await call('get', '/api/invoice-account-mappings')).status).toBe(200);
    expect(overview).toHaveBeenCalledWith('company-a');
    expect((await call('put', '/api/invoice-account-mappings/receivable', { account_id: 'x' })).status).toBe(403);
    expect((await call('delete', '/api/invoice-account-mappings/receivable')).status).toBe(403);
    expect(set).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('manage alone cannot read; unrelated invoice capabilities grant nothing', async () => {
    login(['invoice.mapping.manage']);
    expect((await call('get', '/api/invoice-account-mappings')).status).toBe(403);
    // manage without view is never usable: writes also need view, so a role cannot hold a write power its holder cannot reach in the UI
    const set = vi.spyOn(InvoiceAccountMappingService.prototype, 'set');
    expect((await call('put', '/api/invoice-account-mappings/receivable', { account_id: 'x' })).status).toBe(403);
    expect((await call('delete', '/api/invoice-account-mappings/receivable')).status).toBe(403);
    expect(set).not.toHaveBeenCalled();
    login(['invoice.view', 'invoice.approve', 'accounting.view']);
    expect((await call('get', '/api/invoice-account-mappings')).status).toBe(403);
    expect((await call('put', '/api/invoice-account-mappings/receivable', { account_id: 'x' })).status).toBe(403);
  });

  it('manage can set and clear on the active company only and rejects a foreign origin', async () => {
    login(['invoice.mapping.view', 'invoice.mapping.manage']);
    vi.spyOn(InvoiceAccountMappingService.prototype, 'overview').mockResolvedValue([]);
    const set = vi.spyOn(InvoiceAccountMappingService.prototype, 'set').mockResolvedValue(undefined);
    const clear = vi.spyOn(InvoiceAccountMappingService.prototype, 'clear').mockResolvedValue(undefined);
    expect((await call('put', '/api/invoice-account-mappings/receivable', { account_id: 'acc', company_id: 'company-b' })).status).toBe(200);
    expect(set).toHaveBeenCalledWith('company-a', 'user', 'receivable', 'acc');
    expect((await call('delete', '/api/invoice-account-mappings/vat_input')).status).toBe(200);
    expect(clear).toHaveBeenCalledWith('company-a', 'user', 'vat_input');
    expect((await call('put', '/api/invoice-account-mappings/receivable', { account_id: 'acc' }, 'https://evil.example')).status).toBe(403);
  });
});

/** A scripted client: answers the service's SQL by pattern and records every statement. */
function scriptedDb(account: { is_active: boolean; account_type: string } | null) {
  const sql: string[] = [];
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      sql.push(text);
      if (/FROM accounts WHERE id::text/.test(text)) {
        expect(params?.[1]).toBe('company-a'); // account lookup is always company scoped
        return { rows: account ? [account] : [] };
      }
      if (/DELETE FROM invoice_account_mappings/.test(text)) return { rows: [{ account_id: 'old' }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { sql, db: { connect: async () => client } as unknown as Pool };
}

describe('InvoiceAccountMappingService validation', () => {
  beforeEach(() => { vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue(undefined as never); });

  it.each([
    ['receivable', 'asset'], ['payable', 'liability'], ['sales_revenue', 'revenue'], ['purchase_expense', 'expense'], ['vat_output', 'liability'], ['vat_input', 'asset'],
  ])('accepts %s only with a %s account', async (key, type) => {
    const good = scriptedDb({ is_active: true, account_type: type });
    await new InvoiceAccountMappingService(good.db).set('company-a', 'user', key, 'acc');
    expect(good.sql.some((s) => /INSERT INTO invoice_account_mappings/.test(s))).toBe(true);
    const wrong = scriptedDb({ is_active: true, account_type: type === 'equity' ? 'asset' : 'equity' });
    await expect(new InvoiceAccountMappingService(wrong.db).set('company-a', 'user', key, 'acc')).rejects.toMatchObject({ status: 400, code: 'INVOICE_VALIDATION' });
    expect(wrong.sql.some((s) => /INSERT/.test(s))).toBe(false);
    expect(wrong.sql).toContain('ROLLBACK');
  });

  it('rejects inactive, missing and cross-company (not found for this company) accounts without writing', async () => {
    for (const account of [{ is_active: false, account_type: 'asset' }, null]) {
      const s = scriptedDb(account);
      await expect(new InvoiceAccountMappingService(s.db).set('company-a', 'user', 'receivable', 'acc')).rejects.toMatchObject({ status: 400 });
      expect(s.sql.some((x) => /INSERT/.test(x))).toBe(false);
    }
  });

  it('rejects unknown keys and non-string account ids', async () => {
    const s = scriptedDb({ is_active: true, account_type: 'asset' });
    const svc = new InvoiceAccountMappingService(s.db);
    await expect(svc.set('company-a', 'user', 'cash', 'acc')).rejects.toMatchObject({ status: 400 });
    await expect(svc.set('company-a', 'user', 'receivable', 42)).rejects.toMatchObject({ status: 400 });
    await expect(svc.clear('company-a', 'user', 'cash')).rejects.toMatchObject({ status: 400 });
    expect(s.sql).toHaveLength(0);
  });

  it('replaces by upsert and clears with an audit entry; only the mapping table is written, never invoices or journals', async () => {
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue(undefined as never);
    const s = scriptedDb({ is_active: true, account_type: 'asset' });
    const svc = new InvoiceAccountMappingService(s.db);
    await svc.set('company-a', 'user', 'receivable', 'acc');
    await svc.clear('company-a', 'user', 'receivable');
    expect(s.sql.some((x) => /ON CONFLICT \(company_id, mapping_key\) DO UPDATE/.test(x))).toBe(true);
    expect(audit.mock.calls.map((c) => c[0].action)).toEqual(['invoice.account_mapping.set', 'invoice.account_mapping.clear']);
    for (const x of s.sql.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q))) expect(x).toMatch(/invoice_account_mappings/);
    expect(s.sql.join('\n')).not.toMatch(/journal_|invoices\b(?!_account)|obligations/);
  });

  it('overview reports missing / invalid / configured and lists only eligible accounts of the right type', async () => {
    const db = { query: vi.fn(async (text: string) => /FROM invoice_account_mappings/.test(text)
      ? { rows: [
        { mapping_key: 'receivable', account_id: 'a1', code: '1100', name: 'AR', name_ar: null, is_active: true, account_type: 'asset' },
        { mapping_key: 'payable', account_id: 'a2', code: '2100', name: 'AP', name_ar: null, is_active: false, account_type: 'liability' },
        { mapping_key: 'vat_input', account_id: 'a3', code: '1200', name: 'VAT', name_ar: null, is_active: true, account_type: 'expense' }] }
      : { rows: [{ id: 'a1', code: '1100', name: 'AR', name_ar: null, account_type: 'asset' }, { id: 'l1', code: '2100', name: 'AP', name_ar: null, account_type: 'liability' }] }) } as unknown as Pool;
    const out = await new InvoiceAccountMappingService(db).overview('company-a');
    const by = Object.fromEntries(out.map((m) => [m.key, m]));
    expect(by.receivable!.status).toBe('configured');
    expect(by.payable!.status).toBe('invalid');
    expect(by.vat_input!.status).toBe('invalid');
    expect(by.sales_revenue!.status).toBe('missing');
    expect(by.receivable!.section).toBe('sales');
    expect(by.payable!.section).toBe('purchases');
    expect(by.receivable!.eligible_accounts.map((a) => a.id)).toEqual(['a1']);
    expect(by.vat_output!.eligible_accounts.map((a) => a.id)).toEqual(['l1']);
  });
});

describe('invoice approval with missing mappings', () => {
  it('reports the missing keys in the error body so the UI can name them', async () => {
    login(['invoice.approve']);
    vi.spyOn(InvoiceApprovalService.prototype, 'approve').mockRejectedValue(
      new InvoiceError(409, 'INVOICE_MAPPING_MISSING', 'Missing or invalid account mappings: receivable, vat_output', { missing_keys: ['receivable', 'vat_output'] }));
    const res = await request(app).post('/api/invoices/11111111-1111-4111-8111-111111111111/approve').set('Cookie', 'eqfal_session=token')
      .set('Origin', 'http://127.0.0.1').set('Host', '127.0.0.1').send({ version: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVOICE_MAPPING_MISSING', missing_keys: ['receivable', 'vat_output'] });
  });

  it('a complete mapping set is simply not reported (approval proceeds to its own checks)', async () => {
    const { requiredKeys } = await import('../src/modules/invoices/invoice-account-mapping.service');
    expect(requiredKeys('sales', true)).toEqual(['receivable', 'sales_revenue', 'vat_output']);
    expect(requiredKeys('purchase', false)).toEqual(['payable', 'purchase_expense']);
  });
});
