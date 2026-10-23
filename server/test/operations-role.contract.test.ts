import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPERATIONS_CAPABILITIES } from '../src/modules/memberships/default-role-capabilities';
import { APPROVAL_REQUIRED_CAPABILITIES } from '../src/modules/invoices/invoice-approval.service';
import { isAdministrativeCapability } from '../src/modules/memberships/membership.service';
import { readdirSync } from 'node:fs';

const migrationsDir = new URL('../migrations/', import.meta.url);
const strip = (t: string) => t.replace(/--.*$/gm, '');
const migration081 = strip(readFileSync(new URL('081_operations_default_role.sql', migrationsDir), 'utf8'));

const registered = new Set(
  readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).flatMap((file) =>
    [...strip(readFileSync(new URL(file, migrationsDir), 'utf8')).matchAll(/INSERT INTO capabilities\s*\([^)]*\)\s*VALUES([\s\S]*?)(?:ON CONFLICT|;)/g)]
      .flatMap((m) => [...m[1]!.matchAll(/\('([a-z_]+(?:\.[a-z_]+)+)'/g)].map((x) => x[1]!))),
);

const opsIn081 = (() => {
  const block = migration081.match(/WITH ops_caps\(capability_id\) AS \(\s*VALUES([\s\S]*?)\)\s*,\s*new_roles/);
  if (!block) throw new Error('ops_caps block not found in migration 081');
  return [...block[1]!.matchAll(/\('([^']+)'\)/g)].map((m) => m[1]!);
})();

describe('Operations default role (migration 081)', () => {
  it('migration grants exactly OPERATIONS_CAPABILITIES, all registered, no duplicates', () => {
    expect(new Set(opsIn081).size).toBe(opsIn081.length);
    expect([...opsIn081].sort()).toEqual([...OPERATIONS_CAPABILITIES].sort());
    for (const id of OPERATIONS_CAPABILITIES) expect(registered.has(id), id).toBe(true);
  });

  it('migration is idempotent and additive: skips companies that have the role, registers nothing, touches no membership or existing role', () => {
    expect(migration081).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM roles r WHERE r\.company_id = c\.id AND r\.name = 'Operations'\)/);
    expect(migration081).toMatch(/ON CONFLICT DO NOTHING/);
    expect(migration081).not.toMatch(/INSERT INTO capabilities|memberships|UPDATE |DELETE |DROP |ALTER /i);
    expect(migration081).toMatch(/INSERT INTO role_capabilities[\s\S]*FROM new_roles/);
  });

  it('can approve its own invoices: invoice.approve alone is the approval requirement and Operations holds it', () => {
    expect([...APPROVAL_REQUIRED_CAPABILITIES]).toEqual(['invoice.approve']);
    for (const id of APPROVAL_REQUIRED_CAPABILITIES) expect(OPERATIONS_CAPABILITIES).toContain(id);
    for (const id of ['invoice.view', 'invoice.create', 'invoice.edit', 'invoice.submit']) expect(OPERATIONS_CAPABILITIES).toContain(id);
  });

  it('cannot post, create, edit, reverse or delete manual journals, close periods or VAT, or administer access', () => {
    for (const id of OPERATIONS_CAPABILITIES) {
      expect(id, id).not.toMatch(/^accounting\.journal\.|^fiscal_year\.(?!view)|^monthly_close\.(?!view)|^vat\.(close|reopen|review)|\.reopen$|\.close$|\.post$|\.reverse$|^access\./);
      expect(isAdministrativeCapability(id), id).toBe(false);
    }
    for (const id of ['invoice.cancel', 'invoice.delete', 'invoice.adjust', 'invoice.adjust_approve', 'invoice.adjust_void', 'invoice.recurring', 'document.approve', 'document.delete', 'access.full_access.grant']) {
      expect(OPERATIONS_CAPABILITIES, id).not.toContain(id);
    }
  });
});
