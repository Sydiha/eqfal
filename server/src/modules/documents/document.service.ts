import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import logger from '../../shared/logger';
import { StorageAdapter } from '../../storage/storage.adapter';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { DocumentRepository } from './document.repository';
import { DocumentRecord } from './document.types';

export interface UploadDocumentInput {
  companyId: string;
  actorUserId: string;
  originalFilename: string;
  mimeType: string;
  data: Buffer;
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
}
