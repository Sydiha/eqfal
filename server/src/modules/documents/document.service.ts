import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import logger from '../../shared/logger';
import { StorageAdapter } from '../../storage/storage.adapter';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { DocumentRepository } from './document.repository';
import { DocumentIntake, DocumentIntakeUpdate, DocumentRecord, DocumentReviewDecision, isValidDocumentDate, isValidDocumentTotalAmount } from './document.types';
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
export type DocumentConflictCode = 'DOCUMENT_STATE_CONFLICT' | 'DOCUMENT_COUNTERPARTY_INVALID' | 'DOCUMENT_APPROVAL_DATA_INCOMPLETE';
export class DocumentReviewConflictError extends Error {
  constructor(message: string, readonly code: DocumentConflictCode = 'DOCUMENT_STATE_CONFLICT') { super(message); }
}

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

  private expectedCounterpartyType(documentType: DocumentRecord['document_type']): 'customer' | 'supplier' | null {
    if (documentType === 'sale') return 'customer';
    if (documentType === 'purchase' || documentType === 'expense') return 'supplier';
    return null;
  }

  private async hasCompanyCounterparty(
    companyId: string,
    counterpartyId: string | null,
    client: PoolClient,
    activeOnly = false,
    expectedType: 'customer' | 'supplier' | null = null,
  ): Promise<boolean> {
    if (!counterpartyId) return false;
    const params: string[] = [counterpartyId, companyId];
    const typeClause = expectedType ? ` AND type = $${params.push(expectedType)}` : '';
    const result = await client.query(
      `SELECT 1 FROM counterparties WHERE id = $1 AND company_id = $2${activeOnly ? ' AND is_active = TRUE' : ''}${typeClause}`,
      params,
    );
    return Boolean(result.rowCount);
  }

  private async assertCounterpartyRole(document: DocumentRecord, companyId: string, client: PoolClient): Promise<void> {
    const expectedType = this.expectedCounterpartyType(document.document_type);
    if (!expectedType || !document.counterparty_id) return;
    if (!await this.hasCompanyCounterparty(companyId, document.counterparty_id, client, false, expectedType)) {
      throw new DocumentReviewConflictError(`Document counterparty must be a ${expectedType}`, 'DOCUMENT_COUNTERPARTY_INVALID');
    }
  }

  private async assertOperationalCounterparty(document: DocumentRecord, companyId: string, client: PoolClient): Promise<void> {
    const expectedType = this.expectedCounterpartyType(document.document_type);
    if (expectedType && !await this.hasCompanyCounterparty(companyId, document.counterparty_id, client, false, expectedType)) {
      throw new DocumentReviewConflictError(`Operational document requires a valid company ${expectedType}`, 'DOCUMENT_COUNTERPARTY_INVALID');
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
      await this.assertOperationalCounterparty(current, input.companyId, client);
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
      if (input.intake.counterparty_id !== undefined && input.intake.counterparty_id !== current.counterparty_id
        && input.intake.counterparty_id !== null
        && !await this.hasCompanyCounterparty(input.companyId, input.intake.counterparty_id, client, true)) {
        throw new DocumentReviewConflictError('Counterparty must be active and belong to the company', 'DOCUMENT_COUNTERPARTY_INVALID');
      }
      const resultingDocument = { ...current, ...input.intake } as DocumentRecord;
      await this.assertCounterpartyRole(resultingDocument, input.companyId, client);
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
      if (input.decision === 'approved' && ['purchase', 'expense', 'sale'].includes(current.document_type ?? '')
        && (!isValidDocumentDate(current.document_date) || !isValidDocumentTotalAmount(current.total_amount))) {
        throw new DocumentReviewConflictError('VAT-eligible document requires a valid document date and total amount', 'DOCUMENT_APPROVAL_DATA_INCOMPLETE');
      }
      if (input.decision === 'approved') await this.assertOperationalCounterparty(current, input.companyId, client);
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
