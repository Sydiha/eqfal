import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { DocumentFileCleanup } from '../src/modules/documents/document-file-cleanup';
import type { StorageAdapter } from '../src/storage/storage.adapter';

// Retry behaviour of the durable file-removal queue (SQL-level mock; real database coverage is in document-delete.postgres.test.ts).
let rows: { id: string; company_id: string; storage_key: string; attempts: number }[];
let referenced: boolean;
const updates: string[] = [];
const client = {
  release: vi.fn(),
  query: vi.fn(async (sql: string) => {
    const t = sql.replace(/\s+/g, ' ').trim();
    if (t.includes('FROM storage_deletion_queue')) return { rows, rowCount: rows.length };
    if (t.startsWith('SELECT 1 FROM documents')) return { rows: [], rowCount: referenced ? 1 : 0 };
    if (t.startsWith('UPDATE storage_deletion_queue')) updates.push(t);
    return { rows: [], rowCount: 0 };
  }),
} as unknown as PoolClient;
const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
const storage: StorageAdapter = { put: vi.fn(), get: vi.fn(), delete: vi.fn() };

beforeEach(() => {
  rows = [{ id: 'q1', company_id: 'co-a', storage_key: 'co-a/key-1', attempts: 0 }];
  referenced = false;
  updates.length = 0;
  vi.mocked(storage.delete).mockReset().mockResolvedValue();
});

describe('DocumentFileCleanup.process', () => {
  it('failure keeps the entry pending with a backoff, and a later retry succeeds and marks it done', async () => {
    vi.mocked(storage.delete).mockRejectedValueOnce(new Error('down'));
    const cleanup = new DocumentFileCleanup(pool, storage);
    expect(await cleanup.process()).toEqual({ done: 0, pending: 1, skipped: 0 });
    expect(updates[0]).toContain('next_attempt_at');
    expect(updates.some((u) => u.includes("status = 'done'"))).toBe(false);
    rows[0]!.attempts = 1; // the scheduler picks it up again once it is due
    expect(await cleanup.process()).toEqual({ done: 1, pending: 0, skipped: 0 });
    expect(updates.at(-1)).toContain("status = 'done'");
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(storage.delete).toHaveBeenLastCalledWith('co-a/key-1');
  });

  it('never deletes a key that is referenced by a document again', async () => {
    referenced = true;
    expect(await new DocumentFileCleanup(pool, storage).process()).toEqual({ done: 0, pending: 0, skipped: 1 });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(updates[0]).toContain("status = 'skipped'");
  });

  it('never deletes a key outside the queued company prefix', async () => {
    rows[0]!.storage_key = 'co-b/key-9';
    expect(await new DocumentFileCleanup(pool, storage).process()).toEqual({ done: 0, pending: 0, skipped: 1 });
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
