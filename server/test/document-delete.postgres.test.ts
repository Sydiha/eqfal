import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { DocumentFileCleanup } from '../src/modules/documents/document-file-cleanup';
import { DocumentDeleteBlockedError, DocumentNotFoundError, DocumentService } from '../src/modules/documents/document.service';
import type { StorageAdapter } from '../src/storage/storage.adapter';

// Delete & Void Phase 2 against a real, disposable PostgreSQL (DATABASE_URL). Skipped without it.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('document delete (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const companyA = randomUUID(); const companyB = randomUUID(); const userId = randomUUID();
  const removed: string[] = [];
  const storage: StorageAdapter = { put: async () => undefined, get: async () => Buffer.alloc(0), delete: vi.fn(async (key: string) => { removed.push(key); }) };
  const service = new DocumentService(pool, storage);
  const created: string[] = [];

  beforeAll(async () => {
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'test-only')`, [userId, `docdel-${userId}@example.test`]);
    for (const id of [companyA, companyB]) await pool.query(`INSERT INTO companies (id, slug, name) VALUES ($1, $2, 'Doc delete')`, [id, `docdel-${id}`]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM storage_deletion_queue WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM audit_log WHERE entity_id = ANY($1::uuid[])', [created]);
    await pool.query('DELETE FROM invoice_source_links WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM invoices WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM document_vat_reviews WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM documents WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  });

  async function insertDocument(companyId: string, status = 'uploaded'): Promise<string> {
    const id = randomUUID(); created.push(id);
    await pool.query(
      `INSERT INTO documents (id, company_id, uploaded_by_user_id, status, original_filename, mime_type, size_bytes, storage_key, sha256)
       VALUES ($1,$2,$3,$4,'d.pdf','application/pdf',1,$5,$6)`, [id, companyId, userId, status, `${companyId}/${id}`, 'a'.repeat(64)]);
    return id;
  }
  const exists = async (id: string) => (await pool.query('SELECT 1 FROM documents WHERE id = $1', [id])).rowCount === 1;
  const auditCount = async (id: string, action: string) => Number((await pool.query<{ n: string }>('SELECT COUNT(*) n FROM audit_log WHERE entity_id = $1 AND action = $2', [id, action])).rows[0]!.n);

  it('deletes an unprocessed document, audits it and removes the file', async () => {
    const id = await insertDocument(companyA);
    await expect(service.deleteDocument({ documentId: id, companyId: companyA, actorUserId: userId })).resolves.toEqual({ deleted: true, storage_cleanup: 'done' });
    expect(await exists(id)).toBe(false);
    expect(await auditCount(id, 'document.delete')).toBe(1);
    expect(removed).toContain(`${companyA}/${id}`);
  });

  it('cannot delete another company\'s document', async () => {
    const id = await insertDocument(companyB);
    await expect(service.deleteDocument({ documentId: id, companyId: companyA, actorUserId: userId })).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(await exists(id)).toBe(true);
  });

  it('refuses a document with a VAT review (catalog-discovered dependency) and changes nothing', async () => {
    const id = await insertDocument(companyA);
    await pool.query(`INSERT INTO document_vat_reviews (company_id, document_id, tax_date, recoverability_status) VALUES ($1,$2,'2026-10-01','needs_review')`, [companyA, id]);
    const error = await service.deleteDocument({ documentId: id, companyId: companyA, actorUserId: userId }).catch((e) => e);
    expect(error).toBeInstanceOf(DocumentDeleteBlockedError);
    expect(error).toMatchObject({ reason: 'vat_review', dependency: 'document_vat_reviews' });
    expect(await exists(id)).toBe(true);
    expect(await auditCount(id, 'document.delete')).toBe(0);
    expect(removed).not.toContain(`${companyA}/${id}`);
  });

  it('refuses a document attached to a draft invoice instead of cascading into the invoice link', async () => {
    const id = await insertDocument(companyA);
    const party = (await pool.query<{ id: string }>(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'Cust','customer',$2) RETURNING id`, [companyA, userId])).rows[0]!.id;
    const invoice = (await pool.query<{ id: string }>(
      `INSERT INTO invoices (company_id, direction, counterparty_id, issue_date, subtotal_amount, vat_amount, total_amount, created_by_user_id)
       VALUES ($1,'sales',$2,'2026-10-01',0,0,0,$3) RETURNING id`, [companyA, party, userId])).rows[0]!.id;
    await pool.query('INSERT INTO invoice_source_links (company_id, invoice_id, document_id, created_by_user_id) VALUES ($1,$2,$3,$4)', [companyA, invoice, id, userId]);
    await expect(service.deleteDocument({ documentId: id, companyId: companyA, actorUserId: userId })).rejects.toMatchObject({ reason: 'invoice', dependency: 'invoice_source_links' });
    expect(await exists(id)).toBe(true);
    expect((await pool.query('SELECT 1 FROM invoice_source_links WHERE document_id = $1', [id])).rowCount).toBe(1);
    await pool.query('DELETE FROM invoices WHERE id = $1', [invoice]);
    await pool.query('DELETE FROM counterparties WHERE id = $1', [party]);
  });

  it('refuses an approved document', async () => {
    const id = await insertDocument(companyA, 'approved');
    await expect(service.deleteDocument({ documentId: id, companyId: companyA, actorUserId: userId })).rejects.toMatchObject({ reason: 'approved' });
    expect(await exists(id)).toBe(true);
  });

  const queueRow = async (id: string) => (await pool.query<{ status: string; attempts: number }>('SELECT status, attempts FROM storage_deletion_queue WHERE document_id = $1', [id])).rows[0];

  it('storage failure leaves a durable pending entry; a later retry removes the file and completes it', async () => {
    const failing: StorageAdapter = { put: async () => undefined, get: async () => Buffer.alloc(0), delete: async () => { throw new Error('storage down'); } };
    const id = await insertDocument(companyA);
    const result = await new DocumentService(pool, failing).deleteDocument({ documentId: id, companyId: companyA, actorUserId: userId });
    expect(result).toEqual({ deleted: true, storage_cleanup: 'pending' });
    expect(await exists(id)).toBe(false);
    expect(await queueRow(id)).toMatchObject({ status: 'pending', attempts: 1 });
    // not yet due (backoff): the scheduler pass must not touch it
    await new DocumentFileCleanup(pool, storage).process();
    expect(removed).not.toContain(`${companyA}/${id}`);
    await pool.query('UPDATE storage_deletion_queue SET next_attempt_at = NOW() WHERE document_id = $1', [id]);
    expect(await new DocumentFileCleanup(pool, storage).process()).toMatchObject({ done: 1 });
    expect(removed).toContain(`${companyA}/${id}`);
    expect(await queueRow(id)).toMatchObject({ status: 'done' });
  });

  it('a retry never deletes a file whose key is referenced by a document again', async () => {
    const key = `${companyA}/${randomUUID()}`;
    const docId = randomUUID(); created.push(docId);
    await pool.query(
      `INSERT INTO documents (id, company_id, uploaded_by_user_id, original_filename, mime_type, size_bytes, storage_key, sha256)
       VALUES ($1,$2,$3,'r.pdf','application/pdf',1,$4,$5)`, [docId, companyA, userId, key, 'b'.repeat(64)]);
    await pool.query(`INSERT INTO storage_deletion_queue (company_id, document_id, storage_key) VALUES ($1,$2,$3)`, [companyA, randomUUID(), key]);
    await new DocumentFileCleanup(pool, storage).process();
    expect(removed).not.toContain(key);
    expect((await pool.query('SELECT status FROM storage_deletion_queue WHERE storage_key = $1', [key])).rows[0]).toMatchObject({ status: 'skipped' });
  });

  it('rejects a queue entry whose key is outside its company prefix', async () => {
    await expect(pool.query(`INSERT INTO storage_deletion_queue (company_id, document_id, storage_key) VALUES ($1,$2,$3)`, [companyA, randomUUID(), `${companyB}/x`])).rejects.toThrow();
  });
});
