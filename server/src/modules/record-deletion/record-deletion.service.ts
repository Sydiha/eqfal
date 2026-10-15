import type { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable, assertAccountingRangeWritable } from '../monthly-close/accounting-period.guard';
import { DeleteBlockedError, findReferencingTable } from '../../shared/delete-guard';
import logger from '../../shared/logger';
import type { StorageAdapter } from '../../storage/storage.adapter';
import { DocumentFileCleanup } from '../documents/document-file-cleanup';

export class RecordNotFoundError extends Error {}
export class RecordVersionConflictError extends Error {}

type Row = Record<string, unknown>;

/**
 * Delete & Void Phase 3: permanent deletion of records that never had financial effect.
 * Every method: one transaction, row lock (FOR UPDATE) on the target scoped by company_id, state/period/dependency checks,
 * a pre-delete snapshot in the audit log, then the delete. Anything referenced by any other table is refused by the FK-catalog scan.
 */
export class RecordDeletionService {
  private readonly audit = new AuditLogRepository();
  private readonly cleanup: DocumentFileCleanup | null;
  /** bankFiles: the bank-imports store; its file removals use the shared durable storage_deletion_queue (documents, 078). */
  constructor(private readonly db: Pool, bankFiles?: StorageAdapter) {
    this.cleanup = bankFiles ? new DocumentFileCleanup(db, bankFiles, { 'bank-imports': bankFiles }) : null;
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23503') throw new DeleteBlockedError('other');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lock(client: PoolClient, table: string, id: string, companyId: string): Promise<Row> {
    const row = (await client.query<Row>(`SELECT * FROM ${table} WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rows[0];
    if (!row) throw new RecordNotFoundError();
    return row;
  }

  private async assertUnreferenced(client: PoolClient, table: string, id: string, companyId: string, ignore: readonly string[] = []) {
    const hit = await findReferencingTable(client, table, id, companyId, ignore);
    if (hit) throw new DeleteBlockedError(hit, hit);
  }

  private snapshot(row: Row): Record<string, unknown> {
    return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  }

  /** Manual DRAFT journal only. System-generated drafts (operational source) belong to their source and are never deleted here. */
  async deleteJournal(companyId: string, actor: string, id: string): Promise<void> {
    await this.tx(async (client) => {
      const journal = await this.lock(client, 'journal_entries', id, companyId);
      if (journal.status !== 'draft') throw new DeleteBlockedError('posted');
      if (journal.source_type !== null || journal.entry_type !== 'standard') throw new DeleteBlockedError('system_generated');
      await assertAccountingDateWritable(companyId, String(journal.accounting_date instanceof Date ? journal.accounting_date.toISOString().slice(0, 10) : journal.accounting_date), client);
      await this.assertUnreferenced(client, 'journal_entries', id, companyId, ['journal_lines']);
      const lines = (await client.query<Row>('SELECT account_id, debit::text, credit::text, memo, sequence FROM journal_lines WHERE journal_entry_id = $1 AND company_id = $2 ORDER BY sequence', [id, companyId])).rows;
      await client.query('DELETE FROM journal_entries WHERE id = $1 AND company_id = $2', [id, companyId]);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'journal.delete', entity_type: 'journal_entry', entity_id: id, before_data: { ...this.snapshot(journal), lines } as never, after_data: null }, client);
    });
  }

  /** Periodic adjustment (accrual / prepayment) in 'draft' only; no schedule line and no journal may exist. */
  async deletePeriodicAdjustment(companyId: string, actor: string, id: string): Promise<void> {
    await this.tx(async (client) => {
      const adjustment = await this.lock(client, 'periodic_adjustments', id, companyId);
      if (adjustment.workflow_status !== 'draft') throw new DeleteBlockedError('not_draft');
      const range = (await client.query<{ s: string; e: string }>('SELECT recognition_start::text s, recognition_end::text e FROM periodic_adjustments WHERE id = $1', [id])).rows[0]!;
      await assertAccountingRangeWritable(companyId, range.s, range.e, client);
      await this.assertUnreferenced(client, 'periodic_adjustments', id, companyId);
      await client.query('DELETE FROM periodic_adjustments WHERE id = $1 AND company_id = $2', [id, companyId]);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'periodic_adjustment.delete', entity_type: 'periodic_adjustment', entity_id: id, before_data: this.snapshot(adjustment) as never, after_data: null }, client);
    });
  }

  /** Bank import batch that was never confirmed (no bank transaction exists). The file removal is queued in the same transaction and retried until done. */
  async deleteBankImportBatch(companyId: string, actor: string, id: string): Promise<{ storage_cleanup: 'done' | 'pending' }> {
    const { queueId } = await this.tx(async (client) => {
      const current = await this.lock(client, 'bank_import_batches', id, companyId);
      if (current.status === 'confirmed') throw new DeleteBlockedError('confirmed');
      await this.assertUnreferenced(client, 'bank_import_batches', id, companyId);
      await client.query('DELETE FROM bank_import_batches WHERE id = $1 AND company_id = $2', [id, companyId]);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'bank_import.delete', entity_type: 'bank_import_batch', entity_id: id, before_data: this.snapshot(current) as never, after_data: null }, client);
      // Ownership (company prefix) and "no batch references this key" are re-checked by the queue worker before the physical delete.
      const queueId = this.cleanup ? await this.cleanup.enqueue(client, companyId, id, String(current.storage_key), 'bank-imports') : null;
      return { queueId };
    });
    if (!this.cleanup || !queueId) return { storage_cleanup: 'pending' };
    try {
      const outcome = await this.cleanup.process([queueId]);
      return { storage_cleanup: outcome.done ? 'done' : 'pending' };
    } catch (err) {
      logger.error({ err, batchId: id }, 'Bank import deleted; file cleanup stays queued for retry');
      return { storage_cleanup: 'pending' };
    }
  }

  /** Counterparty with no obligation, document, settlement or any other reference. Otherwise it is deactivated, never deleted. */
  async deleteCounterparty(companyId: string, actor: string, id: string, version: number): Promise<void> {
    await this.tx(async (client) => {
      const row = await this.lock(client, 'counterparties', id, companyId);
      if (row.version !== version) throw new RecordVersionConflictError();
      await this.assertUnreferenced(client, 'counterparties', id, companyId);
      await client.query('DELETE FROM counterparties WHERE id = $1 AND company_id = $2', [id, companyId]);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'counterparty.delete', entity_type: 'counterparty', entity_id: id, before_data: this.snapshot(row) as never, after_data: null }, client);
    });
  }

  /** Partner with no ownership period or other reference (for example one created by mistake). */
  async deletePartner(companyId: string, actor: string, id: string, version: number): Promise<void> {
    await this.tx(async (client) => {
      const row = await this.lock(client, 'partners', id, companyId);
      if (row.version !== version) throw new RecordVersionConflictError();
      await this.assertUnreferenced(client, 'partners', id, companyId);
      await client.query('DELETE FROM partners WHERE id = $1 AND company_id = $2', [id, companyId]);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'partner.delete', entity_type: 'partner', entity_id: id, before_data: this.snapshot(row) as never, after_data: null }, client);
    });
  }
}
