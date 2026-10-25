import bcrypt from 'bcrypt';
import { Pool, PoolClient } from 'pg';
import { AccessPolicyError } from './access-policy-error';

/** Arbitrary but fixed key serialising System Admin bootstraps ("eqfal system admin bootstrap"); do not change. */
const SYSTEM_ADMIN_BOOTSTRAP_LOCK_KEY = 7_432_093;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AdminUser { id: string; email: string; display_name: string | null; is_active: boolean; is_system_admin: boolean; created_at: Date; active_memberships: number }
export interface AdminUserMembership {
  id: string; company_id: string; company_name: string; company_name_ar: string | null; company_is_active: boolean;
  role_id: string | null; role_name: string | null; role_is_full_access: boolean; is_active: boolean;
}

export class SystemAdminBootstrapError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'ALREADY_INITIALIZED' | 'USER_NOT_FOUND', message: string) { super(message); }
}

type Runner = Pick<Pool, 'query'> | PoolClient;

/**
 * Global (company-independent) administration that only an active System Admin may perform: listing and creating
 * user accounts, enabling or disabling accounts, and granting or revoking System Admin. Company-scoped changes
 * (memberships, roles, capabilities) stay in MembershipService so every ceiling, last-Full-Access and audit rule is
 * shared with company managers. Every mutation writes system_audit_log in the same transaction.
 */
export class SystemAdminService {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async isActiveSystemAdmin(runner: Runner, userId: string): Promise<boolean> {
    const { rows } = await runner.query('SELECT 1 FROM users WHERE id = $1 AND is_active = TRUE AND is_system_admin = TRUE', [userId]);
    return rows.length > 0;
  }

  private async log(client: PoolClient, entry: { actor: string | null; label?: string; action: string; target: string | null; company?: string | null; before: unknown; after: unknown }): Promise<void> {
    await client.query(
      `INSERT INTO system_audit_log (actor_user_id, actor_label, action, target_user_id, company_id, before_data, after_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [entry.actor, entry.label ?? null, entry.action, entry.target, entry.company ?? null,
        entry.before === null ? null : JSON.stringify(entry.before), entry.after === null ? null : JSON.stringify(entry.after)],
    );
  }

  /** Row-locks every active System Admin so concurrent revocations or deactivations serialize (last-admin check). */
  private async lockActiveSystemAdmins(client: PoolClient): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>('SELECT id FROM users WHERE is_system_admin = TRUE AND is_active = TRUE ORDER BY id FOR UPDATE');
    return rows.map((row) => row.id);
  }

  private async assertNotLastSystemAdmin(client: PoolClient, userId: string): Promise<void> {
    const admins = await this.lockActiveSystemAdmins(client);
    if (admins.includes(userId) && !admins.some((id) => id !== userId)) {
      throw new AccessPolicyError('The last active System Admin cannot be removed or disabled', 'ACCESS_LAST_SYSTEM_ADMIN');
    }
  }

  async listUsers(search: string | null): Promise<AdminUser[]> {
    const { rows } = await this.pool.query<AdminUser>(
      `SELECT u.id, u.email, u.display_name, u.is_active, u.is_system_admin, u.created_at,
              (SELECT COUNT(*)::int FROM memberships m WHERE m.user_id = u.id AND m.is_active = TRUE) AS active_memberships
       FROM users u
       WHERE $1::text IS NULL OR u.email ILIKE '%' || $1 || '%'
       ORDER BY LOWER(u.email), u.id
       LIMIT 200`,
      [search],
    );
    return rows;
  }

  async listUserMemberships(userId: string): Promise<AdminUserMembership[] | null> {
    if ((await this.pool.query('SELECT 1 FROM users WHERE id = $1', [userId])).rows.length === 0) return null;
    const { rows } = await this.pool.query<AdminUserMembership>(
      `SELECT m.id, m.company_id, c.name AS company_name, c.name_ar AS company_name_ar, c.is_active AS company_is_active,
              m.role_id, r.name AS role_name, COALESCE(r.is_full_access, FALSE) AS role_is_full_access, m.is_active
       FROM memberships m
       JOIN companies c ON c.id = m.company_id
       LEFT JOIN roles r ON r.id = m.role_id AND r.company_id = m.company_id
       WHERE m.user_id = $1
       ORDER BY c.created_at, c.id`,
      [userId],
    );
    return rows;
  }

  /** Creates an account without any company access; memberships are added separately. Throws pg 23505 on a duplicate email. */
  async createUser(email: string, password: string, actorUserId: string, displayName: string | null = null): Promise<AdminUser> {
    const hash = await bcrypt.hash(password, 12);
    return this.transaction(async (client) => {
      const { rows } = await client.query<AdminUser>(
        `INSERT INTO users (email, password_hash, must_change_password, display_name) VALUES (LOWER($1), $2, TRUE, $3)
         RETURNING id, email, display_name, is_active, is_system_admin, created_at, 0 AS active_memberships`,
        [email, hash, displayName],
      );
      const user = rows[0] as AdminUser;
      await this.log(client, { actor: actorUserId, action: 'system.user.create', target: user.id, before: null, after: { email: user.email, display_name: user.display_name, is_active: true, is_system_admin: false, must_change_password: true } });
      return user;
    });
  }

  async setUserActive(userId: string, active: boolean, actorUserId: string): Promise<AdminUser> {
    return this.transaction(async (client) => {
      if (!active && userId === actorUserId) throw new AccessPolicyError('You cannot disable your own account', 'ACCESS_SELF_LOCKOUT');
      const before = (await client.query<AdminUser>('SELECT id, email, display_name, is_active, is_system_admin, created_at, 0 AS active_memberships FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      if (!before) throw new Error('User not found');
      if (!active && before.is_system_admin) await this.assertNotLastSystemAdmin(client, userId);
      if (!active) {
        // Same rule as membership disable: never leave a company without an active Full Access member.
        const orphaned = await client.query(
          `SELECT m.company_id FROM memberships m JOIN roles r ON r.id = m.role_id AND r.company_id = m.company_id AND r.is_full_access
           WHERE m.user_id = $1 AND m.is_active
             AND NOT EXISTS (SELECT 1 FROM memberships o JOIN roles orl ON orl.id = o.role_id AND orl.company_id = o.company_id AND orl.is_full_access
                             JOIN users ou ON ou.id = o.user_id AND ou.is_active
                             WHERE o.company_id = m.company_id AND o.is_active AND o.user_id <> $1)
           LIMIT 1`,
          [userId],
        );
        if (orphaned.rows.length > 0) throw new AccessPolicyError('The last active Full Access member of a company cannot be disabled', 'ACCESS_LAST_FULL_ACCESS');
      }
      const after = (await client.query<AdminUser>(
        'UPDATE users SET is_active = $2, updated_at = NOW() WHERE id = $1 RETURNING id, email, display_name, is_active, is_system_admin, created_at, 0 AS active_memberships',
        [userId, active],
      )).rows[0] as AdminUser;
      // A disabled account loses every session at once (sessions of active accounts are untouched).
      if (!active) await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      await this.log(client, { actor: actorUserId, action: active ? 'system.user.enable' : 'system.user.disable', target: userId, before: { is_active: before.is_active }, after: { is_active: after.is_active } });
      return after;
    });
  }

  /** Sets or clears an account's display name (migration 095). Only an active System Admin (router and here); audited. */
  async setDisplayName(userId: string, displayName: string | null, actorUserId: string): Promise<AdminUser> {
    return this.transaction(async (client) => {
      if (!(await SystemAdminService.isActiveSystemAdmin(client, actorUserId))) throw new AccessPolicyError('Only an active System Admin can change a display name', 'ACCESS_SYSTEM_ADMIN_REQUIRED');
      const before = (await client.query<AdminUser>('SELECT id, email, display_name, is_active, is_system_admin, created_at, 0 AS active_memberships FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      if (!before) throw new Error('User not found');
      const after = (await client.query<AdminUser>(
        'UPDATE users SET display_name = $2, updated_at = NOW() WHERE id = $1 RETURNING id, email, display_name, is_active, is_system_admin, created_at, 0 AS active_memberships',
        [userId, displayName],
      )).rows[0] as AdminUser;
      if (before.display_name !== after.display_name) {
        await this.log(client, { actor: actorUserId, action: 'system.user.display_name.change', target: userId, before: { display_name: before.display_name }, after: { display_name: after.display_name } });
      }
      return after;
    });
  }

  /** Grants or revokes global System Admin. Only callable by an active System Admin (checked by the router and again here). */
  async setSystemAdmin(userId: string, value: boolean, actorUserId: string): Promise<AdminUser> {
    return this.transaction(async (client) => {
      if (!(await SystemAdminService.isActiveSystemAdmin(client, actorUserId))) throw new AccessPolicyError('Only an active System Admin can change System Admin status', 'ACCESS_SYSTEM_ADMIN_REQUIRED');
      const before = (await client.query<AdminUser>('SELECT id, email, display_name, is_active, is_system_admin, created_at, 0 AS active_memberships FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      if (!before) throw new Error('User not found');
      if (value && !before.is_active) throw new AccessPolicyError('A disabled account cannot become System Admin', 'ACCESS_TARGET_INACTIVE');
      if (!value) await this.assertNotLastSystemAdmin(client, userId);
      const after = (await client.query<AdminUser>(
        'UPDATE users SET is_system_admin = $2, updated_at = NOW() WHERE id = $1 RETURNING id, email, display_name, is_active, is_system_admin, created_at, 0 AS active_memberships',
        [userId, value],
      )).rows[0] as AdminUser;
      if (before.is_system_admin !== after.is_system_admin) {
        await this.log(client, { actor: actorUserId, action: value ? 'system.admin.grant' : 'system.admin.revoke', target: userId, before: { is_system_admin: before.is_system_admin }, after: { is_system_admin: after.is_system_admin } });
      }
      return after;
    });
  }
}

/**
 * One-time bootstrap of the FIRST System Admin (CLI only, never over HTTP). Promotes an EXISTING active account chosen
 * explicitly by email. Refuses when any System Admin already exists, so it cannot be used to add more admins later
 * (that is done by an existing System Admin through the administration API). Serialized by an advisory lock and
 * audited in system_audit_log with actor_label 'bootstrap-cli'. No credentials are created or read here.
 */
export async function bootstrapSystemAdmin(pool: Pool, email: string): Promise<{ userId: string; email: string }> {
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 254 || !EMAIL.test(trimmed)) throw new SystemAdminBootstrapError('INVALID_INPUT', 'Invalid email.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYSTEM_ADMIN_BOOTSTRAP_LOCK_KEY]);
    if ((await client.query('SELECT 1 FROM users WHERE is_system_admin = TRUE LIMIT 1')).rows.length > 0) {
      throw new SystemAdminBootstrapError('ALREADY_INITIALIZED', 'A System Admin already exists; bootstrap is a one-time procedure. Use the administration screen instead.');
    }
    const user = (await client.query<{ id: string; email: string }>('SELECT id, email FROM users WHERE LOWER(email) = LOWER($1) AND is_active = TRUE FOR UPDATE', [trimmed])).rows[0];
    if (!user) throw new SystemAdminBootstrapError('USER_NOT_FOUND', 'No active account with this email. Create the account first; this procedure never creates credentials.');
    await client.query('UPDATE users SET is_system_admin = TRUE, updated_at = NOW() WHERE id = $1', [user.id]);
    await client.query(
      `INSERT INTO system_audit_log (actor_user_id, actor_label, action, target_user_id, before_data, after_data)
       VALUES (NULL, 'bootstrap-cli', 'system.admin.bootstrap', $1, '{"is_system_admin":false}', '{"is_system_admin":true}')`,
      [user.id],
    );
    await client.query('COMMIT');
    return { userId: user.id, email: user.email };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
