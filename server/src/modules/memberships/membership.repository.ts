import { Pool, PoolClient } from 'pg';
import { Membership, MembershipListItem, Role, RoleListItem, CreateMembershipInput, CreateRoleInput } from './membership.types';
import { effectiveRoleCapabilities, isAuthorizationPolicyKey, LEGACY_WILDCARD_READ_CAPABILITIES } from './authorization-policy';

type QueryRunner = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface ActiveCompanyMembership {
  membership_id: string;
  company_id: string;
  company_name: string;
  company_name_ar: string | null;
  role_id: string | null;
}

export interface UserMembershipRow {
  membership_id: string;
  company_id: string;
  company_name: string;
  company_name_ar: string | null;
  company_is_active: boolean;
  is_active: boolean;
  role_id: string | null;
  role_name: string | null;
  role_is_full_access: boolean;
}

/**
 * MembershipRepository
 *
 * Pure data-access layer for memberships, roles, capabilities, and their
 * junction table. Business rules (ceiling, cross-company role validation)
 * live in MembershipService — this layer only enforces DB constraints.
 */
export class MembershipRepository {
  constructor(private readonly pool: Pool) {}

  // ── Memberships ────────────────────────────────────────────────────────────

  /**
   * Create a membership binding user → company.
   * Throws on duplicate (pg unique constraint 23505: user_id + company_id).
   */
  async createMembership(
    input: CreateMembershipInput,
    client?: PoolClient,
  ): Promise<Membership> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<Membership>(
      `INSERT INTO memberships (user_id, company_id)
       VALUES ($1, $2)
       RETURNING *`,
      [input.user_id, input.company_id],
    );
    return rows[0] as Membership;
  }

  async findMembershipById(id: string, client?: PoolClient): Promise<Membership | null> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<Membership>(
      'SELECT * FROM memberships WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  async findMembershipByUserAndCompany(
    userId: string,
    companyId: string,
  ): Promise<Membership | null> {
    const { rows } = await this.pool.query<Membership>(
      'SELECT * FROM memberships WHERE user_id = $1 AND company_id = $2',
      [userId, companyId],
    );
    return rows[0] ?? null;
  }

  /** Includes inactive memberships: a later enable must not turn a delegated role grant into a self-grant. */
  async isUserAssignedRole(userId: string, companyId: string, roleId: string, client: PoolClient): Promise<boolean> {
    const { rows } = await client.query<{ assigned: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id=$1 AND company_id=$2 AND role_id=$3) AS assigned',
      [userId, companyId, roleId],
    );
    return rows[0]?.assigned === true;
  }

  /**
   * Authoritative list of tenant memberships available to an authenticated user.
   * Both the membership and company must be active. Ordering is deterministic so
   * first-login company selection does not depend on query planner behaviour.
   */
  async listActiveCompaniesForUser(userId: string): Promise<ActiveCompanyMembership[]> {
    const { rows } = await this.pool.query<ActiveCompanyMembership>(
      `SELECT
         m.id      AS membership_id,
         m.company_id,
         c.name    AS company_name,
         c.name_ar AS company_name_ar,
         m.role_id
       FROM memberships m
       JOIN companies c ON c.id = m.company_id
       WHERE m.user_id = $1
         AND m.is_active = TRUE
         AND c.is_active = TRUE
       ORDER BY m.created_at ASC, m.company_id ASC`,
      [userId],
    );
    return rows;
  }

  /**
   * Assign a role to an existing membership.
   * The caller (MembershipService) must validate that role.company_id
   * matches membership.company_id before calling this.
   */
  async assignRoleToMembership(
    membershipId: string,
    roleId: string,
    client?: PoolClient,
  ): Promise<Membership> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<Membership>(
      `UPDATE memberships
       SET role_id = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [roleId, membershipId],
    );
    if (!rows[0]) throw new Error(`Membership ${membershipId} not found`);
    return rows[0] as Membership;
  }

  // ── Roles ──────────────────────────────────────────────────────────────────

  async createRole(input: CreateRoleInput, client?: PoolClient): Promise<Role> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<Role>(
      `INSERT INTO roles (company_id, name)
       VALUES ($1, $2)
       RETURNING *`,
      [input.company_id, input.name],
    );
    return rows[0] as Role;
  }

  async findRoleById(id: string, client?: PoolClient): Promise<Role | null> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<Role>(
      'SELECT * FROM roles WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  async renameRole(id: string, companyId: string, name: string, client: PoolClient): Promise<Role | null> {
    const { rows } = await client.query<Role>('UPDATE roles SET name = $3 WHERE id = $1 AND company_id = $2 RETURNING *', [id, companyId, name]);
    return rows[0] ?? null;
  }

  /** Every membership of one user with company and role display fields. Callers MUST filter to the actor's visible companies. */
  async listMembershipsOfUser(userId: string): Promise<UserMembershipRow[]> {
    const { rows } = await this.pool.query<UserMembershipRow>(
      `SELECT m.id AS membership_id, m.company_id, c.name AS company_name, c.name_ar AS company_name_ar, c.is_active AS company_is_active,
              m.is_active, m.role_id, r.name AS role_name, COALESCE(r.is_full_access, FALSE) AS role_is_full_access
       FROM memberships m
       JOIN companies c ON c.id = m.company_id
       LEFT JOIN roles r ON r.id = m.role_id AND r.company_id = m.company_id
       WHERE m.user_id = $1
       ORDER BY c.created_at, c.id`,
      [userId],
    );
    return rows;
  }

  async findUserSummary(userId: string): Promise<{ id: string; email: string; is_active: boolean; is_system_admin: boolean } | null> {
    const { rows } = await this.pool.query<{ id: string; email: string; is_active: boolean; is_system_admin: boolean }>(
      'SELECT id, email, is_active, is_system_admin FROM users WHERE id = $1', [userId]);
    return rows[0] ?? null;
  }

  async addCapabilityToRole(
    roleId: string,
    capabilityId: string,
    client?: PoolClient,
  ): Promise<void> {
    const runner: QueryRunner = client ?? this.pool;
    await runner.query(
      `INSERT INTO role_capabilities (role_id, capability_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [roleId, capabilityId],
    );
  }

  async getRoleCapabilities(roleId: string, client?: PoolClient): Promise<string[]> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<{ capability_id: string }>(
      'SELECT capability_id FROM role_capabilities WHERE role_id = $1',
      [roleId],
    );
    return rows.map((r) => r.capability_id);
  }

  /** Memberships of one company only, with display fields for the administration UI. */
  async listMemberships(companyId: string): Promise<MembershipListItem[]> {
    const { rows } = await this.pool.query<MembershipListItem>(
      `SELECT m.*, u.email AS user_email, u.is_active AS user_is_active, r.name AS role_name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN roles r ON r.id = m.role_id AND r.company_id = m.company_id
       WHERE m.company_id = $1
       ORDER BY m.created_at, m.id`,
      [companyId],
    );
    return rows;
  }

  /** Roles of one company only, each with its explicit capability ids. */
  async listRoles(companyId: string): Promise<RoleListItem[]> {
    const { rows } = await this.pool.query<RoleListItem>(
      `SELECT r.*,
              ARRAY(SELECT rc.capability_id FROM role_capabilities rc
                    WHERE rc.role_id = r.id ORDER BY rc.capability_id) AS capabilities
       FROM roles r
       WHERE r.company_id = $1
       ORDER BY r.name, r.id`,
      [companyId],
    );
    return rows;
  }

  /** Resolve one role's grants for delegation checks; policy overlays never mutate explicit grants. */
  async getEffectiveRoleCapabilities(roleId: string, client?: PoolClient): Promise<string[]> {
    const runner: QueryRunner = client ?? this.pool;
    const role = (await runner.query<{ company_id: string; is_full_access: boolean; authorization_policy_key: string | null; authorization_policy_version: number }>(
      'SELECT company_id, is_full_access, authorization_policy_key, authorization_policy_version FROM roles WHERE id = $1', [roleId],
    )).rows[0];
    if (!role) return [];
    const [explicit, catalog] = await Promise.all([
      this.getRoleCapabilities(roleId, client),
      runner.query<{ id: string; implicit_full_access: boolean }>('SELECT id, implicit_full_access FROM capabilities'),
    ]);
    const capabilities = catalog.rows.map((row) => row.id);
    const stored = role.is_full_access
      ? [...new Set([...explicit, ...LEGACY_WILDCARD_READ_CAPABILITIES, ...catalog.rows.filter((row) => row.implicit_full_access).map((row) => row.id)])]
      : explicit;
    return effectiveRoleCapabilities(
      !role.is_full_access && isAuthorizationPolicyKey(role.authorization_policy_key) ? role.authorization_policy_key : null,
      Number(role.authorization_policy_version),
      stored,
      capabilities,
    );
  }

  async listCapabilities(): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM capabilities ORDER BY id');
    return rows.map((row) => row.id);
  }

  async findUserIdByEmail(email: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email],
    );
    return rows[0]?.id ?? null;
  }

  async setMembershipActive(id: string, companyId: string, active: boolean, client: PoolClient): Promise<Membership | null> {
    const { rows } = await client.query<Membership>(
      'UPDATE memberships SET is_active = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2 RETURNING *',
      [id, companyId, active],
    );
    return rows[0] ?? null;
  }

  async removeCapabilityFromRole(roleId: string, capabilityId: string, client: PoolClient): Promise<void> {
    await client.query(
      'DELETE FROM role_capabilities WHERE role_id = $1 AND capability_id = $2',
      [roleId, capabilityId],
    );
  }

  /**
   * Row-locks (FOR UPDATE) every active Full Access membership of the company and returns their ids.
   * Concurrent disable/demote transactions serialize here, so the "last Full Access member" check cannot be raced.
   */
  async lockActiveFullAccessMembershipIds(companyId: string, client: PoolClient): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT m.id
       FROM memberships m
       JOIN roles r ON r.id = m.role_id AND r.company_id = m.company_id
       WHERE m.company_id = $1 AND m.is_active = TRUE AND r.is_full_access = TRUE
       ORDER BY m.id
       FOR UPDATE OF m`,
      [companyId],
    );
    return rows.map((row) => row.id);
  }

  /** Whether the user currently holds an active Full Access role in this company. */
  async hasActiveFullAccessRole(userId: string, companyId: string, client?: PoolClient): Promise<boolean> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<{ has_full_access: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM memberships m
         JOIN companies c ON c.id = m.company_id AND c.is_active = TRUE
         JOIN roles r ON r.id = m.role_id AND r.company_id = m.company_id
         WHERE m.user_id = $1
           AND m.company_id = $2
           AND m.is_active = TRUE
           AND r.is_full_access = TRUE
       ) AS has_full_access`,
      [userId, companyId],
    );
    return rows[0]?.has_full_access === true;
  }

  /** An account a company administrator may attach: it exists, is active and is not a System Admin. */
  async isAttachableUser(userId: string, client?: PoolClient): Promise<boolean> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<{ ok: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND is_active = TRUE AND is_system_admin = FALSE) AS ok',
      [userId],
    );
    return rows[0]?.ok === true;
  }

  /** Which of these users are active System Admins (list flags only). */
  async listActiveSystemAdminIds(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_active = TRUE AND is_system_admin = TRUE',
      [userIds],
    );
    return new Set(rows.map((r) => r.id));
  }

  /** Whether the user is an active global System Admin (users.is_system_admin, migration 075). */
  /** True when the user has a membership (active or not) in any company other than `companyId`. */
  async hasMembershipOutsideCompany(userId: string, companyId: string, client?: PoolClient): Promise<boolean> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query(
      'SELECT 1 FROM memberships WHERE user_id = $1 AND company_id <> $2 LIMIT 1',
      [userId, companyId],
    );
    return rows.length > 0;
  }

  async isActiveSystemAdmin(userId: string, client?: PoolClient): Promise<boolean> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<{ ok: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND is_active = TRUE AND is_system_admin = TRUE) AS ok',
      [userId],
    );
    return rows[0]?.ok === true;
  }

  /**
   * Every active company, for an active System Admin's company switcher (the caller has already verified System
   * Admin status). Companies where the admin is an active member come first; membership_id/role_id are null otherwise.
   */
  async listAllActiveCompaniesForSystemAdmin(userId: string): Promise<ActiveCompanyMembership[]> {
    const { rows } = await this.pool.query<ActiveCompanyMembership>(
      `SELECT
         m.id      AS membership_id,
         c.id      AS company_id,
         c.name    AS company_name,
         c.name_ar AS company_name_ar,
         m.role_id
       FROM companies c
       LEFT JOIN memberships m ON m.company_id = c.id AND m.user_id = $1 AND m.is_active = TRUE
       WHERE c.is_active = TRUE
       ORDER BY (m.id IS NULL) ASC, m.created_at ASC NULLS LAST, c.created_at ASC, c.id ASC`,
      [userId],
    );
    return rows;
  }

  /**
   * The single source of capability resolution (session context, administration ceilings, company management).
   * Version 0 preserves legacy grants and wildcard exceptions. Version 1 adds the central target policy for a
   * System Administrator or standard company role. Full Access remains company-scoped and retains its existing
   * payroll accounting and settlement read exceptions. The explicit roles/company join prevents cross-company role_id use.
   */
  /** Role of the user's ACTIVE membership in an active company (display only; authorization uses capabilities). */
  async getActiveRole(userId: string, companyId: string, client?: PoolClient): Promise<{ name: string; is_full_access: boolean } | null> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<{ name: string; is_full_access: boolean }>(
      `SELECT r.name, r.is_full_access
       FROM memberships m
       JOIN companies c ON c.id = m.company_id AND c.is_active = TRUE
       JOIN roles r ON r.id = m.role_id AND r.company_id = m.company_id
       WHERE m.user_id = $1 AND m.company_id = $2 AND m.is_active = TRUE`,
      [userId, companyId],
    );
    return rows[0] ?? null;
  }

  async getActiveCapabilities(userId: string, companyId: string, client?: PoolClient): Promise<string[]> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<{
      capability_id: string;
      currently_authorized: boolean;
      is_system_admin: boolean;
      system_admin_policy_version: number;
      role_policy_key: string | null;
      role_policy_version: number;
      role_is_full_access: boolean;
    }>(
      `SELECT cap.id AS capability_id,
              ((cap.implicit_full_access OR cap.id = ANY($3::text[])) AND u.is_system_admin)
                 OR (m.is_active AND ((r.is_full_access AND (cap.implicit_full_access OR cap.id = ANY($3::text[]))) OR EXISTS (
                   SELECT 1 FROM role_capabilities rc WHERE rc.role_id = r.id AND rc.capability_id = cap.id
                 ))) AS currently_authorized,
              u.is_system_admin,
              u.system_admin_policy_version,
              r.authorization_policy_key AS role_policy_key,
              COALESCE(r.authorization_policy_version, 0) AS role_policy_version,
              COALESCE(r.is_full_access, FALSE) AS role_is_full_access
       FROM users u
       JOIN companies c ON c.id = $2 AND c.is_active = TRUE
       CROSS JOIN capabilities cap
       LEFT JOIN memberships m ON m.user_id = u.id AND m.company_id = c.id AND m.is_active = TRUE
       LEFT JOIN roles r ON r.id = m.role_id AND r.company_id = m.company_id
       WHERE u.id = $1 AND u.is_active = TRUE
         AND (
           ((cap.implicit_full_access OR cap.id = ANY($3::text[])) AND u.is_system_admin)
           OR (m.is_active AND ((r.is_full_access AND (cap.implicit_full_access OR cap.id = ANY($3::text[]))) OR EXISTS (
             SELECT 1 FROM role_capabilities rc WHERE rc.role_id = r.id AND rc.capability_id = cap.id
           )))
           OR (u.is_system_admin AND u.system_admin_policy_version >= 1)
           OR (NOT COALESCE(r.is_full_access, FALSE) AND r.authorization_policy_version >= 1
               AND r.authorization_policy_key IN ('company_manager', 'finance_manager'))
        )`,
      [userId, companyId, [...LEGACY_WILDCARD_READ_CAPABILITIES]],
    );
    if (!rows.length) return [];
    const result = new Set(rows.filter((row) => row.currently_authorized).map((row) => row.capability_id));
    const catalog = rows.map((row) => row.capability_id);
    const first = rows[0]!;
    if (first.is_system_admin && Number(first.system_admin_policy_version) >= 1) {
      for (const id of catalog) result.add(id);
    }
    if (!first.role_is_full_access && Number(first.role_policy_version) >= 1 && isAuthorizationPolicyKey(first.role_policy_key)) {
      for (const id of effectiveRoleCapabilities(first.role_policy_key, 1, [], catalog)) result.add(id);
    }
    return [...result].sort();
  }
}
