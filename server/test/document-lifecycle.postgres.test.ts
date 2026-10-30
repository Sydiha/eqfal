import { randomUUID, createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { DocumentNotFoundError, DocumentService } from '../src/modules/documents/document.service';
import { DocumentChangeReasonRequiredError, DocumentFileReplaceError, findDuplicateMatches } from '../src/modules/documents/document-lifecycle';
import { StaleRevisionError } from '../src/shared/revision';
import type { StorageAdapter } from '../src/storage/storage.adapter';

// R6 document lifecycle against a real, disposable PostgreSQL (DATABASE_URL). Skipped without it.
const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('document lifecycle R6 (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const companyA = randomUUID(); const companyB = randomUUID(); const userId = randomUUID();
  const files = new Map<string, Buffer>();
  let failPut = false;
  const storage: StorageAdapter = {
    put: async (key, data) => { if (failPut) throw new Error('disk full'); files.set(key, data); },
    get: async (key) => files.get(key)!, delete: async (key) => { files.delete(key); },
  } as StorageAdapter;
  const service = new DocumentService(pool, storage);
  const created: string[] = [];
  const pdf = (text: string) => Buffer.from(`%PDF-1.7\n${text}`);

  beforeAll(async () => {
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'test-only')`, [userId, `r6-${userId}@example.test`]);
    for (const id of [companyA, companyB]) await pool.query(`INSERT INTO companies (id, slug, name) VALUES ($1, $2, 'R6')`, [id, `r6-${id}`]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM audit_log WHERE entity_id = ANY($1::uuid[])', [created]);
    await pool.query('DELETE FROM documents WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  });

  async function insert(companyId: string, fields: Record<string, unknown> = {}, content = randomUUID()): Promise<{ id: string; key: string }> {
    const id = randomUUID(); created.push(id); const key = `${companyId}/${id}`; const data = pdf(content);
    files.set(key, data);
    const row = { status: 'uploaded', ...fields };
    await pool.query(
      `INSERT INTO documents (id, company_id, uploaded_by_user_id, status, original_filename, mime_type, size_bytes, storage_key, sha256, reviewed_at, reference_number, counterparty_name, counterparty_id, document_date, total_amount, document_type)
       VALUES ($1,$2,$3,$4,'old.pdf','application/pdf',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, companyId, userId, row.status, data.length, key, createHash('sha256').update(data).digest('hex'), row['reviewed_at'] ?? null, row['reference_number'] ?? null, row['counterparty_name'] ?? null, row['counterparty_id'] ?? null, row['document_date'] ?? null, row['total_amount'] ?? null, row['document_type'] ?? null]);
    return { id, key };
  }
  const get = async (id: string) => (await pool.query('SELECT *, document_date::text FROM documents WHERE id = $1', [id])).rows[0]!;
  const audit = async (id: string, action: string) => (await pool.query('SELECT * FROM audit_log WHERE entity_id = $1 AND action = $2', [id, action])).rows;
  const base = { companyId: companyA, actorUserId: userId };

  describe('change reason on previously reviewed documents', () => {
    it('does not require a reason for a never-reviewed document', async () => {
      const { id } = await insert(companyA, { reference_number: 'A1' });
      const doc = await service.updateIntake({ ...base, documentId: id, intake: { reference_number: 'A2' }, expectedVersion: 1 });
      expect(doc.reference_number).toBe('A2');
    });
    it('requires a reason for a sensitive change after review, writes nothing without it, and audits it with old and new values', async () => {
      const { id } = await insert(companyA, { reference_number: 'R-1', reviewed_at: new Date(), status: 'uploaded' });
      await expect(service.updateIntake({ ...base, documentId: id, intake: { reference_number: 'R-2' }, expectedVersion: 1 })).rejects.toBeInstanceOf(DocumentChangeReasonRequiredError);
      await expect(service.updateIntake({ ...base, documentId: id, intake: { reference_number: 'R-2' }, expectedVersion: 1, changeReason: '   ' })).rejects.toBeInstanceOf(DocumentChangeReasonRequiredError);
      expect((await get(id)).reference_number).toBe('R-1');
      await service.updateIntake({ ...base, documentId: id, intake: { reference_number: 'R-2' }, expectedVersion: 1, changeReason: 'typo on invoice number' });
      const [entry] = await audit(id, 'document.intake_update');
      expect(entry.before_data).toEqual({ reference_number: 'R-1' });
      expect(entry.after_data).toEqual({ reference_number: 'R-2', change_reason: 'typo on invoice number' });
    });
    it('does not require a reason for the free-text note or an unchanged value', async () => {
      const { id } = await insert(companyA, { reference_number: 'N-1', reviewed_at: new Date() });
      await expect(service.updateIntake({ ...base, documentId: id, intake: { intake_note: 'fyi', reference_number: 'N-1' }, expectedVersion: 1 })).resolves.toMatchObject({ intake_note: 'fyi' });
    });
    it('stale revision is rejected before the reason check and nothing is written', async () => {
      const { id } = await insert(companyA, { reference_number: 'S-1', reviewed_at: new Date() });
      await service.updateIntake({ ...base, documentId: id, intake: { reference_number: 'S-2' }, expectedVersion: 1, changeReason: 'first' });
      await expect(service.updateIntake({ ...base, documentId: id, intake: { reference_number: 'S-3' }, expectedVersion: 1, changeReason: 'second' })).rejects.toBeInstanceOf(StaleRevisionError);
      expect((await get(id)).reference_number).toBe('S-2');
    });
  });

  describe('file replacement', () => {
    it('replaces the file, bumps the revision, keeps the old file and audits the previous one', async () => {
      const { id, key } = await insert(companyA);
      const next = pdf('new content');
      const doc = await service.replaceFile({ ...base, documentId: id, originalFilename: 'new.pdf', mimeType: 'application/pdf', data: next, expectedVersion: 1 });
      expect(doc).toMatchObject({ original_filename: 'new.pdf', sha256: createHash('sha256').update(next).digest('hex'), size_bytes: next.length, version: 2 });
      expect(doc.storage_key).not.toBe(key);
      expect(files.get(doc.storage_key)).toEqual(next);
      expect(files.has(key)).toBe(true);
      const [entry] = await audit(id, 'document.file_replace');
      expect(entry.before_data).toMatchObject({ original_filename: 'old.pdf', storage_key: key });
      expect(entry.after_data).toMatchObject({ original_filename: 'new.pdf', storage_key: doc.storage_key });
    });
    it('is allowed for an incomplete document, refused for needs_review, approved and rejected', async () => {
      const incomplete = await insert(companyA, { status: 'incomplete' });
      await expect(service.replaceFile({ ...base, documentId: incomplete.id, originalFilename: 'n.pdf', mimeType: 'application/pdf', data: pdf('x1'), expectedVersion: 1 })).resolves.toMatchObject({ status: 'incomplete' });
      for (const status of ['needs_review', 'approved', 'rejected']) {
        const { id, key } = await insert(companyA, { status });
        const err = await service.replaceFile({ ...base, documentId: id, originalFilename: 'n.pdf', mimeType: 'application/pdf', data: pdf(`x-${status}`), expectedVersion: 1 }).catch((e) => e);
        expect(err).toBeInstanceOf(DocumentFileReplaceError);
        expect(err.code).toBe('DOCUMENT_FILE_REPLACE_NOT_ALLOWED');
        expect((await get(id)).storage_key).toBe(key);
      }
    });
    it('rejects an identical file, a stale revision and a missing revision, writing nothing', async () => {
      const content = `same-${randomUUID()}`;
      const { id, key } = await insert(companyA, {}, content);
      const before = files.size;
      await expect(service.replaceFile({ ...base, documentId: id, originalFilename: 'n.pdf', mimeType: 'application/pdf', data: pdf(content), expectedVersion: 1 })).rejects.toMatchObject({ code: 'DOCUMENT_FILE_UNCHANGED' });
      await expect(service.replaceFile({ ...base, documentId: id, originalFilename: 'n.pdf', mimeType: 'application/pdf', data: pdf('other1'), expectedVersion: 9 })).rejects.toBeInstanceOf(StaleRevisionError);
      await expect(service.replaceFile({ ...base, documentId: id, originalFilename: 'n.pdf', mimeType: 'application/pdf', data: pdf('other2'), expectedVersion: null })).rejects.toMatchObject({ status: 428 });
      expect(files.size).toBe(before);
      expect((await get(id)).storage_key).toBe(key);
    });
    it('needs a reason once the document was reviewed', async () => {
      const { id } = await insert(companyA, { reviewed_at: new Date(), status: 'incomplete' });
      await expect(service.replaceFile({ ...base, documentId: id, originalFilename: 'n.pdf', mimeType: 'application/pdf', data: pdf('rv1'), expectedVersion: 1 })).rejects.toBeInstanceOf(DocumentChangeReasonRequiredError);
      const doc = await service.replaceFile({ ...base, documentId: id, originalFilename: 'n.pdf', mimeType: 'application/pdf', data: pdf('rv1'), expectedVersion: 1, changeReason: 'wrong scan' });
      expect(doc.version).toBe(2);
      expect((await audit(id, 'document.file_replace'))[0].after_data.change_reason).toBe('wrong scan');
    });
    it('cannot touch another company\'s document', async () => {
      const { id, key } = await insert(companyB);
      await expect(service.replaceFile({ ...base, documentId: id, originalFilename: 'n.pdf', mimeType: 'application/pdf', data: pdf('tenant'), expectedVersion: 1 })).rejects.toBeInstanceOf(DocumentNotFoundError);
      expect((await get(id)).storage_key).toBe(key);
    });
    it('storage failure leaves the document untouched; a database failure removes the new file', async () => {
      const { id, key } = await insert(companyA);
      failPut = true;
      await expect(service.replaceFile({ ...base, documentId: id, originalFilename: 'n.pdf', mimeType: 'application/pdf', data: pdf('fail1'), expectedVersion: 1 })).rejects.toThrow('disk full');
      failPut = false;
      expect((await get(id)).storage_key).toBe(key);
      // force the audit insert to fail: unknown actor violates the foreign key, so the transaction rolls back after the file was written
      const before = new Set(files.keys());
      await expect(service.replaceFile({ companyId: companyA, actorUserId: randomUUID(), documentId: id, originalFilename: 'n.pdf', mimeType: 'application/pdf', data: pdf('fail2'), expectedVersion: 1 })).rejects.toThrow();
      expect(new Set(files.keys())).toEqual(before);
      const after = await get(id);
      expect(after.storage_key).toBe(key);
      expect(after.version).toBe(1);
    });
  });

  describe('duplicate detection', () => {
    const probe = (documentId: string, over: Record<string, unknown> = {}) => ({ documentId, sha256: 'f'.repeat(64), counterparty_id: null, counterparty_name: 'ACME Co', reference_number: 'INV-100', ...over });
    it('matches same supplier + same normalized invoice number, inside one company only', async () => {
      const first = await insert(companyA, { counterparty_name: 'acme  co', reference_number: ' inv-100 ' });
      await insert(companyB, { counterparty_name: 'ACME Co', reference_number: 'INV-100' });
      const mine = await insert(companyA, { counterparty_name: 'ACME Co', reference_number: 'INV-100' });
      const matches = await findDuplicateMatches(pool, companyA, probe(mine.id));
      expect(matches.map((m) => m.id)).toEqual([first.id]);
      expect(matches[0]!.match).toBe('supplier_reference');
    });
    it('does not match a different supplier, a different number, a rejected document, or itself', async () => {
      const other = await insert(companyA, { counterparty_name: 'Other Co', reference_number: 'INV-200' });
      const rejected = await insert(companyA, { counterparty_name: 'Zed', reference_number: 'INV-300', status: 'rejected' });
      const self = await insert(companyA, { counterparty_name: 'Zed', reference_number: 'INV-300' });
      expect(await findDuplicateMatches(pool, companyA, probe(other.id, { counterparty_name: 'Other Co', reference_number: 'INV-201' }))).toEqual([]);
      expect(await findDuplicateMatches(pool, companyA, probe(self.id, { counterparty_name: 'Zed', reference_number: 'INV-300' }))).toEqual([]);
      expect(rejected.id).toBeTruthy();
      expect(await findDuplicateMatches(pool, companyA, probe(self.id, { counterparty_name: 'Nobody', reference_number: null }))).toEqual([]);
    });
    it('still reports an identical file (any status), and never across companies', async () => {
      const content = `dup-${randomUUID()}`;
      const a = await insert(companyA, { status: 'rejected' }, content);
      await insert(companyB, {}, content);
      const mine = await insert(companyA, {}, `mine-${randomUUID()}`);
      const sha = createHash('sha256').update(pdf(content)).digest('hex');
      const matches = await findDuplicateMatches(pool, companyA, { documentId: mine.id, sha256: sha, counterparty_id: null, counterparty_name: null, reference_number: null });
      expect(matches.map((m) => [m.id, m.match])).toEqual([[a.id, 'file']]);
    });
  });
});
