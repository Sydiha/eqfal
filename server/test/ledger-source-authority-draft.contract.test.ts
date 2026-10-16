import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { LedgerSourceAuthorityService } from '../src/modules/accounting/ledger-source-authority';

const migration = readFileSync(path.resolve(__dirname, '../migrations/084_ledger_source_authority_draft.sql'), 'utf8');
const router = readFileSync(path.resolve(__dirname, '../src/modules/ledger-source-authority/ledger-source-authority.router.ts'), 'utf8');

describe('migration 084 (static contract)', () => {
  it('only reshapes the authority table and its three functions; it never touches journals or existing rows', () => {
    expect(migration).not.toMatch(/(UPDATE|DELETE FROM|TRUNCATE|INSERT INTO)\s+(journal_entries|ledger_source_authority|fiscal_years)/i);
    expect(migration).not.toMatch(/ALTER TABLE\s+journal_entries/i);
    expect(migration).toMatch(/status IN \('draft', 'active', 'voided'\)/);
    for (const word of ['PREREQUISITES', 'PERFORMANCE', 'ROLLBACK']) expect(migration).toContain(word);
  });
  it('never lets a draft become active and keeps the 083 active checks', () => {
    expect(migration).not.toMatch(/OLD\.status\s*=\s*'draft'\s+AND\s+NEW\.status\s*=\s*'active'/);
    expect(migration).toMatch(/OLD\.status IN \('active', 'draft'\) AND NEW\.status = 'voided'/);
    for (const code of ['AUTHORITY_RANGE_HAS_JOURNALS', 'AUTHORITY_RANGE_CLOSED_PERIOD', 'AUTHORITY_ONBOARDING_PATH_CONFLICT']) expect(migration).toContain(code);
  });
});

describe('draft routes', () => {
  it('has no activation route, requires manage + same origin on writes, and enforces confirmation', () => {
    expect(router).not.toMatch(/'\/ledger-source-authority[^']*activat/i);
    expect(router.match(/router\.post|ledgerSourceAuthorityRouter\.post/g)).toHaveLength(2);
    expect(router.match(/requireSameOrigin, requireAuth, requireActiveCompany, requireCapability\(MANAGE\[0\]\)/g)).toHaveLength(2);
    expect(router.match(/CONFIRMATION_REQUIRED/g)).toHaveLength(2);
  });
  it('rejects malformed draft input before touching the database', async () => {
    const db = { connect: vi.fn() };
    const svc = new LedgerSourceAuthorityService(db as never);
    await expect(svc.createDraft('c', 'u', { fromDate: '2026-01-01', toDate: '2026-02-30', reason: 'x' })).rejects.toMatchObject({ code: 'AUTHORITY_RANGE_INVALID' });
    await expect(svc.voidDraft('c', 'u', 'id', '  ')).rejects.toMatchObject({ code: 'AUTHORITY_RANGE_INVALID' });
    expect(db.connect).not.toHaveBeenCalled();
  });
});
