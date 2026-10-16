import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { capabilitySensitivity } from '../src/modules/memberships/capability-sensitivity';
import { assertFiscalYearNotInCutoverPath, assertLedgerSourceAuthority, LedgerSourceAuthorityService } from '../src/modules/accounting/ledger-source-authority';
import { LedgerSourceAuthorityBlockedError } from '../src/modules/accounting/journal-posting-errors';

const migration = readFileSync(path.resolve(__dirname, '../migrations/083_ledger_source_authority.sql'), 'utf8');

describe('migration 083 (static contract)', () => {
  it('is additive: creates objects and registers capabilities, never alters or rewrites existing rows', () => {
    expect(migration).not.toMatch(/^\s*(ALTER TABLE|UPDATE |DELETE FROM|TRUNCATE|DROP )/im);
    expect(migration).toMatch(/CREATE TABLE ledger_source_authority/);
    expect(migration).toMatch(/INSERT INTO capabilities \(id\) VALUES\s*\('source_authority\.view'\),\s*\('source_authority\.manage'\)\s*ON CONFLICT \(id\) DO NOTHING/);
  });
  it('allows only external_reference_only and never imported_ledger', () => {
    expect(migration).toMatch(/CHECK \(authority = 'external_reference_only'\)/);
    expect(migration).not.toMatch(/imported_ledger'\)/);
  });
  it('uses the application month-lock key format and takes no row locks inside triggers', () => {
    expect(migration).toMatch(/'accounting-period:' \|\| /);
    expect(migration).not.toMatch(/FOR (UPDATE|SHARE|NO KEY UPDATE)/);
  });
  it('documents prerequisites, performance and rollback', () => {
    for (const word of ['PREREQUISITES', 'PERFORMANCE', 'ROLLBACK', 'LIMIT']) expect(migration).toContain(word);
  });
});

describe('capability classification', () => {
  it('classifies both authority capabilities as critical', () => {
    expect(capabilitySensitivity('source_authority.manage')).toBe('critical');
    expect(capabilitySensitivity('source_authority.view')).toBe('critical');
  });
});

describe('application guard (mocked client)', () => {
  const client = (rowCount: number, year = true) => ({
    query: vi.fn(async (sql: string) => (/FROM fiscal_years WHERE id/.test(sql) && !/ledger_source_authority/.test(sql)
      ? { rows: year ? [{ start_date: '2026-01-01' }] : [], rowCount: year ? 1 : 0 }
      : /pg_advisory_xact_lock/.test(sql) ? { rows: [], rowCount: 1 } : { rows: [], rowCount })),
  });
  it('passes when no active range covers the date and blocks with a stable code otherwise', async () => {
    await expect(assertLedgerSourceAuthority(client(0) as never, 'c', '2026-02-02')).resolves.toBeUndefined();
    const err = await assertLedgerSourceAuthority(client(1) as never, 'c', '2026-02-02').catch((e) => e);
    expect(err).toBeInstanceOf(LedgerSourceAuthorityBlockedError);
    expect(err.code).toBe('LEDGER_SOURCE_AUTHORITY_BLOCKED');
  });
  it('blocks the opening path for a cut-over year and ignores a missing year', async () => {
    const err = await assertFiscalYearNotInCutoverPath(client(1) as never, 'c', 'fy').catch((e) => e);
    expect(err.code).toBe('ONBOARDING_PATH_CUTOVER_ACTIVE');
    await expect(assertFiscalYearNotInCutoverPath(client(1, false) as never, 'c', 'fy')).resolves.toBeUndefined();
  });
  it('rejects malformed create input before touching the database', async () => {
    const db = { connect: vi.fn() };
    const svc = new LedgerSourceAuthorityService(db as never);
    for (const bad of [{ fromDate: '2026-02-30', toDate: '2026-03-01', reason: 'x' }, { fromDate: '2026-03-02', toDate: '2026-03-01', reason: 'x' }, { fromDate: '2026-01-01', toDate: '2026-01-31', reason: '  ' }]) {
      await expect(svc.create('c', 'u', bad)).rejects.toMatchObject({ code: 'AUTHORITY_RANGE_INVALID' });
    }
    expect(db.connect).not.toHaveBeenCalled();
  });
});
