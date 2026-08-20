import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as null | {
    user: { id: string; email: string };
    allowedCompanies: { id: string; name: string; name_ar: string | null }[];
    activeCompanyId: string | null;
    capabilities: string[];
  },
  findByCompany: vi.fn(),
  findCounterpartiesByCompany: vi.fn(),
  findById: vi.fn(),
  upload: vi.fn(),
  review: vi.fn(),
  submitReview: vi.fn(),
  updateIntake: vi.fn(),
  storageGet: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../src/config', () => ({ default: { documentStorageDir: '/tmp/eqfal-documents-test' } }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => mocks.context),
  requireAuth: (_req: Request, res: Response, next: NextFunction) => mocks.context ? next() : void res.status(401).json({ error: 'Unauthenticated' }),
  requireActiveCompany: (_req: Request, res: Response, next: NextFunction) => mocks.context?.activeCompanyId ? next() : void res.status(403).json({ error: 'No active company' }),
  requireCapability: (capability: string) => (_req: Request, res: Response, next: NextFunction) => mocks.context?.capabilities.includes(capability) ? next() : void res.status(403).json({ error: 'Forbidden' }),
}));
vi.mock('../src/modules/documents/document.repository', () => ({
  DocumentRepository: class {
    findByCompany = mocks.findByCompany;
    findCounterpartiesByCompany = mocks.findCounterpartiesByCompany;
    findById = mocks.findById;
  },
}));
vi.mock('../src/modules/documents/document.service', () => ({
  DocumentNotFoundError: class extends Error {},
  DocumentReviewConflictError: class extends Error {},
  DocumentService: class { upload = mocks.upload; review = mocks.review; submitReview = mocks.submitReview; updateIntake = mocks.updateIntake; },
}));
vi.mock('../src/storage/local.storage', () => ({
  LocalStorageAdapter: class { get = mocks.storageGet; },
}));

import { documentRouter } from '../src/modules/documents/document.router';
import { DocumentNotFoundError, DocumentReviewConflictError } from '../src/modules/documents/document.service';

const app = express();
app.use(express.json());
app.use('/api', documentRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : 'error' });
});

const pdf = Buffer.from('%PDF-1.7\ncontent');
const document = {
  id: 'doc-1', company_id: 'co-a', uploaded_by_user_id: 'u1', status: 'uploaded',
  original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: pdf.length,
  storage_key: 'co-a/file-1', sha256: 'a'.repeat(64), reviewed_by_user_id: null, reviewed_at: null, review_note: null,
  created_at: new Date(), updated_at: new Date(),
  document_type: null, counterparty_id: null, counterparty_name: null, document_date: null, reference_number: null, total_amount: null, intake_note: null,
};

function setContext(capabilities: string[], companyId: string | null = 'co-a') {
  mocks.context = {
    user: { id: 'u1', email: 'u@example.com' },
    allowedCompanies: [{ id: 'co-a', name: 'Alpha', name_ar: null }],
    activeCompanyId: companyId,
    capabilities,
  };
}

function uploadRequest() {
  return request(app)
    .post('/api/documents')
    .set('Content-Type', 'application/pdf')
    .set('X-File-Name', encodeURIComponent('invoice.pdf'))
    .send(pdf);
}

describe('Document API security boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.context = null;
    mocks.findByCompany.mockReset();
    mocks.findCounterpartiesByCompany.mockReset().mockResolvedValue([]);
    mocks.findById.mockReset();
    mocks.upload.mockReset();
    mocks.review.mockReset();
    mocks.submitReview.mockReset();
    mocks.updateIntake.mockReset();
    mocks.storageGet.mockReset();
  });

  it('requires authentication and active company', async () => {
    expect((await request(app).get('/api/documents')).status).toBe(401);
    setContext(['document.view'], null);
    expect((await request(app).get('/api/documents')).status).toBe(403);
  });

  it('requires document capabilities', async () => {
    setContext([]);
    expect((await request(app).get('/api/documents')).status).toBe(403);
    expect((await uploadRequest()).status).toBe(403);
  });

  it('lists only the server-trusted active company', async () => {
    setContext(['document.view']);
    mocks.findByCompany.mockResolvedValue([document]);
    const res = await request(app).get('/api/documents');
    expect(res.status).toBe(200);
    expect(mocks.findByCompany).toHaveBeenCalledWith('co-a');
    expect(mocks.findCounterpartiesByCompany).toHaveBeenCalledWith('co-a');
  });

  it('rejects cross-origin uploads before writing', async () => {
    setContext(['document.upload']);
    const res = await uploadRequest().set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('rejects invalid file signatures and extensions', async () => {
    setContext(['document.upload']);
    const fakePdf = await request(app)
      .post('/api/documents')
      .set('Content-Type', 'application/pdf')
      .set('X-File-Name', encodeURIComponent('invoice.pdf'))
      .send(Buffer.from('not-a-pdf'));
    const wrongExtension = await request(app)
      .post('/api/documents')
      .set('Content-Type', 'application/pdf')
      .set('X-File-Name', encodeURIComponent('invoice.jpg'))
      .send(pdf);
    expect(fakePdf.status).toBe(400);
    expect(wrongExtension.status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('rejects files larger than 10 MB before writing', async () => {
    setContext(['document.upload']);
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20);
    oversized.write('%PDF-', 0, 'ascii');

    const res = await request(app)
      .post('/api/documents')
      .set('Content-Type', 'application/pdf')
      .set('X-File-Name', encodeURIComponent('large.pdf'))
      .send(oversized);

    expect(res.status).toBe(413);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('uploads only into active company with authenticated actor', async () => {
    setContext(['document.upload']);
    mocks.upload.mockResolvedValue(document);
    const res = await uploadRequest();
    expect(res.status).toBe(201);
    expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'co-a', actorUserId: 'u1', originalFilename: 'invoice.pdf', mimeType: 'application/pdf',
    }));
  });

  it('returns safe 404 for a document outside the active company', async () => {
    setContext(['document.view']);
    mocks.findById.mockResolvedValue(null);
    const res = await request(app).get('/api/documents/doc-other/file');
    expect(res.status).toBe(404);
    expect(mocks.findById).toHaveBeenCalledWith('doc-other', 'co-a');
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it('serves a company-scoped file only after metadata authorization', async () => {
    setContext(['document.view']);
    mocks.findById.mockResolvedValue(document);
    mocks.storageGet.mockResolvedValue(pdf);
    const res = await request(app).get('/api/documents/doc-1/file');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(mocks.storageGet).toHaveBeenCalledWith('co-a/file-1');
  });

  it('allows document.upload to submit an uploaded document for review', async () => {
    setContext(['document.upload']);
    mocks.submitReview.mockResolvedValue({ ...document, status: 'needs_review' });
    const res = await request(app).post('/api/documents/doc-1/submit-review').send();
    expect(res.status).toBe(200);
    expect(mocks.submitReview).toHaveBeenCalledWith({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u1' });
  });

  it('allows an uploader to edit intake using only the active company', async () => {
    setContext(['document.upload']); mocks.updateIntake.mockResolvedValue({ ...document, document_type: 'purchase' });
    const res = await request(app).patch('/api/documents/doc-1/intake').send({ document_type: 'purchase', company_id: 'co-other' });
    expect(res.status).toBe(400);
    const valid = await request(app).patch('/api/documents/doc-1/intake').send({ document_type: 'purchase', counterparty_id: '11111111-1111-4111-8111-111111111111', total_amount: 12.25 });
    expect(valid.status).toBe(200);
    expect(mocks.updateIntake).toHaveBeenCalledWith({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u1', intake: { document_type: 'purchase', counterparty_id: '11111111-1111-4111-8111-111111111111', total_amount: 12.25 } });
  });

  it('enforces intake capability, same origin, validation, 404, and conflict', async () => {
    setContext([]); expect((await request(app).patch('/api/documents/doc-1/intake').send({ intake_note: null })).status).toBe(403);
    setContext(['document.upload']);
    expect((await request(app).patch('/api/documents/doc-1/intake').set('Origin', 'https://evil.example').send({ intake_note: null })).status).toBe(403);
    for (const body of [{ document_type: 'invoice' }, { document_date: '2026-02-30' }, { total_amount: 0 }, { total_amount: -1 }, { counterparty_name: 'x'.repeat(201) }, { reference_number: 'x'.repeat(101) }, { intake_note: 'x'.repeat(501) }]) {
      expect((await request(app).patch('/api/documents/doc-1/intake').send(body)).status).toBe(400);
    }
    mocks.updateIntake.mockRejectedValueOnce(new DocumentNotFoundError());
    expect((await request(app).patch('/api/documents/missing/intake').send({ intake_note: null })).status).toBe(404);
    mocks.updateIntake.mockRejectedValue(new DocumentReviewConflictError());
    expect((await request(app).patch('/api/documents/doc-1/intake').send({ intake_note: null })).status).toBe(409);
  });

  it('requires document.upload and same origin to submit for review', async () => {
    setContext([]);
    expect((await request(app).post('/api/documents/doc-1/submit-review')).status).toBe(403);
    setContext(['document.upload']);
    expect((await request(app).post('/api/documents/doc-1/submit-review').set('Origin', 'https://evil.example')).status).toBe(403);
    expect(mocks.submitReview).not.toHaveBeenCalled();
  });

  it('does not let document.review approve, but lets document.approve approve', async () => {
    setContext(['document.review']);
    expect((await request(app).post('/api/documents/doc-1/review').send({ decision: 'approved' })).status).toBe(403);
    setContext(['document.approve']);
    mocks.review.mockResolvedValue({ ...document, status: 'approved' });
    expect((await request(app).post('/api/documents/doc-1/review').send({ decision: 'approved' })).status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approved', note: null }));
  });

  it('allows document.review to mark needs-review documents incomplete or rejected', async () => {
    setContext(['document.review']);
    mocks.review.mockResolvedValue({ ...document, status: 'incomplete' });
    expect((await request(app).post('/api/documents/doc-1/review').send({ decision: 'incomplete', note: 'Missing page' })).status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ decision: 'incomplete', note: 'Missing page' }));
  });

  it('rejects needs_review decisions, missing reasons, and notes over 500 characters', async () => {
    setContext(['document.review']);
    expect((await request(app).post('/api/documents/doc-1/review').send({ decision: 'needs_review' })).status).toBe(400);
    expect((await request(app).post('/api/documents/doc-1/review').send({ decision: 'incomplete' })).status).toBe(400);
    expect((await request(app).post('/api/documents/doc-1/review').send({ decision: 'rejected', note: ' ' })).status).toBe(400);
    expect((await request(app).post('/api/documents/doc-1/review').send({ decision: 'incomplete', note: 'x'.repeat(501) })).status).toBe(400);
  });

  it('returns conflict for an invalid transition and safe 404 across companies', async () => {
    setContext(['document.upload']);
    mocks.submitReview.mockRejectedValueOnce(new DocumentReviewConflictError());
    expect((await request(app).post('/api/documents/doc-1/submit-review')).status).toBe(409);
    mocks.submitReview.mockRejectedValueOnce(new DocumentNotFoundError());
    expect((await request(app).post('/api/documents/doc-other/submit-review')).status).toBe(404);
  });

  it('rejects cross-origin review mutations', async () => {
    setContext(['document.review']);
    const res = await request(app).post('/api/documents/doc-1/review').set('Origin', 'https://evil.example').send({ decision: 'rejected', note: 'Duplicate' });
    expect(res.status).toBe(403);
    expect(mocks.review).not.toHaveBeenCalled();
  });
});
