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
  findById: vi.fn(),
  upload: vi.fn(),
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
    findById = mocks.findById;
  },
}));
vi.mock('../src/modules/documents/document.service', () => ({
  DocumentService: class { upload = mocks.upload; },
}));
vi.mock('../src/storage/local.storage', () => ({
  LocalStorageAdapter: class { get = mocks.storageGet; },
}));

import { documentRouter } from '../src/modules/documents/document.router';

const app = express();
app.use('/api', documentRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : 'error' });
});

const pdf = Buffer.from('%PDF-1.7\ncontent');
const document = {
  id: 'doc-1', company_id: 'co-a', uploaded_by_user_id: 'u1', status: 'uploaded',
  original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: pdf.length,
  storage_key: 'co-a/file-1', sha256: 'a'.repeat(64), created_at: new Date(), updated_at: new Date(),
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
    mocks.findById.mockReset();
    mocks.upload.mockReset();
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
});
