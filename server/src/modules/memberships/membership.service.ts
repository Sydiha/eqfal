import { Pool, PoolClient } from 'pg';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipListItem, CreateMembershipInput, CreateRoleInput, Role, RoleListItem } from './membership.types';
import logger from '../../shared/logger';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import bcrypt from 'bcrypt';
import { UserRepository } from '../users/user.repository';

/**
 * MembershipService
 *
 * Enforces all business rules for memberships, roles, and capabilities:
 *
 *  Cross-company isolation
 *    – A role from company B cannot be assigned to a membership in company A.
 *      Validated before any DB write.
 *
 *  Capability ceiling
 *    – A granter cannot assign a role whose capabilities exceed their own.
 *      This covers self-escalation as a special case: assigning yourself
 *      a role with capability X when you don't already have X is rejected.
 *
 *  Membership state
 *    – is_active = false blocks getCapabilities / isAuthorized entirely,
 *      without touching the underlying user account.
 *
 * No UI, session redesign, or external / paid services.
 * Administration mutations use the permanent Audit Trail transactionally.
 */
export class MembershipService {
  private readonly repo: MembershipRepository;
  private readonly audit = new AuditLogRepository();

  constructor(private readonly pool: Pool) {
    this.repo = new MembershipRepository(pool);
  }

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

  async listMemberships(companyId: string): Promise<MembershipListItem[]> {
    return this.repo.listMemberships(companyId);
  }

  async listRoles(companyId: string): Promise<RoleListItem[]> {
    return this.repo.listRoles(companyId);
  }

  async listCapabilities(): Promise<string[]> {
    return this.repo.listCapabilities();
  }

  /** Resolve an existing user by email so they can be added to the active company. */
  async createMembershipByEmail(email: string, companyId: string, actorUserId: string): Promise<Membership> {
    const userId = await this.repo.findUserIdByEmail(email);
    if (!userId) throw new Error('User not found');
    return this.createMembershipForCompany(userId, companyId, actorUserId);
  }

  async createMembershipForCompany(userId: string, companyId: string, actorUserId: string): Promise<Membership> {
    return this.transaction(async (client) => {
      const membership = await this.repo.createMembership({ user_id: userId, company_id: companyId }, client);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.membership.create', entity_type: 'membership', entity_id: membership.id, before_data: null, after_data: this.membershipSnapshot(membership) }, client);
      return membership;
    });
  }

  /**
   * Create a brand-new user account and attach it to the active company in one
   * transaction (user + membership + optional role + audit). The password is
   * hashed with bcrypt here; the plaintext is never stored or logged.
   * Throws pg 23505 when the email already has an account.
   */
  async createUserForCompany(email: string, password: string, roleId: string | null, companyId: string, actorUserId: string): Promise<Membership> {
    const hash = await bcrypt.hash(password, 12);
    return this.transaction(async (client) => {
      const role = roleId ? await this.repo.findRoleById(roleId, client) : null;
      if (roleId && (!role || role.company_id !== companyId)) throw new Error('Role not found');
      const user = await new UserRepository(this.pool).create({ email, password: hash }, client);
      let membership = await this.repo.createMembership({ user_id: user.id, company_id: companyId }, client);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.user.create', entity_type: 'user', entity_id: user.id, before_data: null, after_data: { email: user.email, company_id: companyId } }, client);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.membership.create', entity_type: 'membership', entity_id: membership.id, before_data: null, after_data: this.membershipSnapshot(membership) }, client);
      if (role) {
        await this.assertCanAssign(membership, role, actorUserId, client);
        const before = membership;
        membership = await this.repo.assignRoleToMembership(membership.id, role.id, client);
        await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.membership.role.assign', entity_type: 'membership', entity_id: membership.id, before_data: this.membershipSnapshot(before), after_data: this.membershipSnapshot(membership) }, client);
      }
      return membership;
    });
  }

  async setMembershipActive(id: string, companyId: string, active: boolean, actorUserId: string): Promise<Membership> {
    return this.transaction(async (client) => {
      const before = await this.repo.findMembershipById(id, client);
      if (!before || before.company_id !== companyId) throw new Error('Membership not found');
      const after = await this.repo.setMembershipActive(id, companyId, active, client);
      if (!after) throw new Error('Membership not found');
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: active ? 'access.membership.enable' : 'access.membership.disable', entity_type: 'membership', entity_id: id, before_data: this.membershipSnapshot(before), after_data: this.membershipSnapshot(after) }, client);
      return after;
    });
  }

  async createRoleForCompany(name: string, companyId: string, actorUserId: string): Promise<Role> {
    return this.transaction(async (client) => {
      const role = await this.repo.createRole({ name, company_id: companyId }, client);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.role.create', entity_type: 'role', entity_id: role.id, before_data: null, after_data: this.roleSnapshot(role) }, client);
      return role;
    });
  }

  async assignRoleForCompany(membershipId: string, roleId: string, companyId: string, actorUserId: string): Promise<Membership> {
    return this.transaction(async (client) => {
      const before = await this.repo.findMembershipById(membershipId, client);
      const role = await this.repo.findRoleById(roleId, client);
      if (!before || before.company_id !== companyId) throw new Error('Membership not found');
      if (!role || role.company_id !== companyId) throw new Error('Role not found');
      await this.assertCanAssign(before, role, actorUserId, client);
      const after = await this.repo.assignRoleToMembership(membershipId, roleId, client);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.membership.role.assign', entity_type: 'membership', entity_id: membershipId, before_data: this.membershipSnapshot(before), after_data: this.membershipSnapshot(after) }, client);
      return after;
    });
  }

  async changeRoleCapability(roleId: string, capabilityId: string, companyId: string, actorUserId: string, add: boolean): Promise<void> {
    return this.transaction(async (client) => {
      const role = await this.repo.findRoleById(roleId, client);
      if (!role || role.company_id !== companyId) throw new Error('Role not found');
      if (role.is_full_access) throw new Error('Full Access role capabilities cannot be changed');
      const actorCapabilities = await this.repo.getActiveCapabilities(actorUserId, companyId, client);
      if (add && !actorCapabilities.includes(capabilityId)) throw new Error(`Ceiling violation: granter lacks capability '${capabilityId}'`);
      const before = await this.repo.getRoleCapabilities(roleId, client);
      if (add) await this.repo.addCapabilityToRole(roleId, capabilityId, client);
      else await this.repo.removeCapabilityFromRole(roleId, capabilityId, client);
      const after = add ? [...new Set([...before, capabilityId])] : before.filter((id) => id !== capabilityId);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: add ? 'access.role.capability.add' : 'access.role.capability.remove', entity_type: 'role', entity_id: roleId, before_data: { capabilities: before }, after_data: { capabilities: after } }, client);
    });
  }

  /**
   * Atomic multi-capability change for one role. Same checks as changeRoleCapability (role in the active company,
   * not Full Access, grants within the actor's ceiling) but every request is validated before anything is written
   * and the whole change commits or rolls back together with a single audit event.
   */
  async changeRoleCapabilities(roleId: string, grants: string[], revokes: string[], companyId: string, actorUserId: string): Promise<void> {
    const known = new Set(await this.repo.listCapabilities());
    for (const id of [...grants, ...revokes]) if (!known.has(id)) throw new Error(`Capability not found: '${id}'`);
    return this.transaction(async (client) => {
      const role = await this.repo.findRoleById(roleId, client);
      if (!role || role.company_id !== companyId) throw new Error('Role not found');
      if (role.is_full_access) throw new Error('Full Access role capabilities cannot be changed');
      const actorCapabilities = await this.repo.getActiveCapabilities(actorUserId, companyId, client);
      for (const id of grants) if (!actorCapabilities.includes(id)) throw new Error(`Ceiling violation: granter lacks capability '${id}'`);
      const before = await this.repo.getRoleCapabilities(roleId, client);
      for (const id of grants) await this.repo.addCapabilityToRole(roleId, id, client);
      for (const id of revokes) await this.repo.removeCapabilityFromRole(roleId, id, client);
      const after = [...new Set([...before, ...grants])].filter((id) => !revokes.includes(id));
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.role.capability.bulk_change', entity_type: 'role', entity_id: roleId, before_data: { capabilities: before }, after_data: { capabilities: after } }, client);
    });
  }

  private membershipSnapshot(value: Membership): Record<string, unknown> {
    return { user_id: value.user_id, company_id: value.company_id, role_id: value.role_id, is_active: value.is_active };
  }

  private roleSnapshot(value: Role): Record<string, unknown> {
    return { company_id: value.company_id, name: value.name, is_full_access: value.is_full_access };
  }

  private async assertCanAssign(membership: Membership, role: Role, actorUserId: string, client?: PoolClient): Promise<void> {
    if (role.company_id !== membership.company_id) throw new Error('Cross-company violation');
    if (role.is_full_access && !(await this.repo.hasActiveFullAccessRole(actorUserId, membership.company_id, client))) {
      throw new Error('Full Access violation: granter must hold Full Access in the target company');
    }
    const [granterCaps, roleCaps] = await Promise.all([
      this.repo.getActiveCapabilities(actorUserId, membership.company_id, client),
      this.repo.getRoleCapabilities(role.id, client),
    ]);
    for (const capability of roleCaps) {
      if (!granterCaps.includes(capability)) throw new Error(`Ceiling violation: granter lacks capability '${capability}'`);
    }
  }

  // ── Membership lifecycle ───────────────────────────────────────────────────

  /**
   * Create a membership binding user → company.
   * Throws (pg 23505) if membership already exists.
   */
  async createMembership(input: CreateMembershipInput): Promise<Membership> {
    const membership = await this.repo.createMembership(input);
    logger.info({ membershipId: membership.id }, 'Membership created');
    return membership;
  }

  // ── Role management ────────────────────────────────────────────────────────

  /** Create a role scoped to a company. */
  async createRole(input: CreateRoleInput): Promise<Role> {
    return this.repo.createRole(input);
  }

  /** Attach a capability to a role. Idempotent. */
  async addCapabilityToRole(roleId: string, capabilityId: string): Promise<void> {
    return this.repo.addCapabilityToRole(roleId, capabilityId);
  }

  // ── Role assignment with security checks ──────────────────────────────────

  /**
   * Assign a role to a membership.
   *
   * Security checks (both must pass before any write):
   *
   *  1. Cross-company: role.company_id must equal membership.company_id.
   *     Prevents assigning a company-B role to a company-A membership.
   *
   *  2. Capability ceiling: the granter's active capabilities must be a
   *     superset of the role's capabilities. This prevents privilege escalation
   *     and covers self-escalation (granter = target) as a special case.
   *
   * The company context used for the ceiling check is derived from
   * membership.company_id (fetched from DB) — never from a caller-supplied
   * parameter. This prevents a granter from substituting a different company
   * where they hold higher capabilities to bypass the ceiling.
   *
   * @param membershipId  Membership to receive the role.
   * @param roleId        Role to assign.
   * @param granterUserId User performing the assignment.
   */
  async assignRole(
    membershipId: string,
    roleId: string,
    granterUserId: string,
  ): Promise<Membership> {
    const [membership, role] = await Promise.all([
      this.repo.findMembershipById(membershipId),
      this.repo.findRoleById(roleId),
    ]);

    if (!membership) throw new Error('Membership not found');
    if (!role) throw new Error('Role not found');

    // ── Check 1: cross-company role guard ──────────────────────────────────
    if (role.company_id !== membership.company_id) {
      throw new Error(
        `Cross-company violation: role belongs to company '${role.company_id}' ` +
        `but membership is in company '${membership.company_id}'`,
      );
    }

    // ── Check 2: Full Access assignment authority ─────────────────────────
    // Holding every explicit capability is not equivalent to Full Access.
    // Authority is checked in the DB-derived target company context.
    if (
      role.is_full_access &&
      !(await this.repo.hasActiveFullAccessRole(granterUserId, membership.company_id))
    ) {
      throw new Error(
        'Full Access violation: granter must hold Full Access in the target company',
      );
    }

    // ── Check 3: capability ceiling ────────────────────────────────────────
    // Company context is derived from membership.company_id (DB-sourced),
    // not from any caller-supplied value, to prevent cross-company ceiling bypass.
    const [granterCaps, roleCaps] = await Promise.all([
      this.repo.getActiveCapabilities(granterUserId, membership.company_id),
      this.repo.getRoleCapabilities(roleId),
    ]);

    const granterCapSet = new Set(granterCaps);
    for (const cap of roleCaps) {
      if (!granterCapSet.has(cap)) {
        throw new Error(
          `Ceiling violation: granter lacks capability '${cap}' — ` +
          `cannot grant a role that includes it`,
        );
      }
    }

    logger.info(
      { membershipId, roleId, granterUserId },
      'Role assigned',
    );
    return this.repo.assignRoleToMembership(membershipId, roleId);
  }

  // ── Authorization queries ──────────────────────────────────────────────────

  /**
   * Returns the active capability IDs for a user in a company.
   * Returns [] if the membership is disabled, has no role, or has no capabilities.
   */
  async getCapabilities(userId: string, companyId: string): Promise<string[]> {
    return this.repo.getActiveCapabilities(userId, companyId);
  }

  /**
   * Returns true only when:
   *   – An active membership exists for user in company
   *   – The membership's role includes the requested capability
   */
  async isAuthorized(
    userId: string,
    companyId: string,
    capability: string,
  ): Promise<boolean> {
    const caps = await this.repo.getActiveCapabilities(userId, companyId);
    return caps.includes(capability);
  }
}
