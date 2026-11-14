import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { SystemAdminService } from '../src/modules/memberships/system-admin.service';

describe('System Administrator policy reset audit', () => {
  it('audits a reset to version zero even when admin status stays true', async () => {
    const auditInsert = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT 1 FROM users WHERE id = $1 AND is_active')) return { rows: [{ '?column?': 1 }] };
      if (sql.startsWith('SELECT id, email, display_name, is_active, is_system_admin, system_admin_policy_version')) {
        return { rows: [{ id: 'admin', email: 'admin@example.test', display_name: null, is_active: true, is_system_admin: true, system_admin_policy_version: 1, created_at: new Date(), active_memberships: 0 }] };
      }
      if (sql.startsWith('UPDATE users SET is_system_admin')) {
        return { rows: [{ id: 'admin', email: 'admin@example.test', display_name: null, is_active: true, is_system_admin: true, system_admin_policy_version: 0, created_at: new Date(), active_memberships: 0 }] };
      }
      if (sql.includes('INSERT INTO system_audit_log')) { auditInsert(sql); return { rows: [] }; }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;

    await new SystemAdminService(pool).setSystemAdmin('admin', true, 'actor');

    expect(auditInsert).toHaveBeenCalledOnce();
    const auditParams = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO system_audit_log'))?.[1];
    expect(auditParams?.[2]).toBe('system.admin.policy.reset');
    expect(JSON.parse(String(auditParams?.[5]))).toEqual({ is_system_admin: true, system_admin_policy_version: 1 });
    expect(JSON.parse(String(auditParams?.[6]))).toEqual({ is_system_admin: true, system_admin_policy_version: 0 });
  });
});
