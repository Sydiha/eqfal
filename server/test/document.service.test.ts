import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { DocumentReviewConflictError, DocumentService } from '../src/modules/documents/document.service';
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
  reviewed_by_user_id: null,
  reviewed_at: null,
  review_note: null,
  created_at: new Date(),
  updated_at: new Date(),
  document_type: null, counterparty_id: null, counterparty_name: null, document_date: null, reference_number: null, total_amount: null, intake_note: null,
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

describe('DocumentService review workflow', () => {
  it.each(['sale', 'purchase', 'expense'] as const)('does not submit %s without a valid company counterparty', async document_type => {
    const uploaded = { ...record, document_type, counterparty_id: null };
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(uploaded);
    const submit = vi.spyOn(DocumentRepository.prototype, 'submitForReview');
    await expect(new DocumentService(pool, storage).submitReview({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2' })).rejects.toMatchObject({ code: 'DOCUMENT_COUNTERPARTY_INVALID' });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ['purchase', 'supplier'],
    ['expense', 'supplier'],
    ['sale', 'customer'],
  ] as const)('does not submit %s unless its counterparty is a %s', async (document_type, expectedType) => {
    const uploaded = { ...record, document_type, counterparty_id: 'cp-1' };
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(uploaded);
    const submit = vi.spyOn(DocumentRepository.prototype, 'submitForReview');
    await expect(new DocumentService(pool, storage).submitReview({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2' })).rejects.toMatchObject({ code: 'DOCUMENT_COUNTERPARTY_INVALID' });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('type = $3'), ['cp-1', 'co-a', expectedType]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits a purchase linked to a supplier', async () => {
    const uploaded = { ...record, document_type: 'purchase' as const, counterparty_id: 'cp-supplier' };
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(uploaded);
    vi.spyOn(DocumentRepository.prototype, 'submitForReview').mockResolvedValue({ ...uploaded, status: 'needs_review' });
    vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue({} as never);
    vi.mocked(client.query).mockImplementation(async sql => String(sql).startsWith('SELECT 1 FROM counterparties') ? { rows: [{ one: 1 }], rowCount: 1 } as never : { rows: [], rowCount: 0 } as never);

    await expect(new DocumentService(pool, storage).submitReview({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2' })).resolves.toMatchObject({ status: 'needs_review' });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('type = $3'), ['cp-supplier', 'co-a', 'supplier']);
  });

  it('allows other documents to submit without a counterparty', async () => {
    const uploaded = { ...record, document_type: 'other' as const, counterparty_id: null };
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(uploaded);
    vi.spyOn(DocumentRepository.prototype, 'submitForReview').mockResolvedValue({ ...uploaded, status: 'needs_review' });
    await expect(new DocumentService(pool, storage).submitReview({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2' })).resolves.toMatchObject({ status: 'needs_review' });
  });

  it.each([
    ['document_date', { document_date: null, total_amount: '100.00' }],
    ['total_amount', { document_date: '2026-08-01', total_amount: null }],
  ] as const)('does not approve a VAT-eligible document without a valid %s', async (_field, intake) => {
    const needsReview = { ...record, status: 'needs_review' as const, document_type: 'purchase' as const, ...intake };
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(needsReview);
    const updateReview = vi.spyOn(DocumentRepository.prototype, 'updateReview');

    await expect(new DocumentService(pool, storage).review({
      documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', decision: 'approved', note: null,
    })).rejects.toMatchObject({ code: 'DOCUMENT_APPROVAL_DATA_INCOMPLETE' });

    expect(updateReview).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('approves a VAT-eligible document with a valid document date, total amount, and counterparty role', async () => {
    const needsReview = { ...record, status: 'needs_review' as const, document_type: 'sale' as const, counterparty_id: 'cp-1', document_date: '2026-08-01', total_amount: '100.00' };
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(needsReview);
    const updateReview = vi.spyOn(DocumentRepository.prototype, 'updateReview').mockResolvedValue({ ...needsReview, status: 'approved' });
    vi.mocked(client.query).mockImplementation(async sql => String(sql).startsWith('SELECT 1 FROM counterparties') ? { rows: [{ one: 1 }], rowCount: 1 } as never : { rows: [], rowCount: 0 } as never);

    await expect(new DocumentService(pool, storage).review({
      documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', decision: 'approved', note: null,
    })).resolves.toMatchObject({ status: 'approved' });

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('type = $3'), ['cp-1', 'co-a', 'customer']);
    expect(updateReview).toHaveBeenCalledOnce();
  });

  it('does not impose VAT fields on a non-VAT-eligible document', async () => {
    const needsReview = { ...record, status: 'needs_review' as const, document_type: 'other' as const };
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(needsReview);
    vi.spyOn(DocumentRepository.prototype, 'updateReview').mockResolvedValue({ ...needsReview, status: 'approved' });

    await expect(new DocumentService(pool, storage).review({
      documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', decision: 'approved', note: null,
    })).resolves.toMatchObject({ status: 'approved' });
  });

  it('independently rejects approval when an operational counterparty has the wrong role or is outside the company', async () => {
    const needsReview = { ...record, status: 'needs_review' as const, document_type: 'purchase' as const, counterparty_id: 'cp-other', document_date: '2026-08-01', total_amount: '100.00' };
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(needsReview);
    const updateReview = vi.spyOn(DocumentRepository.prototype, 'updateReview');
    await expect(new DocumentService(pool, storage).review({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', decision: 'approved', note: null })).rejects.toMatchObject({ code: 'DOCUMENT_COUNTERPARTY_INVALID' });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('type = $3'), ['cp-other', 'co-a', 'supplier']);
    expect(updateReview).not.toHaveBeenCalled();
  });

  it('submits an uploaded document with the dedicated audit action without review metadata', async () => {
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(record);
    const submitForReview = vi.spyOn(DocumentRepository.prototype, 'submitForReview').mockResolvedValue({ ...record, status: 'needs_review' });
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue({} as never);

    const result = await new DocumentService(pool, storage).submitReview({
      documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2',
    });

    expect(result.status).toBe('needs_review');
    expect(DocumentRepository.prototype.findByIdForUpdate).toHaveBeenCalledWith('doc-1', 'co-a', client);
    expect(submitForReview).toHaveBeenCalledWith('doc-1', 'co-a', client);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'document.submit_review',
      before_data: { status: 'uploaded' },
      after_data: { status: 'needs_review' },
    }), client);
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
  });

  it.each([
    ['approved', 'document.approve', null],
    ['incomplete', 'document.mark_incomplete', 'Missing page'],
    ['rejected', 'document.reject', 'Duplicate'],
  ] as const)('audits %s with the correct action', async (decision, action, note) => {
    const needsReview = { ...record, status: 'needs_review' as const };
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(needsReview);
    vi.spyOn(DocumentRepository.prototype, 'updateReview').mockResolvedValue({ ...needsReview, status: decision, review_note: note });
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue({} as never);

    await new DocumentService(pool, storage).review({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', decision, note });

    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action,
      company_id: 'co-a',
      actor_user_id: 'u2',
      entity_id: 'doc-1',
      before_data: { status: 'needs_review' },
      after_data: { status: decision, ...(note ? { review_note: note } : {}) },
    }), client);
  });

  it('rolls back and writes nothing when the current review state is invalid', async () => {
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(record);
    const updateReview = vi.spyOn(DocumentRepository.prototype, 'updateReview');
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logEvent');

    await expect(new DocumentService(pool, storage).review({
      documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', decision: 'approved', note: null,
    })).rejects.toMatchObject({ code: 'DOCUMENT_STATE_CONFLICT' });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(updateReview).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('DocumentService intake', () => {
  it('persists an active company-scoped counterparty link', async () => {
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(record);
    vi.spyOn(DocumentRepository.prototype, 'updateIntake').mockResolvedValue({ ...record, counterparty_id: 'cp-1' });
    vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue({} as never);
    vi.mocked(client.query).mockImplementation(async sql => String(sql).startsWith('SELECT 1 FROM counterparties') ? { rows: [{ one: 1 }], rowCount: 1 } as never : { rows: [], rowCount: 0 } as never);
    await expect(new DocumentService(pool, storage).updateIntake({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', intake: { counterparty_id: 'cp-1' } })).resolves.toMatchObject({ counterparty_id: 'cp-1' });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('is_active = TRUE'), ['cp-1', 'co-a']);
  });

  it('rejects a cross-company or inactive counterparty when creating a link', async () => {
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(record);
    const update = vi.spyOn(DocumentRepository.prototype, 'updateIntake');
    await expect(new DocumentService(pool, storage).updateIntake({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', intake: { counterparty_id: 'cp-other' } })).rejects.toMatchObject({ code: 'DOCUMENT_COUNTERPARTY_INVALID' });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('company_id = $2'), ['cp-other', 'co-a']);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a purchase/customer or sale/supplier mismatch during Intake', async () => {
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(record);
    const update = vi.spyOn(DocumentRepository.prototype, 'updateIntake');
    vi.mocked(client.query).mockImplementation(async (sql, params) => {
      if (String(sql).includes('is_active = TRUE')) return { rows: [{ one: 1 }], rowCount: 1 } as never;
      if (String(sql).includes('type = $3')) return { rows: [], rowCount: 0 } as never;
      return { rows: [], rowCount: 0 } as never;
    });

    await expect(new DocumentService(pool, storage).updateIntake({
      documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', intake: { document_type: 'purchase', counterparty_id: 'cp-customer' },
    })).rejects.toMatchObject({ code: 'DOCUMENT_COUNTERPARTY_INVALID' });

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('type = $3'), ['cp-customer', 'co-a', 'supplier']);
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts an Intake purchase linked to an active supplier', async () => {
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(record);
    vi.spyOn(DocumentRepository.prototype, 'updateIntake').mockResolvedValue({ ...record, document_type: 'purchase', counterparty_id: 'cp-supplier' });
    vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue({} as never);
    vi.mocked(client.query).mockImplementation(async sql => String(sql).startsWith('SELECT 1 FROM counterparties') ? { rows: [{ one: 1 }], rowCount: 1 } as never : { rows: [], rowCount: 0 } as never);

    await expect(new DocumentService(pool, storage).updateIntake({
      documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', intake: { document_type: 'purchase', counterparty_id: 'cp-supplier' },
    })).resolves.toMatchObject({ document_type: 'purchase', counterparty_id: 'cp-supplier' });

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('type = $3'), ['cp-supplier', 'co-a', 'supplier']);
  });

  it('locks, updates, audits changed values, and commits in one transaction', async () => {
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue(record);
    vi.spyOn(DocumentRepository.prototype, 'updateIntake').mockResolvedValue({ ...record, document_type: 'purchase', total_amount: '12.25' });
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue({} as never);
    await new DocumentService(pool, storage).updateIntake({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', intake: { document_type: 'purchase', total_amount: 12.25 } });
    expect(DocumentRepository.prototype.findByIdForUpdate).toHaveBeenCalledWith('doc-1', 'co-a', client);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'document.intake_update', company_id: 'co-a', actor_user_id: 'u2', entity_id: 'doc-1', before_data: { document_type: null, total_amount: null }, after_data: { document_type: 'purchase', total_amount: '12.25' } }), client);
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
  });

  it.each(['needs_review', 'approved', 'incomplete', 'rejected'] as const)('rolls back without update or audit in %s', async status => {
    vi.spyOn(DocumentRepository.prototype, 'findByIdForUpdate').mockResolvedValue({ ...record, status });
    const update = vi.spyOn(DocumentRepository.prototype, 'updateIntake'); const audit = vi.spyOn(AuditLogRepository.prototype, 'logEvent');
    await expect(new DocumentService(pool, storage).updateIntake({ documentId: 'doc-1', companyId: 'co-a', actorUserId: 'u2', intake: { intake_note: 'note' } })).rejects.toMatchObject({ code: 'DOCUMENT_STATE_CONFLICT' });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK'); expect(update).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
  });
});
