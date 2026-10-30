import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as null | { user: { id: string }; allowedCompanies: unknown[]; activeCompanyId: string | null; capabilities: string[] },
  findById: vi.fn(), replaceFile: vi.fn(), updateIntake: vi.fn(), submitReview: vi.fn(), query: vi.fn(),
}));
vi.mock('../src/db/pool', () => ({ default: { query: (...args: unknown[]) => mocks.query(...args), connect: vi.fn() } }));
vi.mock('../src/config', () => ({ default: { documentStorageDir: '/tmp/eqfal-documents-test' } }));
vi.mock('../src/modules/auth/origin.middleware', () => ({ requireSameOrigin: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => mocks.context),
  requireAuth: (_req: Request, res: Response, next: NextFunction) => mocks.context ? next() : void res.status(401).json({ error: 'Unauthenticated' }),
  requireActiveCompany: (_req: Request, res: Response, next: NextFunction) => mocks.context?.activeCompanyId ? next() : void res.status(403).json({ error: 'No active company' }),
  requireCapability: (capability: string) => (_req: Request, res: Response, next: NextFunction) => mocks.context?.capabilities.includes(capability) ? next() : void res.status(403).json({ error: 'Forbidden' }),
}));
vi.mock('../src/modules/documents/document.repository', () => ({ DocumentRepository: class { findById = mocks.findById; } }));
vi.mock('../src/modules/documents/document.service', () => ({
  DocumentNotFoundError: class extends Error {},
  DocumentReviewConflictError: class extends Error { code = 'DOCUMENT_STATE_CONFLICT'; },
  DocumentDeleteBlockedError: class extends Error {},
  DocumentService: class { replaceFile = mocks.replaceFile; updateIntake = mocks.updateIntake; submitReview = mocks.submitReview; },
}));
vi.mock('../src/storage/local.storage', () => ({ LocalStorageAdapter: class { get = vi.fn(); } }));

import { documentRouter } from '../src/modules/documents/document.router';
import { DocumentChangeReasonRequiredError, DocumentFileReplaceError } from '../src/modules/documents/document-lifecycle';
import { StaleRevisionError } from '../src/shared/revision';

const app = express();
app.use(express.json());
app.use('/api', documentRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => void res.status(500).json({ error: err instanceof Error ? err.message : 'error' }));

const ID = '3f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const pdf = Buffer.from('%PDF-1.7\nnew');
const doc = { id: ID, company_id: 'c1', sha256: 'a'.repeat(64), counterparty_id: null, counterparty_name: 'ACME', reference_number: 'INV-1', version: 2 };
const dupRow = { id: 'x', original_filename: 'o.pdf', status: 'approved', match: 'supplier_reference' };
const put = (over: Record<string, string> = {}) => request(app).put(`/api/documents/${ID}/file`).set({ 'content-type': 'application/pdf', 'x-file-name': 'n.pdf', 'if-match': '1', ...over }).send(pdf);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context = { user: { id: 'u1' }, allowedCompanies: [], activeCompanyId: 'c1', capabilities: ['document.view', 'document.edit', 'document.submit'] };
  mocks.query.mockResolvedValue({ rows: [] });
});

describe('PUT /documents/:id/file', () => {
  it('requires document.edit', async () => {
    mocks.context!.capabilities = ['document.view', 'document.upload'];
    expect((await put()).status).toBe(403);
    expect(mocks.replaceFile).not.toHaveBeenCalled();
  });
  it('validates the upload like POST /documents', async () => {
    expect((await put({ 'x-file-name': 'n.exe' })).status).toBe(400);
    expect((await request(app).put(`/api/documents/${ID}/file`).set({ 'content-type': 'application/pdf', 'x-file-name': 'n.pdf' }).send(Buffer.from('not a pdf'))).status).toBe(400);
    expect((await request(app).put('/api/documents/not-a-uuid/file').set({ 'content-type': 'application/pdf', 'x-file-name': 'n.pdf' }).send(pdf)).status).toBe(404);
    expect(mocks.replaceFile).not.toHaveBeenCalled();
  });
  it('passes company, revision and reason to the service and returns duplicate warnings', async () => {
    mocks.replaceFile.mockResolvedValue(doc);
    mocks.query.mockResolvedValue({ rows: [dupRow] });
    const res = await put({ 'x-change-reason': encodeURIComponent('wrong scan') });
    expect(res.status).toBe(200);
    expect(mocks.replaceFile).toHaveBeenCalledWith(expect.objectContaining({ documentId: ID, companyId: 'c1', actorUserId: 'u1', expectedVersion: 1, changeReason: 'wrong scan' }));
    expect(res.body.duplicate_warnings).toHaveLength(1);
    expect(mocks.query.mock.calls[0]![1][0]).toBe('c1');
  });
  it('maps lifecycle errors to actionable codes', async () => {
    for (const [error, status, code] of [
      [new StaleRevisionError('DOCUMENT_VERSION_CONFLICT'), 409, 'DOCUMENT_VERSION_CONFLICT'],
      [new StaleRevisionError('REVISION_REQUIRED', 428), 428, 'REVISION_REQUIRED'],
      [new DocumentChangeReasonRequiredError(), 400, 'DOCUMENT_CHANGE_REASON_REQUIRED'],
      [new DocumentFileReplaceError('DOCUMENT_FILE_REPLACE_NOT_ALLOWED'), 409, 'DOCUMENT_FILE_REPLACE_NOT_ALLOWED'],
      [new DocumentFileReplaceError('DOCUMENT_FILE_UNCHANGED'), 409, 'DOCUMENT_FILE_UNCHANGED'],
    ] as const) {
      mocks.replaceFile.mockRejectedValueOnce(error);
      const res = await put();
      expect([res.status, res.body.code]).toEqual([status, code]);
    }
  });
  it('hides duplicate details from callers without document.view', async () => {
    mocks.context!.capabilities = ['document.edit'];
    mocks.replaceFile.mockResolvedValue(doc);
    mocks.query.mockResolvedValue({ rows: [dupRow] });
    expect((await put()).body.duplicate_warnings).toBeUndefined();
  });
});

describe('PATCH intake change_reason', () => {
  it('forwards change_reason separately from the intake fields and answers 400 when the service demands one', async () => {
    mocks.updateIntake.mockResolvedValue(doc);
    const ok = await request(app).patch(`/api/documents/${ID}/intake`).set('if-match', '2').send({ reference_number: 'X', change_reason: ' typo ' });
    expect(ok.status).toBe(200);
    expect(mocks.updateIntake).toHaveBeenCalledWith(expect.objectContaining({ intake: { reference_number: 'X' }, changeReason: 'typo' }));
    mocks.updateIntake.mockRejectedValueOnce(new DocumentChangeReasonRequiredError());
    const missing = await request(app).patch(`/api/documents/${ID}/intake`).set('if-match', '2').send({ reference_number: 'Y' });
    expect([missing.status, missing.body.code]).toEqual([400, 'DOCUMENT_CHANGE_REASON_REQUIRED']);
  });
  it('rejects a body with only change_reason, or an oversized or non-string reason', async () => {
    for (const body of [{ change_reason: 'x' }, { reference_number: 'X', change_reason: 'a'.repeat(501) }, { reference_number: 'X', change_reason: 5 }]) {
      expect((await request(app).patch(`/api/documents/${ID}/intake`).set('if-match', '2').send(body)).status).toBe(400);
    }
    expect(mocks.updateIntake).not.toHaveBeenCalled();
  });
});

describe('submit-review duplicate warning', () => {
  it('is opt-in: without duplicate_check the previous behaviour is unchanged', async () => {
    mocks.submitReview.mockResolvedValue(doc);
    expect((await request(app).post(`/api/documents/${ID}/submit-review`).send({})).status).toBe(200);
    expect(mocks.findById).not.toHaveBeenCalled();
  });
  it('answers 409 with the matches, and proceeds with an audited reason', async () => {
    mocks.findById.mockResolvedValue(doc);
    mocks.query.mockResolvedValue({ rows: [dupRow] });
    const warned = await request(app).post(`/api/documents/${ID}/submit-review`).send({ duplicate_check: 'warn' });
    expect([warned.status, warned.body.code, warned.body.duplicate_count]).toEqual([409, 'DOCUMENT_DUPLICATE_SUSPECTED', 1]);
    expect(mocks.submitReview).not.toHaveBeenCalled();
    mocks.submitReview.mockResolvedValue(doc);
    const confirmed = await request(app).post(`/api/documents/${ID}/submit-review`).send({ duplicate_check: 'warn', duplicate_reason: 'credit note' });
    expect(confirmed.status).toBe(200);
    expect(mocks.submitReview).toHaveBeenCalledWith(expect.objectContaining({ duplicateReason: 'credit note' }));
  });
  it('submits normally when nothing matches', async () => {
    mocks.findById.mockResolvedValue(doc);
    mocks.submitReview.mockResolvedValue(doc);
    expect((await request(app).post(`/api/documents/${ID}/submit-review`).send({ duplicate_check: 'warn' })).status).toBe(200);
  });
});

describe('GET /documents/:id/duplicates', () => {
  it('needs document.view and is scoped to the active company', async () => {
    mocks.context!.capabilities = ['document.edit'];
    expect((await request(app).get(`/api/documents/${ID}/duplicates`)).status).toBe(403);
    mocks.context!.capabilities = ['document.view'];
    mocks.findById.mockResolvedValue(null);
    expect((await request(app).get(`/api/documents/${ID}/duplicates`)).status).toBe(404);
    expect(mocks.findById).toHaveBeenCalledWith(ID, 'c1');
    mocks.findById.mockResolvedValue(doc);
    mocks.query.mockResolvedValue({ rows: [dupRow] });
    expect((await request(app).get(`/api/documents/${ID}/duplicates`)).body.duplicates).toHaveLength(1);
  });
});
