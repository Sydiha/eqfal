/**
 * Tests for Memberships + Roles/Capabilities foundation.
 *
 * Covers (per spec):
 *  1. Basic membership creation
 *  2. Uniqueness (user + company)
 *  3. Cross-company membership isolation
 *  4. Disabled membership blocks authorization
 *  5. Cross-company role assignment rejected
 *  6. Capability ceiling — granter cannot grant what they don't have
 *  7. Self-escalation — covered by ceiling (granter = target)
 *  8. Active membership with role returns correct capabilities
 *  9. isAuthorized true/false
 *
 * All mocks are pure in-memory — no real DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { MembershipService } from '../src/modules/memberships/membership.service';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';
import type { Membership, Role } from '../src/modules/memberships/membership.types';

// Silence logger
vi.mock('../src/shared/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── fixtures ─────────────────────────────────────────────────────────────────

const COMPANY_A = '00000000-0000-0000-0000-aaaaaaaaaaaa';
const COMPANY_B = '00000000-0000-0000-0000-bbbbbbbbbbbb';
const USER_1    = '00000000-0000-0000-0000-111111111111';
const USER_2    = '00000000-0000-0000-0000-222222222222';
const ROLE_A    = '00000000-0000-0000-0000-rrrrrrrrrr0a';
const ROLE_B    = '00000000-0000-0000-0000-rrrrrrrrrr0b';
const MEM_1     = '00000000-0000-0000-0000-mmmmmmmmmm01';

function makeMembership(overrides: Partial<Membership> = {}): Membership {
  return {
    id: MEM_1,
    user_id: USER_1,
    company_id: COMPANY_A,
    role_id: null,
    is_active: true,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...overrides,
  };
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: ROLE_A,
    company_id: COMPANY_A,
    name: 'accountant',
    is_full_access: false,
    created_at: new Date('2024-01-01'),
    ...overrides,
  };
}

/** Build a pool mock whose query() always resolves to a fixed result. */
function makePool(result: { rows: any[]; rowCount: number } = { rows: [], rowCount: 0 }): Pool {
  return {
    query: vi.fn().mockResolvedValue(result),
    connect: vi.fn(),
  } as unknown as Pool;
}

// ─── MembershipRepository — basic CRUD ────────────────────────────────────────

describe('MembershipRepository — create and read', () => {
  it('createMembership: inserts and returns membership row', async () => {
    const stored = makeMembership();
    const pool = makePool({ rows: [stored], rowCount: 1 });
    const repo = new MembershipRepository(pool);

    const result = await repo.createMembership({ user_id: USER_1, company_id: COMPANY_A });

    expect(result.id).toBe(MEM_1);
    expect(result.company_id).toBe(COMPANY_A);
    expect(result.is_active).toBe(true);
    expect(pool.query).toHaveBeenCalledOnce();
  });

  it('createMembership: throws on duplicate user+company (pg 23505)', async () => {
    const pool = makePool();
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' });
    (pool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(pgError);
    const repo = new MembershipRepository(pool);

    await expect(
      repo.createMembership({ user_id: USER_1, company_id: COMPANY_A }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('findMembershipByUserAndCompany: returns null when not found', async () => {
    const pool = makePool({ rows: [], rowCount: 0 });
    const repo = new MembershipRepository(pool);

    expect(await repo.findMembershipByUserAndCompany(USER_1, COMPANY_A)).toBeNull();
  });

  it('findMembershipByUserAndCompany: returns membership when found', async () => {
    const stored = makeMembership();
    const pool = makePool({ rows: [stored], rowCount: 1 });
    const repo = new MembershipRepository(pool);

    const result = await repo.findMembershipByUserAndCompany(USER_1, COMPANY_A);
    expect(result?.id).toBe(MEM_1);
  });
});

// ─── getActiveCapabilities — disabled membership ───────────────────────────────

describe('MembershipRepository — getActiveCapabilities', () => {
  it('returns capabilities when membership is active and has a role', async () => {
    const pool = makePool({
      rows: [{ capability_id: 'invoice.create' }, { capability_id: 'report.view' }],
      rowCount: 2,
    });
    const repo = new MembershipRepository(pool);

    const caps = await repo.getActiveCapabilities(USER_1, COMPANY_A);
    expect(caps).toEqual(['invoice.create', 'report.view']);
  });

  it('returns [] when DB returns no rows (disabled/no-role/no-caps)', async () => {
    const pool = makePool({ rows: [], rowCount: 0 });
    const repo = new MembershipRepository(pool);

    expect(await repo.getActiveCapabilities(USER_1, COMPANY_A)).toEqual([]);
  });

  it('query includes is_active = TRUE filter', async () => {
    const pool = makePool({ rows: [], rowCount: 0 });
    const repo = new MembershipRepository(pool);

    await repo.getActiveCapabilities(USER_1, COMPANY_A);

    const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(sql).toMatch(/is_active\s*=\s*TRUE/i);
  });
});

// ─── MembershipService — cross-company isolation ──────────────────────────────

describe('MembershipService — cross-company role assignment rejected', () => {
  let service: MembershipService;
  let repo: MembershipRepository;

  beforeEach(() => {
    const pool = makePool();
    service = new MembershipService(pool);
    repo = (service as any).repo as MembershipRepository;
  });

  it('rejects when role.company_id !== membership.company_id', async () => {
    // membership in company A, role in company B
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(makeMembership({ company_id: COMPANY_A }));
    vi.spyOn(repo, 'findRoleById').mockResolvedValue(makeRole({ company_id: COMPANY_B }));

    await expect(
      service.assignRole(MEM_1, ROLE_B, USER_2),
    ).rejects.toThrow(/cross-company/i);
  });

  it('does not reach DB write when cross-company check fails', async () => {
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(makeMembership({ company_id: COMPANY_A }));
    vi.spyOn(repo, 'findRoleById').mockResolvedValue(makeRole({ company_id: COMPANY_B }));
    const writeSpy = vi.spyOn(repo, 'assignRoleToMembership');

    await expect(service.assignRole(MEM_1, ROLE_B, USER_2)).rejects.toThrow();

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ─── MembershipService — capability ceiling ───────────────────────────────────

describe('MembershipService — capability ceiling', () => {
  let service: MembershipService;
  let repo: MembershipRepository;

  beforeEach(() => {
    const pool = makePool();
    service = new MembershipService(pool);
    repo = (service as any).repo as MembershipRepository;
  });

  it('rejects when granter lacks a capability that the role includes', async () => {
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(makeMembership());
    vi.spyOn(repo, 'findRoleById').mockResolvedValue(makeRole());
    // Granter has: ['report.view'] — role requires: ['invoice.create', 'report.view']
    vi.spyOn(repo, 'getActiveCapabilities').mockResolvedValue(['report.view']);
    vi.spyOn(repo, 'getRoleCapabilities').mockResolvedValue(['invoice.create', 'report.view']);

    await expect(
      service.assignRole(MEM_1, ROLE_A, USER_2),
    ).rejects.toThrow(/ceiling violation/i);
  });

  it('ceiling error message names the missing capability', async () => {
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(makeMembership());
    vi.spyOn(repo, 'findRoleById').mockResolvedValue(makeRole());
    vi.spyOn(repo, 'getActiveCapabilities').mockResolvedValue([]);
    vi.spyOn(repo, 'getRoleCapabilities').mockResolvedValue(['invoice.create']);

    await expect(
      service.assignRole(MEM_1, ROLE_A, USER_2),
    ).rejects.toThrow("invoice.create");
  });

  it('does not write when ceiling check fails', async () => {
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(makeMembership());
    vi.spyOn(repo, 'findRoleById').mockResolvedValue(makeRole());
    vi.spyOn(repo, 'getActiveCapabilities').mockResolvedValue([]);
    vi.spyOn(repo, 'getRoleCapabilities').mockResolvedValue(['invoice.create']);
    const writeSpy = vi.spyOn(repo, 'assignRoleToMembership');

    await expect(service.assignRole(MEM_1, ROLE_A, USER_2)).rejects.toThrow();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('ceiling check uses membership.company_id (not a caller-supplied company) — bypass blocked', async () => {
    // Granter is admin in COMPANY_B (has all caps there) but has NO caps in COMPANY_A.
    // Membership being assigned is in COMPANY_A.
    // Before the fix, a caller could pass granterCompanyId=COMPANY_B to bypass the ceiling.
    // After the fix, the service always uses membership.company_id = COMPANY_A.
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(makeMembership({ company_id: COMPANY_A }));
    vi.spyOn(repo, 'findRoleById').mockResolvedValue(makeRole({ company_id: COMPANY_A }));

    const capsSpy = vi.spyOn(repo, 'getActiveCapabilities').mockResolvedValue([]); // no caps in A
    vi.spyOn(repo, 'getRoleCapabilities').mockResolvedValue(['invoice.create']);
    const writeSpy = vi.spyOn(repo, 'assignRoleToMembership');

    // Granter only supplies their userId — the service determines the company itself.
    await expect(service.assignRole(MEM_1, ROLE_A, USER_2)).rejects.toThrow(/ceiling violation/i);

    // Verify the company used for the caps lookup is COMPANY_A (membership's company), not COMPANY_B.
    expect(capsSpy).toHaveBeenCalledWith(USER_2, COMPANY_A);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('succeeds when granter capabilities are a superset of role capabilities', async () => {
    const updated = makeMembership({ role_id: ROLE_A });
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(makeMembership());
    vi.spyOn(repo, 'findRoleById').mockResolvedValue(makeRole());
    vi.spyOn(repo, 'getActiveCapabilities').mockResolvedValue(['invoice.create', 'report.view']);
    vi.spyOn(repo, 'getRoleCapabilities').mockResolvedValue(['invoice.create', 'report.view']);
    vi.spyOn(repo, 'assignRoleToMembership').mockResolvedValue(updated);

    const result = await service.assignRole(MEM_1, ROLE_A, USER_2);
    expect(result.role_id).toBe(ROLE_A);
  });
});

describe('MembershipService — Full Access assignment authority', () => {
  let service: MembershipService;
  let repo: MembershipRepository;

  beforeEach(() => {
    service = new MembershipService(makePool());
    repo = (service as any).repo as MembershipRepository;
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(makeMembership());
    vi.spyOn(repo, 'findRoleById').mockResolvedValue(makeRole({ is_full_access: true }));
  });

  it('rejects a non-Full-Access granter assigning a Full Access role', async () => {
    vi.spyOn(repo, 'hasActiveFullAccessRole').mockResolvedValue(false);
    const write = vi.spyOn(repo, 'assignRoleToMembership');

    await expect(service.assignRole(MEM_1, ROLE_A, USER_2)).rejects.toThrow(/Full Access violation/);
    expect(repo.hasActiveFullAccessRole).toHaveBeenCalledWith(USER_2, COMPANY_A);
    expect(write).not.toHaveBeenCalled();
  });

  it('allows a Full Access granter to assign Full Access in the same company', async () => {
    const updated = makeMembership({ role_id: ROLE_A });
    vi.spyOn(repo, 'hasActiveFullAccessRole').mockResolvedValue(true);
    vi.spyOn(repo, 'getActiveCapabilities').mockResolvedValue(['future.capability']);
    vi.spyOn(repo, 'getRoleCapabilities').mockResolvedValue([]);
    vi.spyOn(repo, 'assignRoleToMembership').mockResolvedValue(updated);

    await expect(service.assignRole(MEM_1, ROLE_A, USER_2)).resolves.toEqual(updated);
    expect(repo.hasActiveFullAccessRole).toHaveBeenCalledWith(USER_2, COMPANY_A);
  });

  it('rejects non-Full-Access self-escalation into Full Access', async () => {
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(makeMembership({ user_id: USER_1 }));
    vi.spyOn(repo, 'hasActiveFullAccessRole').mockResolvedValue(false);

    await expect(service.assignRole(MEM_1, ROLE_A, USER_1)).rejects.toThrow(/Full Access violation/);
  });
});

// ─── MembershipService — self-escalation (ceiling covers it) ─────────────────

describe('MembershipService — self-escalation prevention', () => {
  let service: MembershipService;
  let repo: MembershipRepository;

  beforeEach(() => {
    const pool = makePool();
    service = new MembershipService(pool);
    repo = (service as any).repo as MembershipRepository;
  });

  it('user cannot grant themselves a role with capabilities they lack', async () => {
    // Granter = target (USER_1 assigning to their own membership)
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(makeMembership({ user_id: USER_1 }));
    vi.spyOn(repo, 'findRoleById').mockResolvedValue(makeRole());
    // USER_1 currently has no capabilities
    vi.spyOn(repo, 'getActiveCapabilities').mockResolvedValue([]);
    // Role they want includes 'invoice.create'
    vi.spyOn(repo, 'getRoleCapabilities').mockResolvedValue(['invoice.create']);

    await expect(
      service.assignRole(MEM_1, ROLE_A, USER_1),
    ).rejects.toThrow(/ceiling violation/i);
  });
});

// ─── MembershipService — disabled membership blocks auth ──────────────────────

describe('MembershipService — disabled membership', () => {
  it('isAuthorized returns false when membership is disabled (no rows from DB)', async () => {
    // DB returns no rows because query filters is_active = TRUE
    const pool = makePool({ rows: [], rowCount: 0 });
    const service = new MembershipService(pool);

    expect(await service.isAuthorized(USER_1, COMPANY_A, 'invoice.create')).toBe(false);
  });

  it('getCapabilities returns [] when membership is disabled', async () => {
    const pool = makePool({ rows: [], rowCount: 0 });
    const service = new MembershipService(pool);

    expect(await service.getCapabilities(USER_1, COMPANY_A)).toEqual([]);
  });
});

// ─── MembershipService — isAuthorized ─────────────────────────────────────────

describe('MembershipService — isAuthorized', () => {
  it('returns true when capability is present', async () => {
    const pool = makePool({ rows: [{ capability_id: 'invoice.create' }], rowCount: 1 });
    const service = new MembershipService(pool);

    expect(await service.isAuthorized(USER_1, COMPANY_A, 'invoice.create')).toBe(true);
  });

  it('returns false when capability is absent', async () => {
    const pool = makePool({ rows: [{ capability_id: 'report.view' }], rowCount: 1 });
    const service = new MembershipService(pool);

    expect(await service.isAuthorized(USER_1, COMPANY_A, 'invoice.create')).toBe(false);
  });

  it('returns false when user has no membership in company', async () => {
    const pool = makePool({ rows: [], rowCount: 0 });
    const service = new MembershipService(pool);

    expect(await service.isAuthorized(USER_1, COMPANY_B, 'invoice.create')).toBe(false);
  });
});
