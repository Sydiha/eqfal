import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('../migrations/023_full_access_roles.sql', import.meta.url),
  'utf8',
);

describe('Migration 023 Full Access role', () => {
  it('adds the fail-closed Full Access flag', () => {
    expect(sql).toMatch(/ADD COLUMN is_full_access BOOLEAN NOT NULL DEFAULT FALSE/i);
  });

  it('backfills only the approved company and role identifiers', () => {
    expect(sql).toContain("id = 'a7360c62-5b19-4333-8184-fb74e7465b43'");
    expect(sql).toContain("company_id = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'");
    expect(sql.match(/SET is_full_access = TRUE/gi)).toHaveLength(1);
  });

  it('contains no name, email, capability-count, or fallback promotion', () => {
    const update = sql.slice(sql.indexOf('UPDATE roles'));
    expect(update).not.toMatch(/\bname\b|email|count\s*\(|role_capabilities|first|fallback/i);
    expect(update).not.toMatch(/\bOR\b/i);
  });
});
