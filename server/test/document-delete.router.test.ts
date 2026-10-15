import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Delete & Void Phase 2: DELETE /api/documents/:id authorization, company scoping and error mapping (service mocked).
const mocks = vi.hoisted(() => ({
  context: null as null | { user: { id: string }; activeCompanyId: string | null; capabilities: string[] },
  deleteDocument: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../src/config', () => ({ default: { documentStorageDir: '/tmp/eqfal-documents-test' } }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => mocks.context),
  requireAuth: (_req: Request, res: Response, next: NextFunction) => mocks.context ? next() : void res.status(401).json({ error: 'Unauthenticated' }),
  requireActiveCompany: (_req: Request, res: Response, next: NextFunction) => mocks.context?.activeCompanyId ? next() : void res.status(403).json({ error: 'No active company' }),
  requireCapability: (capability: string) => (_req: Request, res: Response, next: NextFunction) => mocks.context?.capabilities.includes(capability) ? next() : void res.status(403).json({ error: 'Forbidden' }),
}));
vi.mock('../src/modules/documents/document.service', () => ({
  DocumentNotFoundError: class extends Error {},
  DocumentReviewConflictError: class extends Error {},
  DocumentDeleteBlockedError: class extends Error { constructor(readonly reason: string, readonly dependency: string | null = null) { super(reason); } },
  DocumentService: class { deleteDocument = mocks.deleteDocument; },
}));
vi.mock('../src/storage/local.storage', () => ({ LocalStorageAdapter: class {} }));

import { documentRouter } from '../src/modules/documents/document.router';
import { DocumentDeleteBlockedError, DocumentNotFoundError } from '../src/modules/documents/document.service';
import { AccountingPeriodClosedError } from '../src/modules/monthly-close/accounting-period.guard';

const app = express();
app.use(express.json());
app.use('/api', documentRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(500).json({ error: err instanceof Error ? err.message : 'error' }); });

const DOC = '11111111-1111-4111-8111-111111111111';
const grant = (capabilities: string[], activeCompanyId: string | null = 'co-a') => { mocks.context = { user: { id: 'u1' }, activeCompanyId, capabilities }; };
const del = (id = DOC) => request(app).delete(`/api/documents/${id}`).set('Origin', 'http://localhost').set('Host', 'localhost');

beforeEach(() => { mocks.context = null; mocks.deleteDocument.mockReset(); });

describe('DELETE /api/documents/:id', () => {
  it('rejects unauthenticated requests and users without document.delete (even with every other document capability)', async () => {
    expect((await del()).status).toBe(401);
    grant(['document.view', 'document.upload', 'document.edit', 'document.submit', 'document.review', 'document.approve']);
    expect((await del()).status).toBe(403);
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
  });

  it('deletes within the ACTIVE company only, as the acting user', async () => {
    grant(['document.delete']);
    mocks.deleteDocument.mockResolvedValue({ deleted: true, storage_cleanup: 'done' });
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, storage_cleanup: 'done', id: DOC });
    expect(mocks.deleteDocument).toHaveBeenCalledWith({ documentId: DOC, companyId: 'co-a', actorUserId: 'u1' });
  });

  it('reports a pending file cleanup without failing the delete', async () => {
    grant(['document.delete']);
    mocks.deleteDocument.mockResolvedValue({ deleted: true, storage_cleanup: 'pending' });
    expect((await del()).body.storage_cleanup).toBe('pending');
  });

  it('maps a document of another company (not found for the active company) to 404', async () => {
    grant(['document.delete'], 'co-b');
    mocks.deleteDocument.mockRejectedValue(new DocumentNotFoundError('x'));
    expect((await del()).status).toBe(404);
    expect(mocks.deleteDocument).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'co-b' }));
  });

  it('returns the specific blocking reason and dependency with 409', async () => {
    grant(['document.delete']);
    mocks.deleteDocument.mockRejectedValue(new DocumentDeleteBlockedError('invoice', 'invoice_source_links'));
    const res = await del();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'DOCUMENT_DELETE_BLOCKED', reason: 'invoice', dependency: 'invoice_source_links' });
  });

  it('maps a closed accounting period to 409 ACCOUNTING_PERIOD_CLOSED', async () => {
    grant(['document.delete']);
    mocks.deleteDocument.mockRejectedValue(new AccountingPeriodClosedError('closed'));
    const res = await del();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACCOUNTING_PERIOD_CLOSED');
  });

  it('rejects a malformed id before touching the service', async () => {
    grant(['document.delete']);
    expect((await del('not-a-uuid')).status).toBe(400);
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
  });
});
