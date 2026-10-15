import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { MembershipService } from '../src/modules/memberships/membership.service';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';
import type { Membership, Role, RoleListItem } from '../src/modules/memberships/membership.types';

const A = 'company-a';
const B = 'company-b';
const now = new Date();
const role = (id: string, company = A, full = false): Role => ({ id, company_id: company, name: id, is_full_access: full, created_at: now });
const member = (id: string, userId: string, roleId: string | null, company = A): Membership => ({ id, user_id: userId, company_id: company, role_id: roleId, is_active: true, created_at: now, updated_at: now });

const MANAGER = ['access.view', 'access.membership.create', 'access.membership.role.assign', 'access.membership.status.edit', 'access.role.capability.grant', 'access.role.capability.revoke', 'access.role.create', 'invoice.view'];

/** Phase B2 policy, run against the real service rules with an in-memory model behind the repository. */
function setup() {
  const roles: Record<string, Role> = {
    full: role('full', A, true), manager: role('manager'), accountant: role('accountant'), ops: role('ops'),
    grantMgr: role('grantMgr'), viewer: role('viewer'), foreign: role('foreign', B),
  };
  const roleCaps: Record<string, string[]> = {
    full: [], manager: MANAGER, grantMgr: [...MANAGER, 'access.full_access.grant'],
    accountant: ['accounting.journal.create', 'accounting.journal.post', 'bank.reconcile', 'invoice.view'],
    ops: ['invoice.view', 'invoice.approve'], viewer: ['invoice.view'], foreign: ['invoice.view'],
  };
  const members: Record<string, Membership> = {
    owner: member('m-owner', 'owner', 'full'), cm: member('m-cm', 'cm', 'manager'), cm2: member('m-cm2', 'cm2', 'manager'),
    dm: member('m-dm', 'dm', 'grantMgr'), acct: member('m-acct', 'acct', 'accountant'), ops: member('m-ops', 'ops', 'ops'),
    plain: member('m-plain', 'plain', null), sa: member('m-sa', 'sa', null), other: member('m-other', 'other', 'viewer', B),
  };
  const systemAdmins = new Set(['sa']);
  const byId = (id: string) => Object.values(members).find((m) => m.id === id) ?? null;
  const capsOf = (userId: string, company: string) => {
    if (systemAdmins.has(userId)) return ['access.full_access.grant', ...MANAGER, 'accounting.journal.create'];
    const m = members[userId];
    if (!m || m.company_id !== company || !m.is_active || !m.role_id) return [];
    return roles[m.role_id]!.is_full_access ? ['access.full_access.grant', ...MANAGER, 'accounting.journal.create', 'invoice.approve'] : roleCaps[m.role_id]!;
  };
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() } as unknown as Pool;
  const service = new MembershipService(pool);
  const repo = (service as unknown as { repo: MembershipRepository }).repo;
  const audit = vi.spyOn((service as unknown as { audit: { logEvent: () => unknown } }).audit, 'logEvent').mockResolvedValue({} as never);
  vi.spyOn(repo, 'findMembershipById').mockImplementation(async (id) => byId(id));
  vi.spyOn(repo, 'findRoleById').mockImplementation(async (id) => roles[id] ?? null);
  vi.spyOn(repo, 'getActiveCapabilities').mockImplementation(async (userId, company) => capsOf(userId, company));
  vi.spyOn(repo, 'getRoleCapabilities').mockImplementation(async (id) => roleCaps[id] ?? []);
  vi.spyOn(repo, 'listCapabilities').mockResolvedValue(['invoice.view', 'invoice.approve', ...MANAGER]);
  vi.spyOn(repo, 'hasActiveFullAccessRole').mockImplementation(async (userId) => !!members[userId]?.role_id && roles[members[userId]!.role_id!]!.is_full_access);
  vi.spyOn(repo, 'isActiveSystemAdmin').mockImplementation(async (userId) => systemAdmins.has(userId));
  vi.spyOn(repo, 'isAttachableUser').mockImplementation(async (userId) => userId !== 'sa' && userId !== 'disabled');
  vi.spyOn(repo, 'listActiveSystemAdminIds').mockImplementation(async (ids) => new Set(ids.filter((id) => systemAdmins.has(id))));
  vi.spyOn(repo, 'lockActiveFullAccessMembershipIds').mockResolvedValue(['m-owner', 'm-other-full']);
  vi.spyOn(repo, 'listMemberships').mockImplementation(async () => Object.values(members).filter((m) => m.company_id === A) as never);
  vi.spyOn(repo, 'listRoles').mockImplementation(async () => Object.values(roles).filter((r) => r.company_id === A).map((r) => ({ ...r, capabilities: roleCaps[r.id] ?? [] })) as RoleListItem[]);
  const setActive = vi.spyOn(repo, 'setMembershipActive').mockImplementation(async (id, _c, active) => { const m = byId(id)!; m.is_active = active; return m; });
  const assign = vi.spyOn(repo, 'assignRoleToMembership').mockImplementation(async (id, roleId) => { const m = byId(id)!; m.role_id = roleId; return m; });
  const addCap = vi.spyOn(repo, 'addCapabilityToRole').mockResolvedValue();
  vi.spyOn(repo, 'removeCapabilityFromRole').mockResolvedValue();
  vi.spyOn(repo, 'createMembership').mockImplementation(async (input) => member('m-new', input.user_id, null, input.company_id));
  return { service, members, setActive, assign, addCap, audit };
}

describe('Phase B2 Company Manager delegation', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { vi.restoreAllMocks(); s = setup(); });

  it('policy 1-2: a manager assigns Accountant and Operations roles to employees without holding their capabilities', async () => {
    await expect(s.service.assignRoleForCompany('m-plain', 'accountant', A, 'cm')).resolves.toMatchObject({ role_id: 'accountant' });
    await expect(s.service.assignRoleForCompany('m-plain', 'ops', A, 'cm')).resolves.toMatchObject({ role_id: 'ops' });
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'access.membership.role.assign', actor_user_id: 'cm', company_id: A }), expect.anything());
  });

  it('policy 2: a manager manages (changes role of, disables) existing Accountant and Operations employees', async () => {
    await expect(s.service.assignRoleForCompany('m-acct', 'viewer', A, 'cm')).resolves.toMatchObject({ role_id: 'viewer' });
    await expect(s.service.setMembershipActive('m-ops', A, false, 'cm')).resolves.toMatchObject({ is_active: false });
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'access.membership.disable' }), expect.anything());
  });

  it('a manager can still not give THEMSELVES accounting capabilities', async () => {
    await expect(s.service.assignRoleForCompany('m-cm', 'accountant', A, 'cm')).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
    expect(s.assign).not.toHaveBeenCalled();
  });

  it('administrative capabilities stay under the ceiling: a manager cannot assign a role carrying access.full_access.grant', async () => {
    await expect(s.service.assignRoleForCompany('m-plain', 'grantMgr', A, 'cm')).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
  });

  it('policy 3: a manager cannot disable, demote or re-role a Full Access user', async () => {
    await expect(s.service.setMembershipActive('m-owner', A, false, 'cm')).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
    await expect(s.service.assignRoleForCompany('m-owner', 'viewer', A, 'cm')).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
  });

  it('policy 4: a manager cannot grant Full Access (to others or to themselves) without access.full_access.grant', async () => {
    await expect(s.service.assignRoleForCompany('m-plain', 'full', A, 'cm')).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
    await expect(s.service.assignRoleForCompany('m-cm', 'full', A, 'cm')).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
    await expect(s.service.assignRoleForCompany('m-plain', 'full', A, 'dm')).resolves.toMatchObject({ role_id: 'full' });
    await expect(s.service.assignRoleForCompany('m-dm', 'full', A, 'dm')).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
  });

  it('policy 5: a manager cannot manage an equal-authority manager; higher authority (grant holder) can', async () => {
    await expect(s.service.setMembershipActive('m-cm2', A, false, 'cm')).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
    await expect(s.service.assignRoleForCompany('m-cm2', 'viewer', A, 'cm')).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
    await expect(s.service.setMembershipActive('m-cm2', A, false, 'dm')).resolves.toMatchObject({ is_active: false });
  });

  it('policy 6: nobody can disable their own membership, including Full Access and delegated holders', async () => {
    for (const [id, user] of [['m-cm', 'cm'], ['m-owner', 'owner'], ['m-dm', 'dm']] as const) {
      await expect(s.service.setMembershipActive(id, A, false, user)).rejects.toMatchObject({ code: 'ACCESS_SELF_LOCKOUT' });
    }
    expect(s.setActive).not.toHaveBeenCalled();
  });

  it('System Admin is protected from company managers and cannot be attached by them', async () => {
    s.members.sa!.role_id = 'viewer';
    await expect(s.service.setMembershipActive('m-sa', A, false, 'dm')).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
    await expect(s.service.createMembershipForCompany('sa', A, 'cm')).rejects.toThrow('User not found');
    await expect(s.service.createMembershipForCompany('disabled', A, 'cm')).rejects.toThrow('User not found');
    await expect(s.service.createMembershipForCompany('plain', A, 'cm')).resolves.toMatchObject({ company_id: A });
  });

  it('policy 7: no cross-company reach (foreign membership, foreign role)', async () => {
    await expect(s.service.setMembershipActive('m-other', A, false, 'cm')).rejects.toThrow('Membership not found');
    await expect(s.service.assignRoleForCompany('m-other', 'viewer', A, 'cm')).rejects.toThrow('Membership not found');
    await expect(s.service.assignRoleForCompany('m-plain', 'foreign', A, 'cm')).rejects.toThrow('Role not found');
    expect(s.assign).not.toHaveBeenCalled();
  });

  it('a role holding administrative capabilities cannot be edited without access.full_access.grant', async () => {
    await expect(s.service.changeRoleCapability('manager', 'invoice.view', A, 'cm', false)).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
    await expect(s.service.changeRoleCapabilities('manager', [], ['invoice.view'], A, 'cm')).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
    await expect(s.service.changeRoleCapability('viewer', 'invoice.view', A, 'cm', false)).resolves.toBeUndefined();
    await expect(s.service.changeRoleCapability('viewer', 'invoice.approve', A, 'cm', true)).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
    expect(s.addCap).not.toHaveBeenCalled();
  });

  it('list flags mirror the server rule so the UI cannot offer what the server refuses', async () => {
    const members = await s.service.listMemberships(A, 'cm');
    const can = Object.fromEntries(members.map((m) => [m.user_id, m.can_manage]));
    expect(can).toMatchObject({ acct: true, ops: true, plain: true, owner: false, cm2: false, sa: false });
    const roles = await s.service.listRoles(A, 'cm');
    const flags = Object.fromEntries(roles.map((r) => [r.id, [r.assignable, r.editable]]));
    expect(flags).toMatchObject({ accountant: [true, true], ops: [true, true], full: [false, false], grantMgr: [false, false], manager: [true, false] });
  });
});
