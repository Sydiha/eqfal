import { Pool, PoolClient } from 'pg';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipDetails, MembershipListItem, RoleCloneResult, UserCompanyAccess, CreateMembershipInput, CreateRoleInput, Role, RoleListItem } from './membership.types';
import logger from '../../shared/logger';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import bcrypt from 'bcrypt';
import { UserRepository } from '../users/user.repository';
import { AccessPolicyError } from './access-policy-error';
import { SessionRepository } from '../auth/session.repository';
import { generateTemporaryPassword } from '../users/password-policy';

/** Delegable, company-scoped authority to grant, demote or manage Full Access (migration 075). */
export const FULL_ACCESS_GRANT = 'access.full_access.grant';

/**
 * Administrative delegation authority (Phase B2): every access.* capability except the read-only access.view. These are
 * the ONLY capabilities bound by the granter ceiling for other members; functional (accounting/operational) capabilities
 * are not, so a Company Manager may staff Accountant/Finance Manager/Operations roles without holding their capabilities.
 */
export const isAdministrativeCapability = (id: string): boolean => id.startsWith('access.') && id !== 'access.view';

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

  /** Members of the company. With an actor, each row carries can_manage: the same rule the server enforces on writes. */
  async listMemberships(companyId: string, actorUserId?: string): Promise<MembershipListItem[]> {
    const members = await this.repo.listMemberships(companyId);
    if (!actorUserId) return members;
    const [roles, actorIsSystemAdmin, hasGrant, systemAdmins] = await Promise.all([
      this.repo.listRoles(companyId),
      this.repo.isActiveSystemAdmin(actorUserId),
      this.holdsFullAccessAuthority(actorUserId, companyId),
      this.repo.listActiveSystemAdminIds(members.map((m) => m.user_id)),
    ]);
    const byRole = new Map(roles.map((r) => [r.id, r]));
    return members.map((m) => {
      const role = m.role_id ? byRole.get(m.role_id) : undefined;
      return { ...m, can_manage: !this.targetBlocked(m, actorUserId, hasGrant, actorIsSystemAdmin, systemAdmins.has(m.user_id), role, role?.capabilities ?? []) };
    });
  }

  /** Roles of the company. With an actor: assignable (may be given to others) and editable (capabilities may change). */
  async listRoles(companyId: string, actorUserId?: string): Promise<RoleListItem[]> {
    const roles = await this.repo.listRoles(companyId);
    if (!actorUserId) return roles;
    const [actorCaps, hasGrant] = await Promise.all([this.repo.getActiveCapabilities(actorUserId, companyId), this.holdsFullAccessAuthority(actorUserId, companyId)]);
    return roles.map((r) => ({
      ...r,
      assignable: r.is_full_access ? hasGrant : r.capabilities.filter(isAdministrativeCapability).every((id) => actorCaps.includes(id)),
      editable: !r.is_full_access && (hasGrant || !r.capabilities.some(isAdministrativeCapability)),
    }));
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
      // A System Admin account or a disabled account is reported exactly like an unknown one (no probing, no attaching).
      if (!(await this.repo.isAttachableUser(userId, client))) throw new Error('User not found');
      const membership = await this.repo.createMembership({ user_id: userId, company_id: companyId }, client);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.membership.create', entity_type: 'membership', entity_id: membership.id, before_data: null, after_data: this.membershipSnapshot(membership) }, client);
      return membership;
    });
  }

  /**
   * Add an existing account to a company with an optional role in one transaction (membership + role + audit), with the
   * same ceiling and Full Access rules as a separate assignment. The company must be active. Used by System Admin
   * administration, where the company comes from the request path and is verified here, never trusted for authorization.
   */
  async addUserToCompany(userId: string, companyId: string, roleId: string | null, actorUserId: string): Promise<Membership> {
    return this.transaction(async (client) => {
      const company = (await client.query<{ is_active: boolean }>('SELECT is_active FROM companies WHERE id = $1', [companyId])).rows[0];
      if (!company) throw new Error('Company not found');
      if (!company.is_active) throw new AccessPolicyError('Company is disabled; enable it before changing access', 'ACCESS_COMPANY_INACTIVE');
      if ((await client.query('SELECT 1 FROM users WHERE id = $1', [userId])).rows.length === 0) throw new Error('User not found');
      const role = roleId ? await this.repo.findRoleById(roleId, client) : null;
      if (roleId && (!role || role.company_id !== companyId)) throw new Error('Role not found');
      let membership = await this.repo.createMembership({ user_id: userId, company_id: companyId }, client);
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

  /** The company a membership belongs to (DB-derived), or null. Lets global administration route by membership id. */
  async membershipCompanyId(membershipId: string): Promise<string | null> {
    return (await this.repo.findMembershipById(membershipId))?.company_id ?? null;
  }

  /**
   * Create a brand-new user account and attach it to the active company in one
   * transaction (user + membership + optional role + audit). The password is
   * hashed with bcrypt here; the plaintext is never stored or logged. The new user must replace the
   * administrator-chosen password at first login (must_change_password); existing users are untouched.
   * Throws pg 23505 when the email already has an account.
   */
  async createUserForCompany(email: string, password: string, roleId: string | null, companyId: string, actorUserId: string): Promise<Membership> {
    const hash = await bcrypt.hash(password, 12);
    return this.transaction(async (client) => {
      const role = roleId ? await this.repo.findRoleById(roleId, client) : null;
      if (roleId && (!role || role.company_id !== companyId)) throw new Error('Role not found');
      const user = await new UserRepository(this.pool).create({ email, password: hash, mustChangePassword: true }, client);
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

  /**
   * Administrative password reset. The target is resolved from the membership id INSIDE the active company (unknown or
   * foreign ids are indistinguishable: "Membership not found"). Authority: the same target rule as every other membership
   * change (Full Access, equal-authority managers and System Admins are out of reach without the matching authority), no
   * self-reset, and an account that also belongs to another company can only be reset by an active System Admin, because a
   * password is global to the account and would otherwise let one company lock out another's staff. A temporary password is
   * generated here, stored only as a bcrypt hash and returned once; every session of the target ends and the target must
   * choose a new password at next login. The audit record never contains the password or hash.
   */
  async resetPassword(membershipId: string, companyId: string, actorUserId: string): Promise<{ temporaryPassword: string }> {
    const temporaryPassword = generateTemporaryPassword();
    const hash = await bcrypt.hash(temporaryPassword, 12);
    await this.transaction(async (client) => {
      const target = await this.repo.findMembershipById(membershipId, client);
      if (!target || target.company_id !== companyId) throw new Error('Membership not found');
      if (target.user_id === actorUserId) throw new AccessPolicyError('Use Change password for your own account', 'ACCESS_SELF_PASSWORD_RESET');
      await this.assertCanManageTarget(target, actorUserId, client);
      if (!(await this.repo.isActiveSystemAdmin(actorUserId, client)) && (await this.repo.hasMembershipOutsideCompany(target.user_id, companyId, client))) {
        throw new AccessPolicyError('The account belongs to another company', 'ACCESS_PASSWORD_RESET_CROSS_COMPANY');
      }
      await new UserRepository(this.pool).setPassword(target.user_id, hash, true, client);
      await new SessionRepository(this.pool).deleteAllForUser(target.user_id, client);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.user.password.reset', entity_type: 'user', entity_id: target.user_id, before_data: null, after_data: { membership_id: target.id, must_change_password: true, sessions_revoked: true } }, client);
    });
    return { temporaryPassword };
  }

  async setMembershipActive(id: string, companyId: string, active: boolean, actorUserId: string): Promise<Membership> {
    return this.transaction(async (client) => {
      const before = await this.repo.findMembershipById(id, client);
      if (!before || before.company_id !== companyId) throw new Error('Membership not found');
      if (!active && before.user_id === actorUserId) throw new AccessPolicyError('You cannot disable your own membership', 'ACCESS_SELF_LOCKOUT');
      await this.assertCanManageTarget(before, actorUserId, client);
      if (!active) await this.assertNotLastFullAccess(before, null, client);
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

  /**
   * Clone a role of this company into a NEW role with the same functional capabilities. Nothing is assigned to anyone.
   * A Full Access role is a wildcard and is never cloned; administrative (access.*) capabilities are never copied
   * silently: they are reported as omitted and must be granted afterwards through the ceiling-checked grant flow.
   */
  async cloneRole(sourceRoleId: string, name: string, companyId: string, actorUserId: string): Promise<RoleCloneResult> {
    return this.transaction(async (client) => {
      const source = await this.repo.findRoleById(sourceRoleId, client);
      if (!source || source.company_id !== companyId) throw new Error('Role not found');
      if (source.is_full_access) throw new AccessPolicyError('Full Access role cannot be cloned', 'ACCESS_FULL_ACCESS_IMMUTABLE');
      const sourceCaps = [...(await this.repo.getRoleCapabilities(sourceRoleId, client))].sort();
      const copied = sourceCaps.filter((id) => !isAdministrativeCapability(id));
      const omitted = sourceCaps.filter(isAdministrativeCapability);
      const role = await this.repo.createRole({ name, company_id: companyId }, client);
      for (const id of copied) await this.repo.addCapabilityToRole(role.id, id, client);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.role.clone', entity_type: 'role', entity_id: role.id,
        before_data: { source_role_id: source.id, source_name: source.name, source_capabilities: sourceCaps },
        after_data: { ...this.roleSnapshot(role), capabilities: copied, omitted_administrative_capabilities: omitted } }, client);
      return { role, copied_capabilities: copied, omitted_capabilities: omitted };
    });
  }

  /** Rename an ordinary role. Permissions and memberships are untouched; Full Access is protected; admin-bearing roles need grant authority. */
  async renameRole(roleId: string, name: string, companyId: string, actorUserId: string): Promise<Role> {
    return this.transaction(async (client) => {
      const role = await this.repo.findRoleById(roleId, client);
      if (!role || role.company_id !== companyId) throw new Error('Role not found');
      if (role.is_full_access) throw new AccessPolicyError('Full Access role cannot be renamed', 'ACCESS_FULL_ACCESS_IMMUTABLE');
      await this.assertCanEditRole(roleId, companyId, actorUserId, client);
      if (role.name === name) return role;
      const renamed = await this.repo.renameRole(roleId, companyId, name, client);
      if (!renamed) throw new Error('Role not found');
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.role.rename', entity_type: 'role', entity_id: roleId, before_data: this.roleSnapshot(role), after_data: this.roleSnapshot(renamed) }, client);
      return renamed;
    });
  }

  /**
   * Consolidated view of one member. The membership id must belong to the ACTIVE company (otherwise "not found"). Other
   * companies of the same account appear only where the actor may view access administration (access.view there, or an
   * active System Admin); everything else is omitted without any count or hint.
   */
  async getMembershipDetails(membershipId: string, companyId: string, actorUserId: string): Promise<MembershipDetails> {
    const membership = await this.repo.findMembershipById(membershipId);
    if (!membership || membership.company_id !== companyId) throw new Error('Membership not found');
    const [user, rows] = await Promise.all([this.repo.findUserSummary(membership.user_id), this.repo.listMembershipsOfUser(membership.user_id)]);
    if (!user) throw new Error('Membership not found');
    const companies: UserCompanyAccess[] = [];
    for (const row of rows) {
      const current = row.company_id === companyId;
      if (!current && !(await this.repo.getActiveCapabilities(actorUserId, row.company_id)).includes('access.view')) continue;
      const effective = (await this.repo.getActiveCapabilities(membership.user_id, row.company_id)).sort();
      const live = row.is_active && row.company_is_active;
      const source = user.is_system_admin && row.company_is_active ? 'system_admin_global'
        : live && row.role_is_full_access ? 'full_access_wildcard' : live && row.role_id ? 'role' : 'none';
      companies.push({
        membership_id: row.membership_id, company_id: row.company_id, company_name: row.company_name, company_name_ar: row.company_name_ar,
        company_is_active: row.company_is_active, is_active: row.is_active, is_current_company: current,
        role: row.role_id && row.role_name !== null ? { id: row.role_id, name: row.role_name, is_full_access: row.role_is_full_access } : null,
        role_capabilities: row.role_id && !row.role_is_full_access ? [...(await this.repo.getRoleCapabilities(row.role_id))].sort() : [],
        effective_capabilities: effective, effective_source: source,
      });
    }
    return { user, companies };
  }

  async assignRoleForCompany(membershipId: string, roleId: string, companyId: string, actorUserId: string): Promise<Membership> {
    return this.transaction(async (client) => {
      const before = await this.repo.findMembershipById(membershipId, client);
      const role = await this.repo.findRoleById(roleId, client);
      if (!before || before.company_id !== companyId) throw new Error('Membership not found');
      if (!role || role.company_id !== companyId) throw new Error('Role not found');
      await this.assertCanManageTarget(before, actorUserId, client);
      await this.assertCanAssign(before, role, actorUserId, client);
      await this.assertNotLastFullAccess(before, role, client);
      const after = await this.repo.assignRoleToMembership(membershipId, roleId, client);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.membership.role.assign', entity_type: 'membership', entity_id: membershipId, before_data: this.membershipSnapshot(before), after_data: this.membershipSnapshot(after) }, client);
      return after;
    });
  }

  async changeRoleCapability(roleId: string, capabilityId: string, companyId: string, actorUserId: string, add: boolean): Promise<void> {
    return this.transaction(async (client) => {
      const role = await this.repo.findRoleById(roleId, client);
      if (!role || role.company_id !== companyId) throw new Error('Role not found');
      if (role.is_full_access) await this.assertCanChangeFullAccessCapabilities([capabilityId], companyId, actorUserId, client);
      else {
        const actorCapabilities = await this.repo.getActiveCapabilities(actorUserId, companyId, client);
        if (!actorCapabilities.includes(capabilityId)) throw new AccessPolicyError(`Ceiling violation: granter lacks capability '${capabilityId}'`, 'ACCESS_ROLE_CEILING');
        await this.assertCanEditRole(roleId, companyId, actorUserId, client);
      }
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
      if (role.is_full_access) await this.assertCanChangeFullAccessCapabilities([...grants, ...revokes], companyId, actorUserId, client);
      else {
        const actorCapabilities = await this.repo.getActiveCapabilities(actorUserId, companyId, client);
        for (const id of [...grants, ...revokes]) if (!actorCapabilities.includes(id)) throw new AccessPolicyError(`Ceiling violation: granter lacks capability '${id}'`, 'ACCESS_ROLE_CEILING');
        await this.assertCanEditRole(roleId, companyId, actorUserId, client);
      }
      const before = await this.repo.getRoleCapabilities(roleId, client);
      for (const id of grants) await this.repo.addCapabilityToRole(roleId, id, client);
      for (const id of revokes) await this.repo.removeCapabilityFromRole(roleId, id, client);
      const after = [...new Set([...before, ...grants])].filter((id) => !revokes.includes(id));
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'access.role.capability.bulk_change', entity_type: 'role', entity_id: roleId, before_data: { capabilities: before }, after_data: { capabilities: after } }, client);
    });
  }

  /**
   * A Full Access role is a wildcard over every registered capability (migration 075), so its capability list has
   * nothing to edit. Any change request is rejected; the wildcard cannot be narrowed or widened from here.
   */
  private async assertCanChangeFullAccessCapabilities(_ids: string[], _companyId: string, _actorUserId: string, _client: PoolClient): Promise<void> {
    throw new AccessPolicyError('Full Access role capabilities cannot be changed', 'ACCESS_FULL_ACCESS_IMMUTABLE');
  }

  /**
   * Authority over Full Access in one company: the explicit, delegable capability access.full_access.grant, resolved
   * in the DB-derived target company. Full Access holders have it through the wildcard and an active System Admin
   * through global authority; a Company Manager has it only when it was granted on purpose.
   */
  private async holdsFullAccessAuthority(actorUserId: string, companyId: string, client?: PoolClient): Promise<boolean> {
    return (await this.repo.getActiveCapabilities(actorUserId, companyId, client)).includes(FULL_ACCESS_GRANT);
  }

  /**
   * Assigning a Full Access role. Requires access.full_access.grant in the target company. A delegated holder who is not
   * already Full Access (or System Admin) may not give Full Access to themselves: delegation is for granting to others.
   */
  private async assertCanGrantFullAccess(membership: Membership, actorUserId: string, client?: PoolClient): Promise<void> {
    if (!(await this.holdsFullAccessAuthority(actorUserId, membership.company_id, client))) {
      throw new AccessPolicyError('Full Access violation: granter needs access.full_access.grant in the target company', 'ACCESS_ROLE_CEILING');
    }
    if (membership.user_id === actorUserId
      && !(await this.repo.hasActiveFullAccessRole(actorUserId, membership.company_id, client))
      && !(await this.repo.isActiveSystemAdmin(actorUserId, client))) {
      throw new AccessPolicyError('Full Access violation: a delegated granter cannot grant Full Access to themselves', 'ACCESS_ROLE_CEILING');
    }
  }

  private membershipSnapshot(value: Membership): Record<string, unknown> {
    return { user_id: value.user_id, company_id: value.company_id, role_id: value.role_id, is_active: value.is_active };
  }

  private roleSnapshot(value: Role): Record<string, unknown> {
    return { company_id: value.company_id, name: value.name, is_full_access: value.is_full_access };
  }

  /**
   * Pure target rule shared by enforcement and the UI flags. Self is never blocked here (self-disable and self-escalation
   * have their own rules). Otherwise the target is out of reach for an actor without the matching higher authority when it
   * is a System Admin (System Admin only), a Full Access member (access.full_access.grant), or a member whose role holds
   * administrative capabilities, i.e. another manager of equal or higher authority (access.full_access.grant).
   * Functional capabilities of the target (accounting, banking, invoicing, ...) never block a delegated manager.
   */
  private targetBlocked(target: Pick<Membership, 'user_id'>, actorUserId: string, hasGrant: boolean, actorIsSystemAdmin: boolean,
    targetIsSystemAdmin: boolean, role: Pick<Role, 'is_full_access'> | undefined, roleCaps: readonly string[]): boolean {
    if (target.user_id === actorUserId) return role?.is_full_access === true && !hasGrant;
    if (targetIsSystemAdmin) return !actorIsSystemAdmin;
    if (!role) return false;
    if (role.is_full_access) return !hasGrant;
    return !hasGrant && roleCaps.some(isAdministrativeCapability);
  }

  /**
   * Authority over the target's EXISTING privileges: see targetBlocked. The role is resolved inside the target's own
   * company, never from a caller-supplied value.
   */
  private async assertCanManageTarget(target: Membership, actorUserId: string, client: PoolClient): Promise<void> {
    const targetRole = target.role_id ? await this.repo.findRoleById(target.role_id, client) : null;
    const role = targetRole && targetRole.company_id === target.company_id ? targetRole : undefined;
    const [hasGrant, actorIsSystemAdmin, targetIsSystemAdmin, roleCaps] = await Promise.all([
      this.holdsFullAccessAuthority(actorUserId, target.company_id, client),
      this.repo.isActiveSystemAdmin(actorUserId, client),
      target.user_id === actorUserId ? false : this.repo.isActiveSystemAdmin(target.user_id, client),
      role && !role.is_full_access ? this.repo.getRoleCapabilities(role.id, client) : Promise.resolve([] as string[]),
    ]);
    if (this.targetBlocked(target, actorUserId, hasGrant, actorIsSystemAdmin, targetIsSystemAdmin, role, roleCaps)) {
      throw new AccessPolicyError('Target privilege violation: this member is outside your administrative authority', 'ACCESS_TARGET_PRIVILEGE');
    }
  }

  /** Editing a role that holds administrative capabilities manages its holders (other managers): needs access.full_access.grant. */
  private async assertCanEditRole(roleId: string, companyId: string, actorUserId: string, client: PoolClient): Promise<void> {
    const caps = await this.repo.getRoleCapabilities(roleId, client);
    if (caps.some(isAdministrativeCapability) && !(await this.holdsFullAccessAuthority(actorUserId, companyId, client))) {
      throw new AccessPolicyError('Target privilege violation: roles with administrative capabilities need access.full_access.grant to edit', 'ACCESS_TARGET_PRIVILEGE');
    }
  }

  /** Blocks disabling or moving off Full Access when the target is the last active Full Access member (row-locked). */
  private async assertNotLastFullAccess(target: Membership, newRole: Role | null, client: PoolClient): Promise<void> {
    if (!target.is_active || !target.role_id) return;
    if (newRole?.is_full_access) return;
    const currentRole = await this.repo.findRoleById(target.role_id, client);
    if (!currentRole?.is_full_access) return;
    const activeFullAccess = await this.repo.lockActiveFullAccessMembershipIds(target.company_id, client);
    if (!activeFullAccess.some((id) => id !== target.id)) {
      throw new AccessPolicyError('The last active Full Access member cannot be disabled or demoted', 'ACCESS_LAST_FULL_ACCESS');
    }
  }

  private async assertCanAssign(membership: Membership, role: Role, actorUserId: string, client?: PoolClient): Promise<void> {
    if (role.company_id !== membership.company_id) throw new Error('Cross-company violation');
    if (role.is_full_access) { await this.assertCanGrantFullAccess(membership, actorUserId, client); return; }
    const [granterCaps, roleCaps] = await Promise.all([
      this.repo.getActiveCapabilities(actorUserId, membership.company_id, client),
      this.repo.getRoleCapabilities(role.id, client),
    ]);
    // Ceiling over administrative capabilities for others; over EVERY capability when assigning to oneself, so a manager
    // can staff Accountant/Operations roles for employees but can never give themselves accounting capabilities.
    const selfAssign = membership.user_id === actorUserId;
    for (const capability of roleCaps) {
      if ((selfAssign || isAdministrativeCapability(capability)) && !granterCaps.includes(capability)) throw new AccessPolicyError(`Ceiling violation: granter lacks capability '${capability}'`, 'ACCESS_ROLE_CEILING');
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
    // Needs access.full_access.grant in the DB-derived target company
    // (Full Access, System Admin, or explicit delegation). The wildcard role
    // has no ceiling list to compare, so the check ends here for it.
    if (role.is_full_access) {
      await this.assertCanGrantFullAccess(membership, granterUserId);
      logger.info({ membershipId, roleId, granterUserId }, 'Role assigned');
      return this.repo.assignRoleToMembership(membershipId, roleId);
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
        throw new AccessPolicyError(
          `Ceiling violation: granter lacks capability '${cap}' — ` +
          `cannot grant a role that includes it`,
          'ACCESS_ROLE_CEILING',
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
