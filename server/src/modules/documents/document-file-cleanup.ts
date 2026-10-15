import type { Pool, PoolClient } from 'pg';
import logger from '../../shared/logger';
import type { StorageAdapter } from '../../storage/storage.adapter';

/**
 * Durable, retryable removal of stored document files after their row was deleted (migration 078).
 * enqueue() runs inside the delete transaction; process() runs after commit and again from the scheduler, claiming rows with
 * FOR UPDATE SKIP LOCKED so overlapping runs or processes never handle the same file twice.
 * Safety before every physical delete: the key must belong to the queued company's prefix and NO documents row may reference it now;
 * otherwise the entry is marked 'skipped' and the file is left alone.
 */
export interface CleanupOutcome { done: number; pending: number; skipped: number; }
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export class DocumentFileCleanup {
  constructor(private readonly pool: Pool, private readonly storage: StorageAdapter) {}

  async enqueue(client: PoolClient, companyId: string, documentId: string, storageKey: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO storage_deletion_queue (company_id, document_id, storage_key) VALUES ($1, $2, $3)
       ON CONFLICT (store, storage_key) DO UPDATE SET status = 'pending', next_attempt_at = NOW(), completed_at = NULL
       RETURNING id`, [companyId, documentId, storageKey]);
    return rows[0]!.id;
  }

  /** ids: attempt exactly these entries now (right after the delete commit); omitted: every pending entry that is due. */
  async process(ids?: string[], limit = 50): Promise<CleanupOutcome> {
    const outcome: CleanupOutcome = { done: 0, pending: 0, skipped: 0 };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string; company_id: string; storage_key: string; attempts: number }>(
        `SELECT id, company_id, storage_key, attempts FROM storage_deletion_queue
          WHERE status = 'pending' AND ($1::uuid[] IS NULL OR id = ANY($1)) AND ($1::uuid[] IS NOT NULL OR next_attempt_at <= NOW())
          ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [ids ?? null, limit]);
      for (const row of rows) {
        const referenced = await client.query('SELECT 1 FROM documents WHERE storage_key = $1 LIMIT 1', [row.storage_key]);
        if (!row.storage_key.startsWith(`${row.company_id}/`) || referenced.rowCount) {
          await client.query(`UPDATE storage_deletion_queue SET status = 'skipped', completed_at = NOW(), last_error = 'key not owned or referenced again' WHERE id = $1`, [row.id]);
          logger.warn({ queueId: row.id, storageKey: row.storage_key }, 'Skipped file cleanup: key is referenced or outside the company prefix');
          outcome.skipped++;
          continue;
        }
        try {
          await this.storage.delete(row.storage_key);
          await client.query(`UPDATE storage_deletion_queue SET status = 'done', attempts = attempts + 1, completed_at = NOW(), last_error = NULL WHERE id = $1`, [row.id]);
          outcome.done++;
        } catch (err) {
          const delay = Math.min(60_000 * 2 ** Math.min(row.attempts, 12), MAX_BACKOFF_MS);
          await client.query(
            `UPDATE storage_deletion_queue SET attempts = attempts + 1, last_error = $2, next_attempt_at = NOW() + ($3 || ' milliseconds')::interval WHERE id = $1`,
            [row.id, (err instanceof Error ? err.message : String(err)).slice(0, 500), String(delay)]);
          logger.error({ err, queueId: row.id, storageKey: row.storage_key }, 'Stored file removal failed; will retry');
          outcome.pending++;
        }
      }
      await client.query('COMMIT');
      return outcome;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
