import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMPANY_MANAGER_CAPABILITIES, VIEWER_CAPABILITIES } from '../src/modules/memberships/default-role-capabilities';
import { capabilitySensitivity, sensitivityMap } from '../src/modules/memberships/capability-sensitivity';

const migrationsDir = new URL('../migrations/', import.meta.url);
const stripComments = (text: string) => text.replace(/--.*$/gm, '');
const migration075 = stripComments(readFileSync(new URL('075_system_admin_and_full_access_wildcard.sql', migrationsDir), 'utf8'));

/** Every capability id any migration registers (INSERT INTO capabilities ... ON CONFLICT / ;). */
const registered = new Set(
  readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).flatMap((file) => {
    const sql = stripComments(readFileSync(new URL(file, migrationsDir), 'utf8'));
    return [...sql.matchAll(/INSERT INTO capabilities\s*\([^)]*\)\s*VALUES([\s\S]*?)(?:ON CONFLICT|;)/g)]
      .flatMap((m) => [...m[1]!.matchAll(/\('([a-z_]+(?:\.[a-z_]+)+)'/g)].map((x) => x[1]!));
  }),
);

const managerCapsIn075 = (() => {
  const block = migration075.match(/WITH manager_caps\(capability_id\) AS \(\s*VALUES([\s\S]*?)\)\s*,\s*new_roles/);
  if (!block) throw new Error('manager_caps block not found in migration 075');
  return [...block[1]!.matchAll(/\('([^']+)'\)/g)].map((m) => m[1]!);
})();

describe('migration 075 access model contract', () => {
  it('makes Full Access a wildcard that cannot be narrowed again', () => {
    expect(migration075).toMatch(/UPDATE capabilities SET implicit_full_access = TRUE/);
    expect(migration075).toMatch(/CHECK \(implicit_full_access = TRUE\)/);
  });

  it('adds the System Admin marker without promoting anybody', () => {
    expect(migration075).toMatch(/ADD COLUMN is_system_admin BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(migration075).not.toMatch(/SET\s+is_system_admin\s*=\s*TRUE/i);
    expect(migration075).not.toMatch(/INSERT INTO users/i);
  });

  it('provisions Company Manager with exactly COMPANY_MANAGER_CAPABILITIES, all registered', () => {
    expect([...managerCapsIn075].sort()).toEqual([...COMPANY_MANAGER_CAPABILITIES].sort());
    for (const id of COMPANY_MANAGER_CAPABILITIES) expect(registered.has(id), id).toBe(true);
    for (const id of VIEWER_CAPABILITIES) expect(COMPANY_MANAGER_CAPABILITIES).toContain(id);
  });

  it('keeps Company Manager conservative: no manual journals, closing, reopening, final tax approval, approvals or Full Access grant', () => {
    for (const id of COMPANY_MANAGER_CAPABILITIES) {
      expect(id, id).not.toMatch(/^accounting\.journal\.|\.close$|\.reopen$|\.approve$|\.adjust_approve$|\.post$|\.finalize$|^access\.full_access\.grant$|^access\.manage$|^company\.(create|status\.edit)$/);
    }
  });
});

describe('capability sensitivity classification', () => {
  it('classifies every listed id against a registered capability', () => {
    expect(registered.has('access.full_access.grant')).toBe(true);
    expect(registered.size).toBeGreaterThan(100);
    expect(registered.has('invoice.approve')).toBe(true);
    const all = [...registered];
    const map = sensitivityMap(all);
    for (const id of Object.keys(map)) expect(registered.has(id), id).toBe(true);
    // Normal capabilities are left out of the map so the UI stays quiet for them.
    expect(Object.values(map).every((level) => level === 'sensitive' || level === 'critical')).toBe(true);
    expect(map['invoice.view']).toBeUndefined();
  });

  it('marks closing, reopening, posting and access administration critical; approvals sensitive; reads normal', () => {
    for (const id of ['fiscal_year.close', 'monthly_close.reopen', 'accounting.journal.post', 'access.full_access.grant', 'access.role.capability.grant', 'access.membership.role.assign', 'vat.close']) {
      expect(capabilitySensitivity(id), id).toBe('critical');
    }
    for (const id of ['invoice.approve', 'invoice.adjust_approve', 'obligation.confirm', 'accounting.journal.create', 'access.membership.create']) {
      expect(capabilitySensitivity(id), id).toBe('sensitive');
    }
    for (const id of ['invoice.view', 'invoice.create', 'report.view', 'document.upload']) expect(capabilitySensitivity(id), id).toBe('normal');
  });
});
