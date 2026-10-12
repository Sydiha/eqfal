import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { MembershipRepository } from '../src/modules/memberships/membership.repository';

vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } as unknown as Pool }));

const now = new Date();
const fullRole = { id: 'r-full', company_id: 'co-a', name: 'Full Access', is_full_access: true, created_at: now };
const plainRole = { id: 'r-plain', company_id: 'co-a', name: 'Clerk', is_full_access: false, created_at: now };

async function setup(actorIsFullAccess: boolean, actorCaps: string[] = ['access.role.capability.grant']) {
  const { MembershipService } = await vi.importActual<typeof import('../src/modules/memberships/membership.service')>('../src/modules/memberships/membership.service');
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() } as unknown as PoolClient;
  const service = new MembershipService({ connect: vi.fn().mockResolvedValue(client), query: vi.fn() } as unknown as Pool);
  const repo = (service as unknown as { repo: MembershipRepository }).repo;
  const audit = (service as unknown as { audit: { logEvent: ReturnType<typeof vi.fn> } }).audit;
  vi.spyOn(repo, 'findRoleById').mockImplementation(async (id: string) => (id === 'r-full' ? fullRole : id === 'r-plain' ? plainRole : id === 'r-other' ? { ...fullRole, id: 'r-other', company_id: 'co-b' } : null));
  vi.spyOn(repo, 'listExplicitOnlyCapabilities').mockResolvedValue(['invoice.view', 'invoice.create']);
  vi.spyOn(repo, 'listCapabilities').mockResolvedValue(['invoice.view', 'invoice.create', 'document.view']);
  vi.spyOn(repo, 'hasActiveFullAccessRole').mockResolvedValue(actorIsFullAccess);
  vi.spyOn(repo, 'getActiveCapabilities').mockResolvedValue(actorCaps);
  vi.spyOn(repo, 'getRoleCapabilities').mockResolvedValue(['invoice.view']);
  const add = vi.spyOn(repo, 'addCapabilityToRole').mockResolvedValue();
  const remove = vi.spyOn(repo, 'removeCapabilityFromRole').mockResolvedValue();
  const log = vi.spyOn(audit, 'logEvent').mockResolvedValue({} as never);
  return { service, repo, add, remove, log };
}

describe('explicit-only capabilities on Full Access roles', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lets an active Full Access admin grant and revoke an explicit-only capability, with audit', async () => {
    const { service, add, remove, log } = await setup(true);
    await service.changeRoleCapability('r-full', 'invoice.view', 'co-a', 'actor', true);
    await service.changeRoleCapability('r-full', 'invoice.view', 'co-a', 'actor', false);
    expect(add).toHaveBeenCalledWith('r-full', 'invoice.view', expect.anything());
    expect(remove).toHaveBeenCalledWith('r-full', 'invoice.view', expect.anything());
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toMatchObject({ company_id: 'co-a', action: 'access.role.capability.add', entity_id: 'r-full' });
  });

  it('rejects a limited administrator even for explicit-only capabilities', async () => {
    const { service, add } = await setup(false, ['access.role.capability.grant', 'invoice.view']);
    await expect(service.changeRoleCapability('r-full', 'invoice.view', 'co-a', 'actor', true)).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
    expect(add).not.toHaveBeenCalled();
  });

  it('keeps implicit capabilities immutable on Full Access roles (single and bulk)', async () => {
    const { service, add, remove } = await setup(true);
    await expect(service.changeRoleCapability('r-full', 'document.view', 'co-a', 'actor', true)).rejects.toMatchObject({ code: 'ACCESS_FULL_ACCESS_IMMUTABLE' });
    await expect(service.changeRoleCapability('r-full', 'document.view', 'co-a', 'actor', false)).rejects.toMatchObject({ code: 'ACCESS_FULL_ACCESS_IMMUTABLE' });
    await expect(service.changeRoleCapabilities('r-full', ['invoice.view', 'document.view'], [], 'co-a', 'actor')).rejects.toMatchObject({ code: 'ACCESS_FULL_ACCESS_IMMUTABLE' });
    await expect(service.changeRoleCapabilities('r-full', [], ['document.view'], 'co-a', 'actor')).rejects.toMatchObject({ code: 'ACCESS_FULL_ACCESS_IMMUTABLE' });
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('bulk change touches only the requested explicit grants (no unintended clearing)', async () => {
    const { service, add, remove } = await setup(true);
    await service.changeRoleCapabilities('r-full', ['invoice.create'], [], 'co-a', 'actor');
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps the ceiling for ordinary roles, including explicit-only capabilities', async () => {
    const { service, add } = await setup(true, ['access.role.capability.grant']);
    await expect(service.changeRoleCapability('r-plain', 'invoice.view', 'co-a', 'actor', true)).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
    expect(add).not.toHaveBeenCalled();
  });

  it('does not reach a role of another company', async () => {
    const { service, add } = await setup(true);
    await expect(service.changeRoleCapability('r-other', 'invoice.view', 'co-a', 'actor', true)).rejects.toThrow('Role not found');
    expect(add).not.toHaveBeenCalled();
  });
});

describe('assigning a Full Access role that carries explicit grants', () => {
  beforeEach(() => vi.restoreAllMocks());
  const membership = { id: 'm', user_id: 'target', company_id: 'co-a', role_id: null, is_active: true, created_at: now, updated_at: now };

  it('lets a Full Access admin assign it although they do not hold the explicit capability', async () => {
    const { service, repo } = await setup(true, []);
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(membership);
    vi.spyOn(repo, 'assignRoleToMembership').mockResolvedValue({ ...membership, role_id: 'r-full' });
    await expect(service.assignRole('m', 'r-full', 'actor')).resolves.toMatchObject({ role_id: 'r-full' });
  });

  it('still blocks a limited administrator', async () => {
    const { service, repo } = await setup(false, []);
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(membership);
    await expect(service.assignRole('m', 'r-full', 'actor')).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
  });

  it('does not exempt ordinary roles from the ceiling', async () => {
    const { service, repo } = await setup(true, []);
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(membership);
    await expect(service.assignRole('m', 'r-plain', 'actor')).rejects.toMatchObject({ code: 'ACCESS_ROLE_CEILING' });
  });
});
