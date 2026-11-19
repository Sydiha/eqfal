import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { SystemAdminService } from '../src/modules/memberships/system-admin.service';

describe('System Administrator policy version', () => {
  it('preserves an activated version on an idempotent grant', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT 1 FROM users WHERE id = $1 AND is_active')) return { rows: [{ '?column?': 1 }] };
      if (sql.startsWith('SELECT id, email, display_name, is_active, is_system_admin, system_admin_policy_version')) {
        return { rows: [{ id: 'admin', email: 'admin@example.test', display_name: null, is_active: true, is_system_admin: true, system_admin_policy_version: 1, created_at: new Date(), active_memberships: 0 }] };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;

    const user = await new SystemAdminService(pool).setSystemAdmin('admin', true, 'actor');
    expect(user.system_admin_policy_version).toBe(1);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
});
