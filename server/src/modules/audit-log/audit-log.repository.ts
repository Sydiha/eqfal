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
 *
 * Sensitive-field stripping:
 *   before_data and after_data are scrubbed through stripSensitiveFields()
 *   before the INSERT. Any key whose lowercase form appears in SENSITIVE_KEYS
 *   is removed. This is a defence-in-depth measure — callers should also
 *   never pass sensitive fields, but the repository enforces it regardless.
 */

/**
 * Exact key names (case-insensitive) that must never appear in audit
 * before_data / after_data snapshots.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'hash',
  'secret',
  'token',
  'credential',
  'private_key',
  'api_key',
  'access_key',
  'secret_key',
]);

/**
 * Return a shallow copy of `data` with all sensitive keys removed.
 * Keys are compared case-insensitively against SENSITIVE_KEYS.
 * Returns null when the input is null or undefined.
 */
function stripSensitiveFields(
  data: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (data == null) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!SENSITIVE_KEYS.has(key.toLowerCase())) {
      clean[key] = value;
    }
  }
  return clean;
}

export class AuditLogRepository {
  /**
   * Insert one audit event within an existing transaction.
   *
   * Sensitive keys (password, hash, token, secret, …) are stripped from
   * before_data and after_data at this layer regardless of what the caller
   * passes — ensuring no secret reaches the database even if a future caller
   * forgets the convention.
   */
  async logEvent(
    input: CreateAuditLogInput,
    client: PoolClient,
  ): Promise<AuditLog> {
    const safeBefore = stripSensitiveFields(input.before_data);
    const safeAfter  = stripSensitiveFields(input.after_data);

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
        safeBefore,
        safeAfter,
        input.reason ?? null,
      ],
    );
    return rows[0]!;
  }
}
