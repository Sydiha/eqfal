import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const query = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
const guard = vi.hoisted(() => ({ closed: false }));
vi.mock('../src/db/pool', () => ({ default: { query, connect } as unknown as Pool }));
vi.mock('../src/modules/monthly-close/accounting-period.guard', () => {
  class AccountingPeriodClosedError extends Error { constructor() { super('Accounting period is closed'); } }
  const check = async () => { if (guard.closed) throw new AccountingPeriodClosedError(); };
  return { AccountingPeriodClosedError, assertAccountingDateWritable: check, assertAccountingRangeWritable: check };
});

import { recordDeletionRouter } from '../src/modules/record-deletion/record-deletion.router';
import { RecordDeletionService } from '../src/modules/record-deletion/record-deletion.service';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const app = express();
app.use(express.json());
app.use('/api', recordDeletionRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));

const session = { id: 's', user_id: 'user', user_email: 'u@example.com', token_hash: 'h', active_company_id: 'company-a', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const companies = [{ membership_id: 'm', company_id: 'company-a', company_name: 'A', company_name_ar: null, role_id: 'r' }];
const ID = '11111111-1111-4111-8111-111111111111';
function login(caps: string[]) {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(companies);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
}
const del = (path: string, origin = 'http://127.0.0.1') => request(app).delete(path).set('Cookie', 'eqfal_session=token').set('Origin', origin).set('Host', '127.0.0.1');
beforeEach(() => { vi.restoreAllMocks(); query.mockReset(); connect.mockReset(); guard.closed = false; });

const CASES = [
  ['journals', 'accounting.journal.delete', 'deleteJournal', ''],
  ['periodic-adjustments', 'periodic_adjustment.delete', 'deletePeriodicAdjustment', ''],
  ['bank-import-batches', 'bank.import.delete', 'deleteBankImportBatch', ''],
  ['counterparties', 'counterparty.delete', 'deleteCounterparty', '?version=3'],
  ['partners', 'partner.delete', 'deletePartner', '?version=3'],
] as const;

describe.each(CASES)('DELETE /api/%s/:id', (path, cap, method, qs) => {
  const url = `/api/${path}/${ID}${qs}`;
  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await del(url)).status).toBe(401);
  });
  it('refuses a user without its own capability (ordinary roles never get it) and a cross-origin call', async () => {
    login(['accounting.journal.edit', 'accounting.journal.post', 'periodic_adjustment.review', 'bank.import', 'counterparty.create', 'partner.create', 'invoice.delete', 'document.delete']);
    const spy = vi.spyOn(RecordDeletionService.prototype, method);
    expect((await del(url)).status).toBe(403);
    login([cap]);
    expect((await del(url, 'https://evil.example')).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });
  it('rejects a malformed id', async () => {
    login([cap]);
    expect((await del(`/api/${path}/nope${qs}`)).status).toBe(400);
  });
  it('passes the active company and actor and answers { deleted: true }', async () => {
    login([cap]);
    const spy = vi.spyOn(RecordDeletionService.prototype, method).mockResolvedValue(undefined);
    const res = await del(url);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: ID });
    expect(spy.mock.calls[0]!.slice(0, 3)).toEqual(['company-a', 'user', ID]);
  });
});

describe('versioned deletes', () => {
  it.each(['counterparties', 'partners'])('%s require a valid version', async (path) => {
    login(['counterparty.delete', 'partner.delete']);
    for (const q of ['', '?version=0', '?version=1.5', '?version=x']) expect((await del(`/api/${path}/${ID}${q}`)).status).toBe(400);
  });
});

describe('RecordDeletionService (mocked database)', () => {
  const client = { query: vi.fn(), release: vi.fn() };
  const files = { delete: vi.fn() };
  type Opts = { row?: Record<string, unknown> | null; ref?: string | null };
  const run = (fn: (s: RecordDeletionService) => Promise<void>, { row = {}, ref = null }: Opts = {}) => {
    client.query.mockReset(); files.delete.mockReset().mockResolvedValue(undefined);
    client.query.mockImplementation(async (sql: string) => {
      if (/FOR UPDATE/.test(sql)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      if (/pg_constraint/.test(sql)) return { rows: ref ? [{ tbl: ref, pairs: [{ col: 'x', ref: 'id' }] }] : [], rowCount: ref ? 1 : 0 };
      if (/^SELECT 1 FROM/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/recognition_start/.test(sql)) return { rows: [{ s: '2026-01-01', e: '2026-03-01' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    connect.mockResolvedValue(client);
    return fn(new RecordDeletionService({ connect } as unknown as Pool, files as never));
  };
  const issued = () => client.query.mock.calls.map(([sql]) => String(sql));
  const noDelete = () => expect(issued().some((s) => /DELETE FROM/.test(s))).toBe(false);

  it('journal: refuses posted and system-generated entries, never issues DELETE', async () => {
    await expect(run((s) => s.deleteJournal('company-a', 'u', ID), { row: { status: 'posted', source_type: null, entry_type: 'standard', accounting_date: '2026-01-05' } })).rejects.toMatchObject({ reason: 'posted' });
    noDelete();
    await expect(run((s) => s.deleteJournal('company-a', 'u', ID), { row: { status: 'draft', source_type: 'invoice', entry_type: 'standard', accounting_date: '2026-01-05' } })).rejects.toMatchObject({ reason: 'system_generated' });
    await expect(run((s) => s.deleteJournal('company-a', 'u', ID), { row: { status: 'draft', source_type: null, entry_type: 'opening_balance', accounting_date: '2026-01-05' } })).rejects.toMatchObject({ reason: 'system_generated' });
    noDelete();
  });
  it('journal: refuses a closed period, a referenced draft and a missing/other-company entry', async () => {
    const draft = { status: 'draft', source_type: null, entry_type: 'standard', accounting_date: '2026-01-05' };
    guard.closed = true;
    await expect(run((s) => s.deleteJournal('company-a', 'u', ID), { row: draft })).rejects.toThrow('closed');
    noDelete();
    guard.closed = false;
    await expect(run((s) => s.deleteJournal('company-a', 'u', ID), { row: draft, ref: 'fixed_assets' })).rejects.toMatchObject({ reason: 'fixed_assets' });
    noDelete();
    await expect(run((s) => s.deleteJournal('company-a', 'u', ID), { row: null })).rejects.toThrow();
    expect(client.query.mock.calls[1]![1]).toEqual([ID, 'company-a']);
  });
  it('journal: deletes a manual draft company-scoped and audits in the same transaction', async () => {
    await run((s) => s.deleteJournal('company-a', 'u', ID), { row: { status: 'draft', source_type: null, entry_type: 'standard', accounting_date: '2026-01-05' } });
    const deletes = client.query.mock.calls.filter(([sql]) => /DELETE FROM journal_entries/.test(String(sql)));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]![1]).toEqual([ID, 'company-a']);
    expect(issued().some((s) => /INSERT INTO audit_log/.test(s))).toBe(true);
    expect(issued()).toContain('COMMIT');
  });
  it.each(['in_review', 'approved', 'completed'])('periodic adjustment: refuses %s', async (status) => {
    await expect(run((s) => s.deletePeriodicAdjustment('company-a', 'u', ID), { row: { workflow_status: status } })).rejects.toMatchObject({ reason: 'not_draft' });
    noDelete();
  });
  it('periodic adjustment: refuses closed period, deletes a clean draft', async () => {
    guard.closed = true;
    await expect(run((s) => s.deletePeriodicAdjustment('company-a', 'u', ID), { row: { workflow_status: 'draft' } })).rejects.toThrow('closed');
    guard.closed = false;
    await run((s) => s.deletePeriodicAdjustment('company-a', 'u', ID), { row: { workflow_status: 'draft' } });
    expect(issued().some((s) => /DELETE FROM periodic_adjustments/.test(s))).toBe(true);
  });
  it('bank import: refuses a confirmed batch; deletes an unconfirmed one and removes the file after commit', async () => {
    await expect(run((s) => s.deleteBankImportBatch('company-a', 'u', ID), { row: { status: 'confirmed', storage_key: 'company-a/k' } })).rejects.toMatchObject({ reason: 'confirmed' });
    noDelete();
    expect(files.delete).not.toHaveBeenCalled();
    await run((s) => s.deleteBankImportBatch('company-a', 'u', ID), { row: { status: 'preview_ready', storage_key: 'company-a/k' } });
    expect(files.delete).toHaveBeenCalledWith('company-a/k');
    await run((s) => s.deleteBankImportBatch('company-a', 'u', ID), { row: { status: 'mapping_required', storage_key: 'company-b/k' } });
    expect(files.delete).not.toHaveBeenCalled();
  });
  it('counterparty and partner: stale version and any reference block the delete', async () => {
    await expect(run((s) => s.deleteCounterparty('company-a', 'u', ID, 3), { row: { version: 4 } })).rejects.toThrow();
    await expect(run((s) => s.deleteCounterparty('company-a', 'u', ID, 3), { row: { version: 3 }, ref: 'obligations' })).rejects.toMatchObject({ reason: 'obligations' });
    await expect(run((s) => s.deletePartner('company-a', 'u', ID, 3), { row: { version: 3 }, ref: 'partner_ownership_periods' })).rejects.toMatchObject({ reason: 'partner_ownership_periods' });
    noDelete();
    await run((s) => s.deletePartner('company-a', 'u', ID, 3), { row: { version: 3 } });
    expect(issued().some((s) => /DELETE FROM partners/.test(s))).toBe(true);
    expect(issued().some((s) => /INSERT INTO audit_log/.test(s))).toBe(true);
  });
});
