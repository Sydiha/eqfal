import { PoolClient } from 'pg';
import { AuditLog, CreateAuditLogInput } from './audit-log.types';

/**
 * AuditLogRepository
 *
 * Append-only. Every write must be performed inside the caller's transaction
 * (PoolClient) so that a business-operation rollback also rolls back the
 * audit entry — guaranteeing that no change happens without an audit record,
 * and no audit record is left behind from a failed change.
 *
 * No Pool constructor argument: this repository never opens its own
 * connection or transaction.
 */
export class AuditLogRepository {
  /**
   * Insert one audit event within an existing transaction.
   *
   * The caller must ensure that before_data / after_data do not contain
   * passwords, password hashes, tokens, or any other secrets.
   */
  async logEvent(
    input: CreateAuditLogInput,
    client: PoolClient,
  ): Promise<AuditLog> {
    const { rows } = await client.query<AuditLog>(
      `INSERT INTO audit_log
         (company_id, actor_user_id, action, entity_type, entity_id,
          before_data, after_data, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.company_id,
        input.actor_user_id,
        input.action,
        input.entity_type,
        input.entity_id,
        input.before_data ?? null,
        input.after_data ?? null,
        input.reason ?? null,
      ],
    );
    return rows[0]!;
  }
}
