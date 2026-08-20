import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { DocumentRepository } from '../src/modules/documents/document.repository';
import { DocumentReviewConflictError, DocumentService } from '../src/modules/documents/document.service';
import type { StorageAdapter } from '../src/storage/storage.adapter';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('Document approval with PostgreSQL DATE values', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const companyId = randomUUID();
  const uploaderId = randomUUID();
  const reviewerId = randomUUID();
  const documentIds: string[] = [];
  const storage: StorageAdapter = {
    put: async () => undefined,
    get: async () => Buffer.alloc(0),
    delete: async () => undefined,
  };

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO companies (id, slug, name)
       VALUES ($1, $2, 'Phase 8 VAT regression')`,
      [companyId, `phase8-vat-${companyId}`],
    );
    await pool.query(
      `INSERT INTO users (id, email, password_hash)
       VALUES ($1, $2, 'test-only'), ($3, $4, 'test-only')`,
      [uploaderId, `phase8-uploader-${uploaderId}@example.test`, reviewerId, `phase8-reviewer-${reviewerId}@example.test`],
    );
  });

  afterAll(async () => {
    if (documentIds.length) {
      await pool.query("DELETE FROM audit_log WHERE entity_type = 'document' AND entity_id = ANY($1::uuid[])", [documentIds]);
      await pool.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [documentIds]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[uploaderId, reviewerId]]);
    await pool.end();
  });

  async function insertDocument(documentDate: string | null, totalAmount: string | null): Promise<string> {
    const id = randomUUID();
    documentIds.push(id);
    await pool.query(
      `INSERT INTO documents
         (id, company_id, uploaded_by_user_id, status, original_filename, mime_type,
          size_bytes, storage_key, sha256, document_type, counterparty_name,
          document_date, reference_number, total_amount)
       VALUES
         ($1, $2, $3, 'needs_review', 'phase8-vat.pdf', 'application/pdf',
          1, $4, $5, 'purchase', 'Phase 8 VAT Valid', $6::date, 'P8-VAT-OK-001', $7::numeric)`,
      [id, companyId, uploaderId, `${companyId}/${id}`, 'a'.repeat(64), documentDate, totalAmount],
    );
    return id;
  }

  it('normalizes a real DATE and NUMERIC, then approves and records review metadata', async () => {
    const documentId = await insertDocument('2026-10-10', '115.00');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await new DocumentRepository(pool).findByIdForUpdate(documentId, companyId, client);
      expect(locked?.document_date).toBe('2026-10-10');
      expect(locked?.total_amount).toBe('115.00');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    await expect(new DocumentService(pool, storage).review({
      documentId, companyId, actorUserId: reviewerId, decision: 'approved', note: null,
    })).resolves.toMatchObject({ status: 'approved', document_date: '2026-10-10', total_amount: '115.00' });

    const { rows } = await pool.query(
      'SELECT status, reviewed_at, reviewed_by_user_id FROM documents WHERE id = $1 AND company_id = $2',
      [documentId, companyId],
    );
    expect(rows[0]).toMatchObject({ status: 'approved', reviewed_by_user_id: reviewerId });
    expect(rows[0]?.reviewed_at).toBeInstanceOf(Date);
  });

  it.each([
    ['document_date', null, '115.00'],
    ['total_amount', '2026-10-10', null],
  ] as const)('rejects approval when %s is NULL and leaves review state unchanged', async (_field, documentDate, totalAmount) => {
    const documentId = await insertDocument(documentDate, totalAmount);

    await expect(new DocumentService(pool, storage).review({
      documentId, companyId, actorUserId: reviewerId, decision: 'approved', note: null,
    })).rejects.toBeInstanceOf(DocumentReviewConflictError);

    const { rows } = await pool.query(
      'SELECT status, reviewed_at, reviewed_by_user_id FROM documents WHERE id = $1 AND company_id = $2',
      [documentId, companyId],
    );
    expect(rows[0]).toEqual({ status: 'needs_review', reviewed_at: null, reviewed_by_user_id: null });
  });
});
