import { Pool } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { InvoiceError } from './invoice.service';

/**
 * Company-specific account mappings for invoice accounting. This service only stores explicit choices made by an
 * authorized person: it never proposes, defaults or infers an account. Nothing consumes the mappings yet
 * (no journal creation, no posting). No route exposes it until the owner decides the mapping policy (A1).
 */
export const MAPPING_KEYS = ['receivable', 'payable', 'sales_revenue', 'purchase_expense', 'vat_output', 'vat_input'] as const;
export type MappingKey = (typeof MAPPING_KEYS)[number];

const isKey = (k: unknown): k is MappingKey => typeof k === 'string' && (MAPPING_KEYS as readonly string[]).includes(k);

export class InvoiceAccountMappingService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  async list(companyId: string) {
    const rows = (await this.db.query<{ mapping_key: MappingKey; account_id: string }>(
      'SELECT mapping_key, account_id FROM invoice_account_mappings WHERE company_id = $1 ORDER BY mapping_key', [companyId])).rows;
    return rows;
  }

  /** Keys that have no mapping (or whose mapped account was deactivated) for this company. */
  async missingKeys(companyId: string): Promise<MappingKey[]> {
    const ok = new Set((await this.db.query<{ mapping_key: string }>(
      `SELECT m.mapping_key FROM invoice_account_mappings m
       JOIN accounts a ON a.id = m.account_id AND a.company_id = m.company_id
       WHERE m.company_id = $1 AND a.is_active`, [companyId])).rows.map((r) => r.mapping_key));
    return MAPPING_KEYS.filter((k) => !ok.has(k));
  }

  async set(companyId: string, actorUserId: string, key: unknown, accountId: unknown) {
    if (!isKey(key)) throw new InvoiceError(400, 'INVOICE_VALIDATION', 'Unknown mapping key');
    if (typeof accountId !== 'string') throw new InvoiceError(400, 'INVOICE_VALIDATION', 'account_id is required');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const acct = (await client.query<{ is_active: boolean }>(
        'SELECT is_active FROM accounts WHERE id::text = $1 AND company_id = $2', [accountId, companyId])).rows[0];
      if (!acct || !acct.is_active) throw new InvoiceError(400, 'INVOICE_VALIDATION', 'Account not found or inactive for this company');
      const before = (await client.query('SELECT account_id FROM invoice_account_mappings WHERE company_id = $1 AND mapping_key = $2 FOR UPDATE', [companyId, key])).rows[0] ?? null;
      await client.query(
        `INSERT INTO invoice_account_mappings (company_id, mapping_key, account_id, updated_by_user_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (company_id, mapping_key) DO UPDATE SET account_id = EXCLUDED.account_id, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = NOW()`,
        [companyId, key, accountId, actorUserId]);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.account_mapping.set', entity_type: 'invoice_account_mapping', entity_id: companyId,
        before_data: before as never, after_data: { mapping_key: key, account_id: accountId } as never }, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async clear(companyId: string, actorUserId: string, key: unknown) {
    if (!isKey(key)) throw new InvoiceError(400, 'INVOICE_VALIDATION', 'Unknown mapping key');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const before = (await client.query('DELETE FROM invoice_account_mappings WHERE company_id = $1 AND mapping_key = $2 RETURNING account_id', [companyId, key])).rows[0];
      if (before) {
        await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.account_mapping.clear', entity_type: 'invoice_account_mapping', entity_id: companyId,
          before_data: { mapping_key: key, account_id: before.account_id } as never, after_data: null as never }, client);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
