import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { MembershipService } from '../src/modules/memberships/membership.service';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';
import type { Membership, Role } from '../src/modules/memberships/membership.types';

const C = 'company-a';
const now = new Date();
const role = (id: string, full = false): Role => ({ id, company_id: C, name: id, is_full_access: full, created_at: now });
const member = (id: string, userId: string, roleId: string | null, active = true): Membership => ({ id, user_id: userId, company_id: C, role_id: roleId, is_active: active, created_at: now, updated_at: now });

/** In-memory model behind the repository so the real service rules run end to end. */
function setup() {
  const roles: Record<string, Role> = { full: role('full', true), admin: role('admin'), staff: role('staff'), empty: role('empty') };
  const roleCaps: Record<string, string[]> = {
    full: [],
    admin: ['access.membership.status.edit', 'access.membership.role.assign', 'access.role.capability.revoke', 'access.role.capability.grant', 'sales.view'],
    staff: ['sales.view'],
    empty: [],
  };
  const members: Record<string, Membership> = {
    owner: member('m-owner', 'owner', 'full'),
    owner2: member('m-owner2', 'owner2', 'full'),
    admin: member('m-admin', 'admin', 'admin'),
    admin2: member('m-admin2', 'admin2', 'admin'),
    staff: member('m-staff', 'staff', 'staff'),
  };
  const byId = (id: string) => Object.values(members).find((m) => m.id === id) ?? null;
  const capsOf = (userId: string) => {
    const m = members[userId];
    if (!m || !m.is_active || !m.role_id) return [];
    return roles[m.role_id]!.is_full_access ? ['*all*', ...Object.values(roleCaps).flat()] : roleCaps[m.role_id]!;
  };
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() } as unknown as Pool;
  const service = new MembershipService(pool);
  const repo = (service as unknown as { repo: MembershipRepository }).repo;
  const audit = (service as unknown as { audit: { logEvent: ReturnType<typeof vi.fn> } }).audit;
  vi.spyOn(audit, 'logEvent').mockResolvedValue({} as never);
  vi.spyOn(repo, 'findMembershipById').mockImplementation(async (id) => byId(id));
  vi.spyOn(repo, 'findRoleById').mockImplementation(async (id) => roles[id] ?? null);
  vi.spyOn(repo, 'getActiveCapabilities').mockImplementation(async (userId) => capsOf(userId));
  vi.spyOn(repo, 'getRoleCapabilities').mockImplementation(async (id) => roleCaps[id] ?? []);
  vi.spyOn(repo, 'listCapabilities').mockResolvedValue(['sales.view', 'access.membership.status.edit', 'access.membership.role.assign', 'access.role.capability.revoke', 'access.role.capability.grant']);
  vi.spyOn(repo, 'hasActiveFullAccessRole').mockImplementation(async (userId) => {
    const m = members[userId];
    return !!m && m.is_active && !!m.role_id && roles[m.role_id]!.is_full_access;
  });
  vi.spyOn(repo, 'lockActiveFullAccessMembershipIds').mockImplementation(async () =>
    Object.values(members).filter((m) => m.is_active && m.role_id && roles[m.role_id]!.is_full_access).map((m) => m.id));
  const setActive = vi.spyOn(repo, 'setMembershipActive').mockImplementation(async (id, _c, active) => { const m = byId(id)!; m.is_active = active; return m; });
  const assign = vi.spyOn(repo, 'assignRoleToMembership').mockImplementation(async (id, roleId) => { const m = byId(id)!; m.role_id = roleId; return m; });
  const removeCap = vi.spyOn(repo, 'removeCapabilityFromRole').mockResolvedValue();
  vi.spyOn(repo, 'addCapabilityToRole').mockResolvedValue();
  return { service, members, setActive, assign, removeCap };
}

describe('H3 membership privilege escalation and owner lockout', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { vi.restoreAllMocks(); s = setup(); });

  it('REGRESSION: limited admin cannot disable a Full Access owner', async () => {
    await expect(s.service.setMembershipActive('m-owner', C, false, 'admin')).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
    expect(s.setActive).not.toHaveBeenCalled();
  });

  it('REGRESSION: limited admin cannot demote a Full Access owner (even to an empty role)', async () => {
    await expect(s.service.assignRoleForCompany('m-owner', 'empty', C, 'admin')).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
    expect(s.assign).not.toHaveBeenCalled();
  });

  it('limited admin cannot re-enable or change a disabled Full Access member either', async () => {
    s.members.owner2!.is_active = false;
    await expect(s.service.setMembershipActive('m-owner2', C, true, 'admin')).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
  });

  it('cannot act on a target holding capabilities the actor lacks (peer/superior non-Full-Access role)', async () => {
    s.members.staff!.role_id = 'admin';
    // staff-level actor
    s.members.admin2!.role_id = 'staff';
    s.members.admin2!.user_id = 'admin2';
    await expect(s.service.setMembershipActive('m-staff', C, false, 'admin2')).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
    await expect(s.service.assignRoleForCompany('m-staff', 'empty', C, 'admin2')).rejects.toMatchObject({ code: 'ACCESS_TARGET_PRIVILEGE' });
  });

  it('still allows an admin to manage a member whose privileges are within the admin\'s own', async () => {
    await expect(s.service.setMembershipActive('m-staff', C, false, 'admin')).resolves.toMatchObject({ is_active: false });
    await expect(s.service.assignRoleForCompany('m-staff', 'empty', C, 'admin')).resolves.toMatchObject({ role_id: 'empty' });
  });

  it('Full Access owner can still manage others, including another Full Access member', async () => {
    await expect(s.service.setMembershipActive('m-admin', C, false, 'owner')).resolves.toBeDefined();
    await expect(s.service.setMembershipActive('m-owner2', C, false, 'owner')).resolves.toBeDefined();
  });

  it('REGRESSION: the last active Full Access member cannot be disabled (even by themselves or another owner)', async () => {
    await s.service.setMembershipActive('m-owner2', C, false, 'owner');
    await expect(s.service.setMembershipActive('m-owner', C, false, 'owner')).rejects.toMatchObject({ code: 'ACCESS_LAST_FULL_ACCESS' });
  });

  it('REGRESSION: the last active Full Access member cannot be demoted', async () => {
    await s.service.setMembershipActive('m-owner2', C, false, 'owner');
    await expect(s.service.assignRoleForCompany('m-owner', 'admin', C, 'owner')).rejects.toMatchObject({ code: 'ACCESS_LAST_FULL_ACCESS' });
    expect(s.members.owner!.role_id).toBe('full');
  });

  it('allows demoting or disabling a Full Access member while another active one remains', async () => {
    await expect(s.service.assignRoleForCompany('m-owner2', 'admin', C, 'owner')).resolves.toMatchObject({ role_id: 'admin' });
  });

  it('REGRESSION (revocation path): cannot revoke a capability the actor does not hold', async () => {
    s.members.admin!.role_id = 'staff';
    await expect(s.service.changeRoleCapability('admin', 'access.membership.role.assign', C, 'admin', false)).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
    await expect(s.service.changeRoleCapabilities('admin', [], ['access.membership.role.assign'], C, 'admin')).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
    expect(s.removeCap).not.toHaveBeenCalled();
  });

  it('allows revoking a capability the actor holds', async () => {
    await expect(s.service.changeRoleCapability('staff', 'sales.view', C, 'owner', false)).resolves.toBeUndefined();
    expect(s.removeCap).toHaveBeenCalled();
  });
});
