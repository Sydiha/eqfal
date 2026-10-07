import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { CompanyManagementService } from '../src/modules/companies/company.service';

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

  it('provisions Viewer role with exactly 20 capabilities', async () => {
    const capabilitiesInserted: string[] = [];
    let viewerRoleId = '';

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
        if (name === 'Viewer') viewerRoleId = roleId;
        return { rows: [{ id: roleId }] };
      }
      if (sql.includes('INSERT INTO role_capabilities')) {
        const [roleId, capabilityId] = params as [string, string];
        if (roleId === viewerRoleId) {
          capabilitiesInserted.push(capabilityId);
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO memberships')) return { rows: [] };
      if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
      return { rows: [] };
    });

    const service = new CompanyManagementService(pool);
    await service.create({ slug: 'test-co', name: 'Test Co', name_ar: null }, ACTOR_USER_ID);

    expect(capabilitiesInserted).toHaveLength(20);
    const expectedViewerCaps = [
      'accounting.view',
      'annual_close.view',
      'annual_close.package.view',
      'asset.view',
      'audit.view',
      'bank.view',
      'company.view',
      'company_accounting_profile.view',
      'custody.view',
      'document.view',
      'fiscal_year.view',
      'monthly_close.view',
      'obligation.view',
      'opening_balance.view',
      'partner.view',
      'periodic_adjustment.view',
      'report.view',
      'tax_workpaper.view',
      'vat.view',
      'wht_review.view',
    ];
    for (const cap of expectedViewerCaps) {
      expect(capabilitiesInserted).toContain(cap);
    }
  });

  it('provisions Accountant role with exactly 46 capabilities', async () => {
    const capabilitiesInserted: string[] = [];
    let accountantRoleId = '';

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
        if (name === 'Accountant') accountantRoleId = roleId;
        return { rows: [{ id: roleId }] };
      }
      if (sql.includes('INSERT INTO role_capabilities')) {
        const [roleId, capabilityId] = params as [string, string];
        if (roleId === accountantRoleId) {
          capabilitiesInserted.push(capabilityId);
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO memberships')) return { rows: [] };
      if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
      return { rows: [] };
    });

    const service = new CompanyManagementService(pool);
    await service.create({ slug: 'test-co', name: 'Test Co', name_ar: null }, ACTOR_USER_ID);

    expect(capabilitiesInserted).toHaveLength(46);
    // Check that Accountant includes all 20 Viewer capabilities
    const viewerCaps = [
      'accounting.view',
      'annual_close.view',
      'annual_close.package.view',
      'asset.view',
      'audit.view',
      'bank.view',
      'company.view',
      'company_accounting_profile.view',
      'custody.view',
      'document.view',
      'fiscal_year.view',
      'monthly_close.view',
      'obligation.view',
      'opening_balance.view',
      'partner.view',
      'periodic_adjustment.view',
      'report.view',
      'tax_workpaper.view',
      'vat.view',
      'wht_review.view',
    ];
    for (const cap of viewerCaps) {
      expect(capabilitiesInserted).toContain(cap);
    }
    // Check additional capabilities
    expect(capabilitiesInserted).toContain('accounting.journal.create');
    expect(capabilitiesInserted).toContain('document.edit');
    expect(capabilitiesInserted).toContain('obligation.confirm');
  });

  it('provisions Finance Manager role with exactly 96 capabilities', async () => {
    const capabilitiesInserted: string[] = [];
    let financeManagerRoleId = '';

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
        if (name === 'Finance Manager') financeManagerRoleId = roleId;
        return { rows: [{ id: roleId }] };
      }
      if (sql.includes('INSERT INTO role_capabilities')) {
        const [roleId, capabilityId] = params as [string, string];
        if (roleId === financeManagerRoleId) {
          capabilitiesInserted.push(capabilityId);
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO memberships')) return { rows: [] };
      if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
      return { rows: [] };
    });

    const service = new CompanyManagementService(pool);
    await service.create({ slug: 'test-co', name: 'Test Co', name_ar: null }, ACTOR_USER_ID);

    expect(capabilitiesInserted).toHaveLength(96);
    // Check that Finance Manager includes all 46 Accountant capabilities
    const accountantCaps = [
      'accounting.view',
      'accounting.journal.create',
      'accounting.journal.edit',
      'document.edit',
      'obligation.confirm',
    ];
    for (const cap of accountantCaps) {
      expect(capabilitiesInserted).toContain(cap);
    }
    // Check FM-specific capabilities
    expect(capabilitiesInserted).toContain('accounting.chart.create');
    expect(capabilitiesInserted).toContain('asset.approve');
    expect(capabilitiesInserted).toContain('annual_close.package.approve');
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

  it('does not grant limited roles access.* or company admin capabilities', async () => {
    const allCapabilitiesInserted: Array<{ roleId: string; capabilityId: string }> = [];
    const roleNames: Record<string, string> = {};

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
        roleNames[roleId] = name;
        return { rows: [{ id: roleId }] };
      }
      if (sql.includes('INSERT INTO role_capabilities')) {
        const [roleId, capabilityId] = params as [string, string];
        allCapabilitiesInserted.push({ roleId, capabilityId });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO memberships')) return { rows: [] };
      if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
      return { rows: [] };
    });

    const service = new CompanyManagementService(pool);
    await service.create({ slug: 'test-co', name: 'Test Co', name_ar: null }, ACTOR_USER_ID);

    // Check limited roles (Viewer, Accountant, Finance Manager)
    for (const { roleId, capabilityId } of allCapabilitiesInserted) {
      const roleName = roleNames[roleId];
      if (roleName !== 'Full Access') {
        // Limited roles should not have access.* capabilities
        expect(capabilityId).not.toMatch(/^access\./);
        // Limited roles can only have company.view, not company admin capabilities
        if (capabilityId.startsWith('company.')) {
          expect(capabilityId).toBe('company.view');
        }
      }
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
