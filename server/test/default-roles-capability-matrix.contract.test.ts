import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTANT_ADDITIONAL_CAPABILITIES,
  ACCOUNTANT_CAPABILITIES,
  FINANCE_MANAGER_ADDITIONAL_CAPABILITIES,
  FINANCE_MANAGER_CAPABILITIES,
  LEGACY_UNASSIGNED_CAPABILITIES,
  VIEWER_CAPABILITIES,
} from '../src/modules/memberships/default-role-capabilities';

const migration = readFileSync(
  new URL('../migrations/059_default_roles_capability_matrix.sql', import.meta.url),
  'utf8',
);

/** Strip SQL line comments so comment text can never satisfy an assertion. */
const sql = migration.replace(/--.*$/gm, '');

function quotedIds(block: string): string[] {
  return [...block.matchAll(/\('([^']+)'\)/g)].map((m) => m[1]);
}

/** Capabilities registered by the first INSERT INTO capabilities statement. */
function parseRegisteredCapabilities(): string[] {
  const m = sql.match(/INSERT INTO capabilities \(id\) VALUES([\s\S]*?)ON CONFLICT/);
  if (!m) throw new Error('capabilities INSERT not found in migration 059');
  return quotedIds(m[1]);
}

/** Capabilities granted to a role by its `CROSS JOIN (VALUES ...) AS cap(id) ... r.name = '<role>'` insert. */
function parseRoleGrant(roleName: string): string[] {
  const re = /CROSS JOIN \(VALUES([\s\S]*?)\) AS cap\(id\)\s*WHERE[\s\S]*?r\.name = '([^']+)'/g;
  const grants: string[][] = [];
  for (const m of sql.matchAll(re)) if (m[2] === roleName) grants.push(quotedIds(m[1]));
  if (grants.length !== 1) throw new Error(`expected exactly one grant block for ${roleName}, found ${grants.length}`);
  return grants[0];
}

const sameSet = (actual: readonly string[], expected: readonly string[]) => {
  expect(new Set(actual).size).toBe(actual.length); // no duplicates in SQL
  expect([...new Set(actual)].sort()).toEqual([...new Set(expected)].sort());
};

describe('default roles capability matrix contract', () => {
  const viewer = new Set(VIEWER_CAPABILITIES);
  const accountant = new Set(ACCOUNTANT_CAPABILITIES);
  const financeManager = new Set(FINANCE_MANAGER_CAPABILITIES);

  it('canonical definition has exact counts 20 / 46 / 96 / 13 with no duplicates', () => {
    expect(VIEWER_CAPABILITIES.length).toBe(20);
    expect(viewer.size).toBe(20);
    expect(ACCOUNTANT_ADDITIONAL_CAPABILITIES.length).toBe(26);
    expect(ACCOUNTANT_CAPABILITIES.length).toBe(46);
    expect(accountant.size).toBe(46);
    expect(FINANCE_MANAGER_ADDITIONAL_CAPABILITIES.length).toBe(50);
    expect(FINANCE_MANAGER_CAPABILITIES.length).toBe(96);
    expect(financeManager.size).toBe(96);
    expect(LEGACY_UNASSIGNED_CAPABILITIES.length).toBe(13);
    expect(new Set(LEGACY_UNASSIGNED_CAPABILITIES).size).toBe(13);
  });

  it('hierarchy holds: Viewer is a subset of Accountant, which is a subset of Finance Manager', () => {
    for (const c of viewer) expect(accountant.has(c)).toBe(true);
    for (const c of accountant) expect(financeManager.has(c)).toBe(true);
    expect(accountant.size).toBeGreaterThan(viewer.size);
    expect(financeManager.size).toBeGreaterThan(accountant.size);
  });

  it('SQL matrix for Viewer equals the canonical definition exactly', () => {
    const grant = parseRoleGrant('viewer');
    expect(grant.length).toBe(VIEWER_CAPABILITIES.length);
    sameSet(grant, VIEWER_CAPABILITIES);
  });

  it('SQL matrix for Accountant equals the canonical definition exactly', () => {
    const grant = parseRoleGrant('accountant');
    expect(grant.length).toBe(ACCOUNTANT_CAPABILITIES.length);
    sameSet(grant, ACCOUNTANT_CAPABILITIES);
  });

  it('SQL matrix for Finance Manager equals the canonical definition exactly', () => {
    const grant = parseRoleGrant('finance_manager');
    expect(grant.length).toBe(FINANCE_MANAGER_CAPABILITIES.length);
    sameSet(grant, FINANCE_MANAGER_CAPABILITIES);
  });

  it('SQL registers exactly the canonical default-role capabilities plus the 13 legacy ones', () => {
    sameSet(parseRegisteredCapabilities(), [...FINANCE_MANAGER_CAPABILITIES, ...LEGACY_UNASSIGNED_CAPABILITIES]);
  });

  it('legacy/unassigned capabilities are registered in SQL but granted to no default role (SQL and canonical)', () => {
    const registered = new Set(parseRegisteredCapabilities());
    const grants = [...parseRoleGrant('viewer'), ...parseRoleGrant('accountant'), ...parseRoleGrant('finance_manager')];
    for (const capability of LEGACY_UNASSIGNED_CAPABILITIES) {
      expect(registered.has(capability)).toBe(true);
      expect(grants).not.toContain(capability);
      expect(financeManager.has(capability)).toBe(false);
    }
  });

  it('ALL access.* capabilities including access.view are Full Access only: zero in Viewer, Accountant, Finance Manager (canonical and SQL)', () => {
    const isAccess = (c: string) => c.startsWith('access.');
    for (const caps of [VIEWER_CAPABILITIES, ACCOUNTANT_CAPABILITIES, FINANCE_MANAGER_CAPABILITIES, LEGACY_UNASSIGNED_CAPABILITIES]) {
      expect(caps.filter(isAccess)).toEqual([]);
      expect(caps).not.toContain('access.view');
    }
    for (const role of ['viewer', 'accountant', 'finance_manager']) {
      expect(parseRoleGrant(role).filter(isAccess)).toEqual([]);
    }
    expect(parseRegisteredCapabilities().filter(isAccess)).toEqual([]);
  });

  it('limited roles have only company.view among company.* capabilities', () => {
    for (const caps of [VIEWER_CAPABILITIES, ACCOUNTANT_CAPABILITIES, FINANCE_MANAGER_CAPABILITIES]) {
      expect(caps.filter((c) => c.startsWith('company.'))).toEqual(['company.view']);
    }
  });

  it('verifies Full Access role is not modified (idempotent migration)', () => {
    // The migration should explicitly preserve Full Access by not modifying is_full_access = TRUE rows
    expect(migration).toContain('is_full_access = FALSE');
    expect(migration).not.toContain('UPDATE roles SET is_full_access = TRUE');
    expect(migration).not.toContain('is_full_access = TRUE' + "'" || 'is_full_access = TRUE' + '"');
  });

  it('migration uses idempotent syntax (ON CONFLICT, DELETE WHERE, INSERT ... WHERE NOT EXISTS)', () => {
    expect(migration).toMatch(/ON CONFLICT.*DO NOTHING/i);
    expect(migration).toMatch(/DELETE FROM role_capabilities/);
    expect(migration).toMatch(/WHERE NOT EXISTS/);
  });

  it('creates default roles as non-full-access templates', () => {
    expect(migration).toContain("'viewer'");
    expect(migration).toContain("'accountant'");
    expect(migration).toContain("'finance_manager'");
    expect(migration).toContain('is_full_access = FALSE');
  });

  it('migration targets test company for baseline', () => {
    // Migration should apply to test company (0e8574b6-5828-40c6-9b56-7dbd1c7e9def)
    expect(migration).toContain("'0e8574b6-5828-40c6-9b56-7dbd1c7e9def'");
  });

  it('total capability counts match approved specification', () => {
    expect(parseRoleGrant('viewer').length).toBe(20);
    expect(parseRoleGrant('accountant').length).toBe(46);
    expect(parseRoleGrant('finance_manager').length).toBe(96);
  });
});
