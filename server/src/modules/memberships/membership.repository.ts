import { Pool, PoolClient } from 'pg';
import { Membership, Role, CreateMembershipInput, CreateRoleInput } from './membership.types';

type QueryRunner = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface ActiveCompanyMembership {
  membership_id: string;
  company_id: string;
  company_name: string;
  company_name_ar: string | null;
  role_id: string | null;
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

  async findMembershipById(id: string): Promise<Membership | null> {
    const { rows } = await this.pool.query<Membership>(
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

  async findRoleById(id: string): Promise<Role | null> {
    const { rows } = await this.pool.query<Role>(
      'SELECT * FROM roles WHERE id = $1',
      [id],
    );
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

  async getRoleCapabilities(roleId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ capability_id: string }>(
      'SELECT capability_id FROM role_capabilities WHERE role_id = $1',
      [roleId],
    );
    return rows.map((r) => r.capability_id);
  }

  /**
   * Returns the active capabilities for a user in a company.
   * Returns [] when no active membership/role/capability exists.
   */
  async getActiveCapabilities(userId: string, companyId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ capability_id: string }>(
      `SELECT rc.capability_id
       FROM memberships m
       JOIN role_capabilities rc ON rc.role_id = m.role_id
       WHERE m.user_id    = $1
         AND m.company_id = $2
         AND m.is_active  = TRUE
         AND m.role_id IS NOT NULL`,
      [userId, companyId],
    );
    return rows.map((r) => r.capability_id);
  }
}
