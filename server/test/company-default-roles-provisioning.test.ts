import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { CompanyManagementService } from '../src/modules/companies/company.service';
import {
  ACCOUNTANT_CAPABILITIES,
  FINANCE_MANAGER_CAPABILITIES,
  LEGACY_UNASSIGNED_CAPABILITIES,
  VIEWER_CAPABILITIES,
} from '../src/modules/memberships/default-role-capabilities';

const COMPANY_ID = 'test-company-id';
const ACTOR_USER_ID = 'test-user-id';

type Rows = Record<string, unknown>[];

interface FakePoolResult {
  pool: Pool;
  query: ReturnType<typeof vi.fn>;
  sqls: string[];
  capturedParams: unknown[][];
}

function fakePool(handler: (sql: string, params: unknown[]) => Rows): FakePoolResult {
  const sqls: string[] = [];
  const capturedParams: unknown[][] = [];
  let roleIds: Record<string, string> = {};
  let roleCapabilitiesInserted: Array<{ roleId: string; capabilityId: string }> = [];

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    sqls.push(sql);
    capturedParams.push(params);

    // Track role creation
    if (sql.includes('INSERT INTO roles') && sql.includes('RETURNING id')) {
      const [companyId, name] = params as [string, string];
      const roleId = `role-${Object.keys(roleIds).length + 1}`;
      roleIds[`${name}@${companyId}`] = roleId;
      return { rows: [{ id: roleId }] };
    }

    // Track role_capabilities insertion
    if (sql.includes('INSERT INTO role_capabilities')) {
      const [roleId, capabilityId] = params as [string, string];
      roleCapabilitiesInserted.push({ roleId, capabilityId });
      return { rows: [] };
    }

    // General handler
    return { rows: handler(sql, params) };
  });

  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { query, connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, query, sqls, capturedParams };
}

/** Runs real CompanyManagementService.create() and returns the role_capabilities rows it inserted, by role name. */
async function provisionCapabilitiesByRole(): Promise<Record<string, string[]>> {
  const roleNames: Record<string, string> = {};
  const byRole: Record<string, string[]> = {};
  let roleCounter = 0;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO companies')) {
      return { rows: [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }] };
    }
    if (sql.includes('INSERT INTO roles')) {
      const roleId = `role-${++roleCounter}`;
      roleNames[roleId] = params[1] as string;
      return { rows: [{ id: roleId }] };
    }
    if (sql.includes('INSERT INTO role_capabilities')) {
      const [roleId, capabilityId] = params as [string, string];
      (byRole[roleNames[roleId]] ??= []).push(capabilityId);
    }
    return { rows: [] };
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { query, connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  await new CompanyManagementService(pool).create({ slug: 'test-co', name: 'Test Co', name_ar: null }, ACTOR_USER_ID);
  return byRole;
}

describe('company default roles provisioning', () => {
  it('creates a new company with exactly 4 default roles', async () => {
    const { pool, sqls } = fakePool((sql) => {
      if (sql.includes('INSERT INTO companies')) {
        return [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }];
      }
      return [];
    });

    const service = new CompanyManagementService(pool);
    await service.create({ slug: 'test-co', name: 'Test Co', name_ar: null }, ACTOR_USER_ID);

    // Count role creation queries
    const roleInsertions = sqls.filter((s) => s.includes('INSERT INTO roles') && s.includes('RETURNING id'));
    expect(roleInsertions).toHaveLength(4);
  });

  it('creates roles with correct names and is_full_access flags', async () => {
    const createdRoles: Array<{ name: string; is_full_access: boolean }> = [];
    const { pool, capturedParams, sqls } = fakePool((sql) => {
      if (sql.includes('INSERT INTO companies')) {
        return [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }];
      }
      return [];
    });

    const query = pool.query as ReturnType<typeof vi.fn>;
    query.mockImplementationOnce(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO companies')) {
        return { rows: [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }] };
      }
      return { rows: [] };
    });

    let callIndex = 1;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO companies')) {
        return { rows: [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }] };
      }
      if (sql.includes('INSERT INTO roles')) {
        const [_, name, is_full_access] = params as [string, string, boolean];
        createdRoles.push({ name, is_full_access });
        return { rows: [{ id: `role-${callIndex++}` }] };
      }
      if (sql.includes('INSERT INTO role_capabilities')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO memberships')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO audit_log')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const service = new CompanyManagementService(pool);
    await service.create({ slug: 'test-co', name: 'Test Co', name_ar: null }, ACTOR_USER_ID);

    const roleNames = createdRoles.map((r) => r.name);
    expect(roleNames).toContain('Viewer');
    expect(roleNames).toContain('Accountant');
    expect(roleNames).toContain('Finance Manager');
    expect(roleNames).toContain('Full Access');

    // Check is_full_access flags
    const viewerRole = createdRoles.find((r) => r.name === 'Viewer');
    expect(viewerRole?.is_full_access).toBe(false);

    const accountantRole = createdRoles.find((r) => r.name === 'Accountant');
    expect(accountantRole?.is_full_access).toBe(false);

    const financeManagerRole = createdRoles.find((r) => r.name === 'Finance Manager');
    expect(financeManagerRole?.is_full_access).toBe(false);

    const fullAccessRole = createdRoles.find((r) => r.name === 'Full Access');
    expect(fullAccessRole?.is_full_access).toBe(true);
  });

  it('provisions Viewer role with exactly the canonical 20 capabilities', async () => {
    const byRole = await provisionCapabilitiesByRole();
    expect(VIEWER_CAPABILITIES).toHaveLength(20);
    expect(byRole['Viewer']).toHaveLength(VIEWER_CAPABILITIES.length);
    expect(new Set(byRole['Viewer'])).toEqual(new Set(VIEWER_CAPABILITIES));
  });

  it('provisions Accountant role with exactly the canonical 46 capabilities', async () => {
    const byRole = await provisionCapabilitiesByRole();
    expect(ACCOUNTANT_CAPABILITIES).toHaveLength(46);
    expect(byRole['Accountant']).toHaveLength(ACCOUNTANT_CAPABILITIES.length);
    expect(new Set(byRole['Accountant'])).toEqual(new Set(ACCOUNTANT_CAPABILITIES));
  });

  it('provisions Finance Manager role with exactly the canonical 96 capabilities', async () => {
    const byRole = await provisionCapabilitiesByRole();
    expect(FINANCE_MANAGER_CAPABILITIES).toHaveLength(96);
    expect(byRole['Finance Manager']).toHaveLength(FINANCE_MANAGER_CAPABILITIES.length);
    expect(new Set(byRole['Finance Manager'])).toEqual(new Set(FINANCE_MANAGER_CAPABILITIES));
  });

  it('provisions a strict Viewer < Accountant < Finance Manager hierarchy and no explicit Full Access rows', async () => {
    const byRole = await provisionCapabilitiesByRole();
    const viewer = new Set(byRole['Viewer']);
    const accountant = new Set(byRole['Accountant']);
    const fm = new Set(byRole['Finance Manager']);
    for (const c of viewer) expect(accountant.has(c)).toBe(true);
    for (const c of accountant) expect(fm.has(c)).toBe(true);
    expect(accountant.size).toBeGreaterThan(viewer.size);
    expect(fm.size).toBeGreaterThan(accountant.size);
    expect(byRole['Full Access'] ?? []).toEqual([]);
  });

  it('never provisions legacy/unassigned capabilities to any default role', async () => {
    const byRole = await provisionCapabilitiesByRole();
    expect(LEGACY_UNASSIGNED_CAPABILITIES).toHaveLength(13);
    for (const caps of Object.values(byRole)) {
      for (const legacy of LEGACY_UNASSIGNED_CAPABILITIES) expect(caps).not.toContain(legacy);
    }
  });

  it('assigns creator to Full Access role', async () => {
    let fullAccessRoleId = '';
    let assignedRoleId = '';

    const { pool } = fakePool((sql) => {
      if (sql.includes('INSERT INTO companies')) {
        return [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }];
      }
      return [];
    });

    const query = pool.query as ReturnType<typeof vi.fn>;
    let roleCounter = 0;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO companies')) {
        return { rows: [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }] };
      }
      if (sql.includes('INSERT INTO roles')) {
        const [_, name, is_full_access] = params as [string, string, boolean];
        const roleId = `role-${++roleCounter}`;
        if (name === 'Full Access') fullAccessRoleId = roleId;
        return { rows: [{ id: roleId }] };
      }
      if (sql.includes('INSERT INTO memberships')) {
        const [userId, companyId, roleId] = params as [string, string, string];
        if (userId === ACTOR_USER_ID && companyId === COMPANY_ID) {
          assignedRoleId = roleId;
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO role_capabilities')) return { rows: [] };
      if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
      return { rows: [] };
    });

    const service = new CompanyManagementService(pool);
    await service.create({ slug: 'test-co', name: 'Test Co', name_ar: null }, ACTOR_USER_ID);

    expect(assignedRoleId).toBe(fullAccessRoleId);
  });

  it('grants no access.* capability (including access.view) to Viewer, Accountant or Finance Manager', async () => {
    const byRole = await provisionCapabilitiesByRole();
    for (const roleName of ['Viewer', 'Accountant', 'Finance Manager']) {
      expect(byRole[roleName].length).toBeGreaterThan(0);
      expect(byRole[roleName].filter((c) => c.startsWith('access.'))).toEqual([]);
      expect(byRole[roleName]).not.toContain('access.view');
      // Limited roles only have company.view among company.* capabilities
      expect(byRole[roleName].filter((c) => c.startsWith('company.'))).toEqual(['company.view']);
    }
  });

  it('provisions roles scoped to the newly created company', async () => {
    const insertedRoles: Array<{ companyId: string; name: string }> = [];

    const { pool } = fakePool((sql) => {
      if (sql.includes('INSERT INTO companies')) {
        return [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }];
      }
      return [];
    });

    const query = pool.query as ReturnType<typeof vi.fn>;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO companies')) {
        return { rows: [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }] };
      }
      if (sql.includes('INSERT INTO roles')) {
        const [companyId, name, is_full_access] = params as [string, string, boolean];
        insertedRoles.push({ companyId, name });
        return { rows: [{ id: `role-${insertedRoles.length}` }] };
      }
      if (sql.includes('INSERT INTO role_capabilities')) return { rows: [] };
      if (sql.includes('INSERT INTO memberships')) return { rows: [] };
      if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
      return { rows: [] };
    });

    const service = new CompanyManagementService(pool);
    await service.create({ slug: 'test-co', name: 'Test Co', name_ar: null }, ACTOR_USER_ID);

    // All roles should be scoped to the newly created company
    for (const { companyId } of insertedRoles) {
      expect(companyId).toBe(COMPANY_ID);
    }
  });

  it('includes audit log entry for company creation', async () => {
    let auditLogged = false;

    const { pool } = fakePool((sql) => {
      if (sql.includes('INSERT INTO companies')) {
        return [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }];
      }
      return [];
    });

    const query = pool.query as ReturnType<typeof vi.fn>;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO companies')) {
        return { rows: [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }] };
      }
      if (sql.includes('INSERT INTO roles')) {
        return { rows: [{ id: `role-${Math.random()}` }] };
      }
      if (sql.includes('INSERT INTO audit_log')) {
        auditLogged = true;
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO')) return { rows: [] };
      return { rows: [] };
    });

    const service = new CompanyManagementService(pool);
    await service.create({ slug: 'test-co', name: 'Test Co', name_ar: null }, ACTOR_USER_ID);

    expect(auditLogged).toBe(true);
  });

  it('creates company atomically with all roles and membership in a transaction', async () => {
    const sqls: string[] = [];
    const pool = {
      query: vi.fn(),
      connect: vi.fn(),
    } as unknown as Pool;

    const query = pool.query as ReturnType<typeof vi.fn>;
    let roleCounter = 0;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      sqls.push(sql);
      if (sql.includes('INSERT INTO companies')) {
        return { rows: [{ id: COMPANY_ID, slug: 'test-co', name: 'Test Co', name_ar: null, is_active: true, created_at: new Date() }] };
      }
      if (sql.includes('INSERT INTO roles')) {
        return { rows: [{ id: `role-${++roleCounter}` }] };
      }
      if (sql.includes('INSERT INTO')) return { rows: [] };
      return { rows: [] };
    });

    const client = { query, release: vi.fn() } as unknown as PoolClient;
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);

    const service = new CompanyManagementService(pool);
    await service.create({ slug: 'test-co', name: 'Test Co', name_ar: null }, ACTOR_USER_ID);

    // Verify transaction boundaries
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    const beginIndex = sqls.indexOf('BEGIN');
    const commitIndex = sqls.indexOf('COMMIT');
    expect(beginIndex).toBeLessThan(commitIndex);

    // Verify operations are in correct order
    const companyInsertIndex = sqls.findIndex((s) => s.includes('INSERT INTO companies'));
    const roleInsertIndex = sqls.findIndex((s) => s.includes('INSERT INTO roles'));
    const membershipInsertIndex = sqls.findIndex((s) => s.includes('INSERT INTO memberships'));
    expect(companyInsertIndex).toBeLessThan(roleInsertIndex);
    expect(roleInsertIndex).toBeLessThan(membershipInsertIndex);
  });
});
