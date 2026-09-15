import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('../migrations/036_tax_workpaper_admin_capabilities.sql', import.meta.url),
  'utf8',
);

describe('Tax/Zakat working-paper admin capability migration', () => {
  it('assigns all four Phase 7A capabilities through role_capabilities', () => {
    for (const capability of ['view', 'manage', 'review', 'approve']) {
      expect(sql).toContain(`('tax_workpaper.${capability}')`);
    }
    expect(sql).toMatch(/INSERT INTO role_capabilities \(role_id, capability_id\)/i);
  });

  it('targets only company-scoped admin roles', () => {
    expect(sql).toMatch(/SELECT r\.id, capability\.id[\s\S]*FROM roles r/i);
    expect(sql).toContain("WHERE LOWER(BTRIM(r.name)) = 'admin'");
    expect(sql).not.toMatch(/INSERT INTO roles|UPDATE roles/i);
  });

  it('is safe to apply when assignments already exist', () => {
    expect(sql).toMatch(/ON CONFLICT \(role_id, capability_id\) DO NOTHING/i);
  });
});
