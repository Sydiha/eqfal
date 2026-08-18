import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import logger from '../../shared/logger';
import { StorageAdapter } from '../../storage/storage.adapter';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { DocumentRepository } from './document.repository';
import { DocumentIntake, DocumentIntakeUpdate, DocumentRecord, DocumentReviewDecision } from './document.types';
import { assertAccountingDateWritable } from '../monthly-close/accounting-period.guard';

export interface UploadDocumentInput {
  companyId: string;
  actorUserId: string;
  originalFilename: string;
  mimeType: string;
  data: Buffer;
}

interface DocumentTransitionInput {
  documentId: string;
  companyId: string;
  actorUserId: string;
}

export interface ReviewDocumentInput extends DocumentTransitionInput {
  decision: DocumentReviewDecision;
  note: string | null;
}

export interface UpdateDocumentIntakeInput extends DocumentTransitionInput { intake: DocumentIntakeUpdate; }

export class DocumentNotFoundError extends Error {}
export class DocumentReviewConflictError extends Error {}

export class DocumentService {
  private readonly documents: DocumentRepository;
  private readonly audit: AuditLogRepository;

  constructor(
    private readonly pool: Pool,
    private readonly storage: StorageAdapter,
  ) {
    this.documents = new DocumentRepository(pool);
    this.audit = new AuditLogRepository();
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async upload(input: UploadDocumentInput): Promise<DocumentRecord> {
    const sha256 = crypto.createHash('sha256').update(input.data).digest('hex');
    const storageKey = `${input.companyId}/${crypto.randomUUID()}`;

    await this.storage.put(storageKey, input.data);

    try {
      return await this.withTransaction(async (client) => {
        const document = await this.documents.create(
          {
            company_id: input.companyId,
            uploaded_by_user_id: input.actorUserId,
            original_filename: input.originalFilename,
            mime_type: input.mimeType,
            size_bytes: input.data.length,
            storage_key: storageKey,
            sha256,
          },
          client,
        );

        await this.audit.logEvent(
          {
            company_id: input.companyId,
            actor_user_id: input.actorUserId,
            action: 'document.upload',
            entity_type: 'document',
            entity_id: document.id,
            before_data: null,
            after_data: {
              original_filename: document.original_filename,
              mime_type: document.mime_type,
              size_bytes: document.size_bytes,
              status: document.status,
            },
          },
          client,
        );

        return document;
      });
    } catch (err) {
      try {
        await this.storage.delete(storageKey);
      } catch (cleanupErr) {
        logger.error({ cleanupErr, storageKey }, 'Failed to clean orphaned document file');
      }
      throw err;
    }
  }

  async submitReview(input: DocumentTransitionInput): Promise<DocumentRecord> {
    return this.withTransaction(async (client) => {
      const current = await this.documents.findByIdForUpdate(input.documentId, input.companyId, client);
      if (!current) throw new DocumentNotFoundError('Document not found');
      if (current.document_date) await assertAccountingDateWritable(input.companyId, current.document_date, client);
      if (current.status !== 'uploaded') {
        throw new DocumentReviewConflictError('Document cannot be submitted from its current status');
      }
      const document = await this.documents.submitForReview(input.documentId, input.companyId, client);
      await this.audit.logEvent({
        company_id: input.companyId,
        actor_user_id: input.actorUserId,
        action: 'document.submit_review',
        entity_type: 'document',
        entity_id: document.id,
        before_data: { status: current.status },
        after_data: { status: document.status },
      }, client);
      return document;
    });
  }

  async updateIntake(input: UpdateDocumentIntakeInput): Promise<DocumentRecord> {
    return this.withTransaction(async (client) => {
      const current = await this.documents.findByIdForUpdate(input.documentId, input.companyId, client);
      if (!current) throw new DocumentNotFoundError('Document not found');
      const accountingDate = input.intake.document_date === undefined ? current.document_date : input.intake.document_date;
      if (accountingDate) await assertAccountingDateWritable(input.companyId, accountingDate, client);
      if (current.document_date && current.document_date !== accountingDate) await assertAccountingDateWritable(input.companyId, current.document_date, client);
      if (current.status !== 'uploaded') throw new DocumentReviewConflictError('Document intake cannot be updated');
      const changed = (Object.keys(input.intake) as (keyof DocumentIntake)[])
        .filter((field) => field === 'total_amount'
          ? Number(current[field]) !== Number(input.intake[field]) || (current[field] === null) !== (input.intake[field] === null)
          : current[field] !== input.intake[field]);
      if (changed.length === 0) return current;
      const update = Object.fromEntries(changed.map((field) => [field, input.intake[field]])) as DocumentIntakeUpdate;
      const document = await this.documents.updateIntake(input.documentId, input.companyId, update, client);
      await this.audit.logEvent({
        company_id: input.companyId, actor_user_id: input.actorUserId,
        action: 'document.intake_update', entity_type: 'document', entity_id: document.id,
        before_data: Object.fromEntries(changed.map((field) => [field, current[field]])),
        after_data: Object.fromEntries(changed.map((field) => [field, document[field]])),
      }, client);
      return document;
    });
  }

  async review(input: ReviewDocumentInput): Promise<DocumentRecord> {
    const actions: Record<DocumentReviewDecision, string> = {
      approved: 'document.approve',
      incomplete: 'document.mark_incomplete',
      rejected: 'document.reject',
    };
    return this.withTransaction(async (client) => {
      const current = await this.documents.findByIdForUpdate(input.documentId, input.companyId, client);
      if (!current) throw new DocumentNotFoundError('Document not found');
      if (current.document_date) await assertAccountingDateWritable(input.companyId, current.document_date, client);
      if (current.status !== 'needs_review') {
        throw new DocumentReviewConflictError('Document cannot be reviewed from its current status');
      }
      const document = await this.documents.updateReview(input.documentId, input.companyId, input.decision, input.actorUserId, input.note, client);
      await this.audit.logEvent({
        company_id: input.companyId,
        actor_user_id: input.actorUserId,
        action: actions[input.decision],
        entity_type: 'document',
        entity_id: document.id,
        before_data: { status: current.status },
        after_data: { status: document.status, ...(input.note ? { review_note: input.note } : {}) },
      }, client);
      return document;
    });
  }
}
