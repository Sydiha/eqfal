import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { DocumentService } from '../src/modules/documents/document.service';
import { DocumentRepository } from '../src/modules/documents/document.repository';
import { AuditLogRepository } from '../src/modules/audit-log/audit-log.repository';
import type { StorageAdapter } from '../src/storage/storage.adapter';

const client = {
  query: vi.fn(),
  release: vi.fn(),
} as unknown as PoolClient;

const pool = {
  connect: vi.fn().mockResolvedValue(client),
} as unknown as Pool;

const storage: StorageAdapter = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

const record = {
  id: 'doc-1',
  company_id: 'co-a',
  uploaded_by_user_id: 'u1',
  status: 'uploaded' as const,
  original_filename: 'invoice.pdf',
  mime_type: 'application/pdf',
  size_bytes: 8,
  storage_key: 'co-a/key',
  sha256: 'a'.repeat(64),
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(storage.put).mockReset().mockResolvedValue();
  vi.mocked(storage.delete).mockReset().mockResolvedValue();
  vi.mocked(storage.get).mockReset();
  vi.mocked(client.query).mockReset().mockResolvedValue({ rows: [], rowCount: 0 } as never);
  vi.mocked(client.release).mockReset();
  vi.mocked(pool.connect).mockClear();
});

describe('DocumentService upload consistency', () => {
  it('does not create DB metadata when storage write fails', async () => {
    vi.mocked(storage.put).mockRejectedValue(new Error('storage down'));
    const create = vi.spyOn(DocumentRepository.prototype, 'create');

    await expect(new DocumentService(pool, storage).upload({
      companyId: 'co-a', actorUserId: 'u1', originalFilename: 'invoice.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-x'),
    })).rejects.toThrow('storage down');

    expect(create).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('removes the stored file when the DB transaction fails', async () => {
    vi.spyOn(DocumentRepository.prototype, 'create').mockRejectedValue(new Error('db failed'));

    await expect(new DocumentService(pool, storage).upload({
      companyId: 'co-a', actorUserId: 'u1', originalFilename: 'invoice.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-x'),
    })).rejects.toThrow('db failed');

    expect(storage.put).toHaveBeenCalledOnce();
    expect(storage.delete).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('writes metadata and audit in one transaction after storage succeeds', async () => {
    vi.spyOn(DocumentRepository.prototype, 'create').mockResolvedValue(record);
    vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue({} as never);

    const result = await new DocumentService(pool, storage).upload({
      companyId: 'co-a', actorUserId: 'u1', originalFilename: 'invoice.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-x'),
    });

    expect(result).toBe(record);
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
