import { Pool } from 'pg';
import { MembershipRepository } from './membership.repository';
import { Membership, CreateMembershipInput, CreateRoleInput, Role } from './membership.types';
import logger from '../../shared/logger';

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
 * No UI, sessions, middleware, Fiscal Years, or Audit tables.
 * No external / paid services.
 */
export class MembershipService {
  private readonly repo: MembershipRepository;

  constructor(pool: Pool) {
    this.repo = new MembershipRepository(pool);
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

    // ── Check 2: capability ceiling ────────────────────────────────────────
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
