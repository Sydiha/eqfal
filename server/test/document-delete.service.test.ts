import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { DocumentDeleteBlockedError, DocumentNotFoundError, DocumentService } from '../src/modules/documents/document.service';
import type { StorageAdapter } from '../src/storage/storage.adapter';

// Delete & Void Phase 2: transactional behaviour of DocumentService.deleteDocument (SQL-level mock; real-database coverage is document-delete.postgres.test.ts).
const calls: string[] = [];
let documentRow: Record<string, unknown> | null;
let fks: { tbl: string; pairs: { col: string; ref: string }[] }[];
let referenced: Set<string>;

const client = {
  release: vi.fn(),
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    calls.push(text.split(' ').slice(0, 3).join(' '));
    if (text.startsWith('SELECT *, document_date::text FROM documents')) {
      // company scoping: the row is only visible to its own company
      return { rows: documentRow && params?.[1] === documentRow['company_id'] ? [documentRow] : [], rowCount: 1 };
    }
    if (text.includes('FROM pg_constraint')) return { rows: fks, rowCount: fks.length };
    if (text.startsWith('SELECT 1 FROM')) {
      const table = text.split(' ')[3]!;
      return { rows: [], rowCount: referenced.has(table) ? 1 : 0 };
    }
    if (text.startsWith('DELETE FROM documents')) return { rows: [], rowCount: 1 };
    if (text.startsWith('INSERT INTO audit_log')) return { rows: [{ id: 'a1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
} as unknown as PoolClient;
const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
const storage: StorageAdapter = { put: vi.fn(), get: vi.fn(), delete: vi.fn() };
const input = { documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u1' };

const auditActions = () => vi.mocked(client.query).mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO audit_log')).map(([, params]) => (params as unknown[])[2]);
const deleted = () => vi.mocked(client.query).mock.calls.some(([sql]) => String(sql).includes('DELETE FROM documents'));

beforeEach(() => {
  calls.length = 0;
  documentRow = { id: 'doc-1', company_id: 'co-a', status: 'uploaded', original_filename: 'a.pdf', mime_type: 'application/pdf', size_bytes: 8, storage_key: 'co-a/key-1', sha256: 'a'.repeat(64), document_type: null, document_date: null, reference_number: null, total_amount: null, uploaded_by_user_id: 'u1' };
  fks = [
    { tbl: 'invoice_source_links', pairs: [{ col: 'document_id', ref: 'id' }, { col: 'company_id', ref: 'company_id' }] },
    { tbl: 'obligations', pairs: [{ col: 'document_id', ref: 'id' }, { col: 'company_id', ref: 'company_id' }] },
    { tbl: 'brand_new_table', pairs: [{ col: 'doc', ref: 'id' }, { col: 'company_id', ref: 'company_id' }] },
  ];
  referenced = new Set();
  vi.mocked(client.query).mockClear();
  vi.mocked(client.release).mockClear();
  vi.mocked(storage.delete).mockReset().mockResolvedValue();
});

const service = () => new DocumentService(pool, storage);

describe('DocumentService.deleteDocument', () => {
  it('deletes the row, writes the audit snapshot in the same transaction, then removes the file', async () => {
    const result = await service().deleteDocument(input);
    expect(result).toEqual({ deleted: true, storage_cleanup: 'done' });
    expect(calls.indexOf('BEGIN')).toBeLessThan(calls.findIndex((c) => c === 'DELETE FROM documents'));
    expect(auditActions()).toEqual(['document.delete']);
    const audit = vi.mocked(client.query).mock.calls.find(([sql]) => String(sql).includes('INSERT INTO audit_log'))![1] as unknown[];
    expect(JSON.stringify(audit)).toContain('co-a/key-1'); // storage_key kept for traceability
    expect(calls.lastIndexOf('COMMIT')).toBeGreaterThan(calls.findIndex((c) => c === 'DELETE FROM documents'));
    expect(storage.delete).toHaveBeenCalledWith('co-a/key-1');
  });

  it('is company-scoped: another company cannot see or delete the document', async () => {
    await expect(service().deleteDocument({ ...input, companyId: 'co-b' })).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(deleted()).toBe(false);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(calls).toContain('ROLLBACK');
  });

  it.each([
    ['invoice_source_links', 'invoice'],
    ['obligations', 'obligation'],
    ['brand_new_table', 'other'],
  ])('refuses when %s references the document, naming the reason (%s), without deleting anything', async (table, reason) => {
    referenced.add(table);
    const error = await service().deleteDocument(input).catch((e) => e);
    expect(error).toBeInstanceOf(DocumentDeleteBlockedError);
    expect(error).toMatchObject({ reason, dependency: table });
    expect(deleted()).toBe(false);
    expect(auditActions()).toEqual([]);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(calls).toContain('ROLLBACK');
  });

  it('refuses an approved document', async () => {
    documentRow!['status'] = 'approved';
    await expect(service().deleteDocument(input)).rejects.toMatchObject({ reason: 'approved' });
    expect(deleted()).toBe(false);
  });

  it('keeps the database consistent when file removal fails: row gone, failure audited for manual cleanup', async () => {
    vi.mocked(storage.delete).mockRejectedValue(new Error('object store down'));
    const result = await service().deleteDocument(input);
    expect(result).toEqual({ deleted: true, storage_cleanup: 'pending' });
    expect(deleted()).toBe(true);
    expect(auditActions()).toEqual(['document.delete', 'document.delete_file_pending']);
  });

  it('does not delete the file when the transaction fails', async () => {
    vi.mocked(client.query).mockImplementationOnce(async () => ({ rows: [], rowCount: 0 })); // BEGIN
    vi.mocked(client.query).mockImplementationOnce(async () => { throw new Error('db down'); });
    await expect(service().deleteDocument(input)).rejects.toThrow('db down');
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
