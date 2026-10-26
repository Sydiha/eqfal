import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OB_CODES } from '../src/modules/opening-balances/opening-balance-reconciliation';
import { OB_EXCEPTION_ELIGIBLE_CODES, reasonIsMeaningful } from '../src/modules/opening-balances/opening-balance-exceptions';
import {
  ACCOUNTANT_CAPABILITIES, FINANCE_MANAGER_CAPABILITIES, FINANCE_MANAGER_DEFAULT_CAPABILITIES, FINANCE_MANAGER_POST_059_CAPABILITIES, VIEWER_CAPABILITIES,
} from '../src/modules/memberships/default-role-capabilities';
import { capabilitySensitivity } from '../src/modules/memberships/capability-sensitivity';

// C4-P2b-1: static contract of migration 097 and of the capability grant (no database needed).
const raw = readFileSync(new URL('../migrations/097_opening_balance_evidence_exceptions.sql', import.meta.url), 'utf8');
const sql = raw.replace(/--.*$/gm, '');
const CAP = 'opening_balance.exception.accept';

describe('migration 097 (opening balance evidence exceptions)', () => {
  it('allows exactly the nine incomplete-evidence codes and no blocked or mismatch code', () => {
    const check = sql.match(/issue_code\s+TEXT\s+NOT NULL CHECK \(issue_code IN \(([\s\S]*?)\)\)/)![1]!;
    const codes = [...check.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
    expect([...codes].sort()).toEqual([...OB_EXCEPTION_ELIGIBLE_CODES].sort());
    expect(codes).toHaveLength(9);
    for (const c of Object.values(OB_CODES).filter((x) => !OB_EXCEPTION_ELIGIBLE_CODES.includes(x))) expect(codes, c).not.toContain(c);
  });

  it('is additive: one new table, no change to an existing table, row or constraint', () => {
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).not.toMatch(/ALTER TABLE|DROP |TRUNCATE|DELETE FROM|UPDATE opening_balance_(items|reviews)|UPDATE journal|INSERT INTO opening_balance_(items|reviews)/i);
    expect(sql).toMatch(/FOREIGN KEY \(review_id, company_id\) REFERENCES opening_balance_reviews\(id, company_id\)/);
    expect(sql).toMatch(/UNIQUE INDEX opening_balance_exceptions_active_uidx[\s\S]*WHERE status = 'active'/);
    expect(sql).toMatch(/non-whitespace|regexp_replace\(reason, '\\s', '', 'g'\)\) >= 10/);
  });

  it('registers the capability and grants it only to Finance Manager roles that can already approve', () => {
    expect(sql).toMatch(/INSERT INTO capabilities \(id\) VALUES \('opening_balance\.exception\.accept'\)/);
    const grant = sql.slice(sql.indexOf('INSERT INTO role_capabilities'));
    expect(grant).toMatch(/r\.name IN \('Finance Manager', 'finance_manager'\)/);
    expect(grant).toMatch(/capability_id = 'opening_balance\.approve'/);
    expect(grant).not.toMatch(/accountant|viewer|Accountant|Viewer/);
    expect(sql.match(/INSERT INTO role_capabilities/g)).toHaveLength(1);
  });
});

describe('capability opening_balance.exception.accept', () => {
  it('is held by the default Finance Manager only, never by Accountant or Viewer, and the frozen 059 matrix is unchanged', () => {
    expect(FINANCE_MANAGER_POST_059_CAPABILITIES).toEqual([CAP]);
    expect(FINANCE_MANAGER_DEFAULT_CAPABILITIES).toContain(CAP);
    expect(FINANCE_MANAGER_CAPABILITIES).not.toContain(CAP);
    expect(FINANCE_MANAGER_CAPABILITIES).toHaveLength(96);
    expect(ACCOUNTANT_CAPABILITIES).not.toContain(CAP);
    expect(VIEWER_CAPABILITIES).not.toContain(CAP);
    expect(capabilitySensitivity(CAP)).toBe('sensitive');
  });
});

describe('reason rule', () => {
  it('needs 10 non-whitespace characters', () => {
    for (const bad of ['', ' ', 'abcdefghi', ' a b c d e f g h i ', '    x', 5, null, undefined, 'x'.repeat(1001)]) expect(reasonIsMeaningful(bad), String(bad)).toBe(false);
    for (const ok of ['abcdefghij', '  abcde fghij  ', 'x'.repeat(1000)]) expect(reasonIsMeaningful(ok), ok).toBe(true);
  });
});
