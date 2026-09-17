import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../migrations/052_access_administration_capability_granularity.sql', import.meta.url),
  'utf8',
);
const router = readFileSync(
  new URL('../src/modules/memberships/access-administration.router.ts', import.meta.url),
  'utf8',
);

describe('access administration capability granularity contract', () => {
  const granularCapabilities = [
    'access.view',
    'access.membership.create',
    'access.membership.status.edit',
    'access.membership.role.assign',
    'access.role.create',
    'access.role.capability.grant',
    'access.role.capability.revoke',
  ];

  it('seeds every granular capability and backfills legacy access.manage holders idempotently', () => {
    for (const capability of granularCapabilities) {
      expect(migration).toContain(`('${capability}')`);
    }
    expect(migration).toContain("WHERE rc.capability_id = 'access.manage'");
    expect(migration).toMatch(/ON CONFLICT\s*\(id\)\s*DO NOTHING/i);
    expect(migration).toMatch(/ON CONFLICT\s*\(role_id, capability_id\)\s*DO NOTHING/i);
  });

  it('binds each access administration route to its exact action capability', () => {
    expect(router).toContain("requireCapability('access.view')");
    expect(router).toContain("writeGuards('access.membership.create')");
    expect(router).toContain("writeGuards('access.membership.status.edit')");
    expect(router).toContain("writeGuards('access.membership.role.assign')");
    expect(router).toContain("writeGuards('access.role.create')");
    expect(router).toContain("writeGuards('access.role.capability.grant')");
    expect(router).toContain("writeGuards('access.role.capability.revoke')");
  });

  it('does not use legacy access.manage as a runtime authorization fallback', () => {
    expect(router).not.toContain("requireCapability('access.manage')");
    expect(router).not.toContain("includes('access.manage')");
  });
});
