import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTextPdf } from './helpers/pdf-fixture';

const mocks = vi.hoisted(() => ({
  context: null as null | { user: { id: string; email: string }; allowedCompanies: { id: string; name: string; name_ar: string | null }[]; activeCompanyId: string | null; capabilities: string[] },
  findById: vi.fn(), findDuplicatesBySha256: vi.fn(), readVerified: vi.fn(),
  upload: vi.fn(), updateIntake: vi.fn(), review: vi.fn(), submitReview: vi.fn(), poolQuery: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({ default: { query: mocks.poolQuery, connect: vi.fn() } }));
vi.mock('../src/config', () => ({ default: { documentStorageDir: '/tmp/eqfal-documents-test' } }));
vi.mock('../src/storage/integrity', () => ({ readVerified: mocks.readVerified }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => mocks.context),
  requireAuth: (_req: Request, res: Response, next: NextFunction) => mocks.context ? next() : void res.status(401).json({ error: 'Unauthenticated' }),
  requireActiveCompany: (_req: Request, res: Response, next: NextFunction) => mocks.context?.activeCompanyId ? next() : void res.status(403).json({ error: 'No active company' }),
  requireCapability: (capability: string) => (_req: Request, res: Response, next: NextFunction) => mocks.context?.capabilities.includes(capability) ? next() : void res.status(403).json({ error: 'Forbidden' }),
}));
vi.mock('../src/modules/documents/document.repository', () => ({
  DocumentRepository: class { findById = mocks.findById; findDuplicatesBySha256 = mocks.findDuplicatesBySha256; },
}));
vi.mock('../src/modules/documents/document.service', () => ({
  DocumentNotFoundError: class extends Error {}, DocumentReviewConflictError: class extends Error {}, DocumentDeleteBlockedError: class extends Error {},
  DocumentService: class { upload = mocks.upload; updateIntake = mocks.updateIntake; review = mocks.review; submitReview = mocks.submitReview; },
}));

import { documentRouter } from '../src/modules/documents/document.router';

const app = express();
app.use(express.json());
app.use('/api', documentRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(500).json({ error: err instanceof Error ? err.message : 'error' }); });

const ID = '11111111-1111-4111-8111-111111111111';
const pdf = buildTextPdf([[{ text: 'Invoice No: INV-9', x: 50, y: 700 }, { text: 'Grand Total 1,000.10', x: 50, y: 680 }]]);
const sha = createHash('sha256').update(pdf).digest('hex');
const doc = (over: Record<string, unknown> = {}) => ({ id: ID, company_id: 'co-a', mime_type: 'application/pdf', storage_key: 'co-a/k', sha256: sha, ...over });
const setContext = (capabilities: string[]) => { mocks.context = { user: { id: 'u1', email: 'u@example.com' }, allowedCompanies: [{ id: 'co-a', name: 'A', name_ar: null }], activeCompanyId: 'co-a', capabilities }; };
const upload = (header?: string) => {
  const r = request(app).post('/api/documents').set('Content-Type', 'application/pdf').set('X-File-Name', encodeURIComponent('invoice.pdf'));
  return (header ? r.set('X-Duplicate-Check', header) : r).send(pdf);
};

beforeEach(() => { vi.clearAllMocks(); setContext(['document.view', 'document.upload', 'document.edit']); });

describe('GET /documents/:id/suggestions', () => {
  it('returns editable suggestions without changing, posting or approving anything', async () => {
    mocks.findById.mockResolvedValue(doc());
    mocks.readVerified.mockResolvedValue(pdf);
    const res = await request(app).get(`/api/documents/${ID}/suggestions`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.status).toBe('ok');
    expect(res.body.fields.invoice_number).toEqual({ value: 'INV-9', state: 'found' });
    expect(res.body.fields.total_amount).toEqual({ value: '1000.10', state: 'found' });
    expect(res.body).not.toHaveProperty('text');
    expect(mocks.findById).toHaveBeenCalledWith(ID, 'co-a');
    expect(mocks.updateIntake).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.submitReview).not.toHaveBeenCalled();
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('denies users without document.edit', async () => {
    setContext(['document.view']);
    expect((await request(app).get(`/api/documents/${ID}/suggestions`)).status).toBe(403);
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('returns 404 for a document of another company (scoped lookup finds nothing)', async () => {
    mocks.findById.mockResolvedValue(null);
    const res = await request(app).get(`/api/documents/${ID}/suggestions`);
    expect(res.status).toBe(404);
    expect(mocks.findById).toHaveBeenCalledWith(ID, 'co-a');
    expect(mocks.readVerified).not.toHaveBeenCalled();
  });

  it('falls back to manual intake for images and scanned PDFs', async () => {
    mocks.findById.mockResolvedValue(doc({ mime_type: 'image/png' }));
    expect((await request(app).get(`/api/documents/${ID}/suggestions`)).body).toEqual({ status: 'unsupported', fields: null });
    mocks.findById.mockResolvedValue(doc());
    mocks.readVerified.mockResolvedValue(buildTextPdf([[]]));
    expect((await request(app).get(`/api/documents/${ID}/suggestions`)).body).toEqual({ status: 'no_text', fields: null });
  });
});

describe('POST /documents duplicate warning', () => {
  it('warns about an exact duplicate in the active company before storing it', async () => {
    mocks.findDuplicatesBySha256.mockResolvedValue([{ id: ID, original_filename: 'old.pdf', status: 'approved', created_at: '2024-01-01T00:00:00.000Z' }]);
    const res = await upload('warn');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOCUMENT_DUPLICATE');
    expect(res.body.duplicates).toHaveLength(1);
    expect(mocks.findDuplicatesBySha256).toHaveBeenCalledWith('co-a', sha);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('hides existing document metadata from uploaders without document.view', async () => {
    setContext(['document.upload']);
    mocks.findDuplicatesBySha256.mockResolvedValue([{ id: ID, original_filename: 'old.pdf', status: 'approved', created_at: '2024-01-01T00:00:00.000Z' }]);
    const res = await upload('warn');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'DOCUMENT_DUPLICATE', duplicate_count: 1, duplicates: [] });
  });

  it('stores the file when there is no duplicate, or when the user chose to continue', async () => {
    mocks.upload.mockResolvedValue({ id: ID });
    mocks.findDuplicatesBySha256.mockResolvedValue([]);
    expect((await upload('warn')).status).toBe(201);
    mocks.findDuplicatesBySha256.mockClear();
    expect((await upload('allow')).status).toBe(201);
    expect((await upload()).status).toBe(201);
    expect(mocks.findDuplicatesBySha256).not.toHaveBeenCalled();
    expect(mocks.upload).toHaveBeenCalledTimes(3);
  });

  it('keeps upload authorization ahead of the duplicate lookup', async () => {
    setContext(['document.view']);
    expect((await upload('warn')).status).toBe(403);
    expect(mocks.findDuplicatesBySha256).not.toHaveBeenCalled();
  });
});
