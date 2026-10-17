import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { AUTHORITY_ERROR_CODES, LedgerSourceAuthorityService } from '../src/modules/accounting/ledger-source-authority';

const migration = readFileSync(path.resolve(__dirname, '../migrations/085_ledger_source_authority_lockdown.sql'), 'utf8');
const body = migration.split('\n').filter((line) => !line.startsWith('--')).join('\n');

describe('migration 085 (static contract)', () => {
  it('only replaces the two authority trigger functions; no table, row or journal change', () => {
    expect(body).not.toMatch(/\b(ALTER TABLE|UPDATE\s+\w+\s+SET|DELETE FROM|TRUNCATE|INSERT INTO|DROP)\b/i);
    expect(body.match(/CREATE OR REPLACE FUNCTION (\w+)/g)).toEqual([
      'CREATE OR REPLACE FUNCTION ledger_source_authority_guard_insert',
      'CREATE OR REPLACE FUNCTION ledger_source_authority_guard_update',
    ]);
    expect(body).not.toMatch(/journal_entries/);
    for (const word of ['PREREQUISITES', 'PERFORMANCE', 'ROLLBACK']) expect(migration).toContain(word);
  });
  it('accepts an insert only as draft and an update only as draft -> voided', () => {
    expect(body).toMatch(/IF NEW\.status IS DISTINCT FROM 'draft' THEN\s+RAISE EXCEPTION 'AUTHORITY_ACTIVE_INSERT_FORBIDDEN'/);
    expect(body).toMatch(/IF OLD\.status = 'draft' AND NEW\.status = 'voided'/);
    expect(body).not.toMatch(/OLD\.status IN \('active'/);
    expect(body).not.toMatch(/NEW\.status = 'active'/);
  });
});

describe('service surface', () => {
  it('no longer exposes create() or void() of active ranges', () => {
    const proto = LedgerSourceAuthorityService.prototype as unknown as Record<string, unknown>;
    expect(proto['create']).toBeUndefined();
    expect(proto['void']).toBeUndefined();
    expect(typeof proto['createDraft']).toBe('function');
    expect(typeof proto['voidDraft']).toBe('function');
    expect(AUTHORITY_ERROR_CODES).toContain('AUTHORITY_ACTIVE_INSERT_FORBIDDEN');
  });
});
