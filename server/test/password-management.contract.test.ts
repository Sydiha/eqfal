import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sensitivityMap } from '../src/modules/memberships/capability-sensitivity';

const migration = readFileSync(new URL('../migrations/082_password_management.sql', import.meta.url), 'utf8');
const sources = ['../src/modules/auth/auth.router.ts', '../src/modules/memberships/access-administration.router.ts', '../src/modules/memberships/membership.service.ts', '../src/modules/auth/session.service.ts']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');

describe('migration 082', () => {
  it('adds the must-change flag and the reset capability, and grants it to no role', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(migration).toMatch(/INSERT INTO capabilities \(id\) VALUES \('access\.user\.password\.reset'\) ON CONFLICT \(id\) DO NOTHING/);
    expect(migration).not.toMatch(/INSERT INTO role_capabilities/i);
  });
  it('classifies password reset as critical access administration', () => {
    expect(sensitivityMap(['access.user.password.reset'])['access.user.password.reset']).toBe('critical');
  });
});

describe('secret hygiene', () => {
  it('never passes passwords or hashes to the logger or the audit trail', () => {
    expect(sources).not.toMatch(/logger\.\w+\([^)]*(password|hash)/i);
    expect(sources).not.toMatch(/after_data: \{[^}]*(temporaryPassword|newPassword|currentPassword|password_hash)/);
  });
  it('returns passwords only in the reset response body, never in a URL or query string', () => {
    expect(sources).not.toMatch(/req\.(query|params)\.(password|temporaryPassword|newPassword)/);
  });
});
