import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { DocumentRepository } from '../src/modules/documents/document.repository';

describe('DocumentRepository intake locking', () => {
  it('looks up the document by company and id with FOR UPDATE', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
    await new DocumentRepository({} as Pool).findByIdForUpdate('doc-1', 'co-a', client);
    expect(client.query).toHaveBeenCalledWith(expect.stringMatching(/WHERE id = \$1 AND company_id = \$2 FOR UPDATE/), ['doc-1', 'co-a']);
  });
});
