import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { MembershipService } from '../src/modules/memberships/membership.service';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';
import { UserRepository } from '../src/modules/users/user.repository';
import { AuditLogRepository } from '../src/modules/audit-log/audit-log.repository';

const C = 'company-a';
const now = new Date();
const client = { query: vi.fn(), release: vi.fn() } as unknown as PoolClient;
const pool = { connect: vi.fn(async () => client), query: vi.fn() } as unknown as Pool;

beforeEach(() => {
  vi.restoreAllMocks();
  (client.query as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({ rows: [{ id: 'u-new', email: 'n@example.com' }] });
  vi.spyOn(MembershipRepository.prototype, 'createMembership').mockResolvedValue({ id: 'm-new', user_id: 'u-new', company_id: C, role_id: null, is_active: true, created_at: now, updated_at: now });
  vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue({} as never);
});

describe('first-login password change for administratively created users', () => {
  it('creates the user with must_change_password and the audit never holds the password', async () => {
    const create = vi.spyOn(UserRepository.prototype, 'create').mockResolvedValue({ id: 'u-new', email: 'n@example.com', password_hash: 'h', is_active: true, created_at: now, updated_at: now });
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logEvent');
    await new MembershipService(pool).createUserForCompany('n@example.com', 'Initial-pass-1', null, C, 'admin');
    const input = create.mock.calls[0]![0];
    expect(input.mustChangePassword).toBe(true);
    expect(input.password).not.toBe('Initial-pass-1'); // bcrypt hash only
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/Initial-pass|\$2[aby]\$|must_change/);
  });

  it('the repository writes the flag only when requested (bootstrap and other callers are unchanged)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'u' }] });
    const repo = new UserRepository({ query } as unknown as Pool);
    await repo.create({ email: 'A@Example.com', password: 'hash', mustChangePassword: true });
    await repo.create({ email: 'b@example.com', password: 'hash' });
    expect(query.mock.calls[0]![0]).toMatch(/must_change_password, display_name\)\s+VALUES \(LOWER\(\$1\), \$2, TRUE, \$3\)/);
    expect(query.mock.calls[1]![0]).not.toMatch(/must_change_password/);
    expect(query.mock.calls[0]![1]).toEqual(['A@Example.com', 'hash', null]);
  });

  it('migration 082 never rewrites existing users (no forced change for existing accounts)', () => {
    const sql = readFileSync(new URL('../migrations/082_password_management.sql', import.meta.url), 'utf8')
      .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).toMatch(/must_change_password BOOLEAN NOT NULL DEFAULT FALSE/);
  });
});
