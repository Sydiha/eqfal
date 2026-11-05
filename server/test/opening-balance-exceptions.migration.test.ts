import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OB_CODES } from '../src/modules/opening-balances/opening-balance-reconciliation';
import { OB_EXCEPTION_ELIGIBLE_CODES, reasonIsMeaningful } from '../src/modules/opening-balances/opening-balance-exceptions';
import {
  ACCOUNTANT_CAPABILITIES, FINANCE_MANAGER_CAPABILITIES, FINANCE_MANAGER_DEFAULT_CAPABILITIES, FINANCE_MANAGER_POST_059_CAPABILITIES, VIEWER_CAPABILITIES,
} from '../src/modules/memberships/default-role-capabilities';
import { capabilitySensitivity } from '../src/modules/memberships/capability-sensitivity';

// C4-P2b-1: static contract of the original migration 097 and its forward extension in 108.
const raw = readFileSync(new URL('../migrations/097_opening_balance_evidence_exceptions.sql', import.meta.url), 'utf8');
const sql = raw.replace(/--.*$/gm, '');
const raw108 = readFileSync(new URL('../migrations/108_opening_balance_cash_evidence_exceptions.sql', import.meta.url), 'utf8');
const sql108 = raw108.replace(/--.*$/gm, '');
const CAP = 'opening_balance.exception.accept';
const sectionValues = (source: string) => [...source.match(/section\s+TEXT\s+NOT NULL CHECK \(section IN \(([^)]*)\)\)/)![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
const issueCodeValues = (source: string) => {
  const check = source.match(/issue_code\s+TEXT\s+NOT NULL CHECK \(issue_code IN \(([\s\S]*?)\)\)/)![1]!;
  return [...check.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
};
const extendedSectionValues = (source: string) => [...source.match(/opening_balance_evidence_exceptions_section_check[\s\S]*?CHECK \(section IN \(([^)]*)\)\)/)![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
const extendedIssueCodeValues = (source: string) => {
  const check = source.match(/opening_balance_evidence_exceptions_issue_code_check[\s\S]*?CHECK \(issue_code IN \(([\s\S]*?)\)\)/)![1]!;
  return [...check.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
};

describe('migration 097 (opening balance evidence exceptions)', () => {
  it('preserves the original section and issue-code checks from main', () => {
    expect(sectionValues(sql)).toEqual(['bank', 'receivable', 'payable']);
    expect(issueCodeValues(sql)).toEqual([
      'OB_BANK_AGGREGATE_ONLY', 'OB_REFERENCE_MISSING', 'OB_BANK_EVIDENCE_MISSING', 'OB_BANK_CURRENCY_NOT_COMPARABLE',
      'OB_FUNCTIONAL_CURRENCY_UNKNOWN', 'OB_CONTROL_ACCOUNT_UNMAPPED', 'OB_SUBLEDGER_AGGREGATE_ONLY',
      'OB_SUBLEDGER_UNLINKED_OBLIGATION', 'OB_SUBLEDGER_TOTAL_DIFFERENCE',
    ]);
    expect(sql).not.toMatch(/ALTER TABLE|DROP CONSTRAINT/);
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

describe('migration 108 (physical cash evidence exceptions)', () => {
  it('extends both checks without dropping any value accepted by migration 097', () => {
    expect(sql108).toContain('DROP CONSTRAINT opening_balance_evidence_exceptions_section_check');
    expect(sql108).toContain('DROP CONSTRAINT opening_balance_evidence_exceptions_issue_code_check');
    expect(extendedSectionValues(sql108)).toEqual(['bank', 'cash_on_hand', 'receivable', 'payable']);
    expect(extendedIssueCodeValues(sql108)).toEqual([
      'OB_BANK_AGGREGATE_ONLY', 'OB_PHYSICAL_CASH_EVIDENCE_MISSING', 'OB_PHYSICAL_CASH_EVIDENCE_USER_DECLARED',
      'OB_REFERENCE_MISSING', 'OB_BANK_EVIDENCE_MISSING', 'OB_BANK_CURRENCY_NOT_COMPARABLE',
      'OB_FUNCTIONAL_CURRENCY_UNKNOWN', 'OB_CONTROL_ACCOUNT_UNMAPPED', 'OB_SUBLEDGER_AGGREGATE_ONLY',
      'OB_SUBLEDGER_UNLINKED_OBLIGATION', 'OB_SUBLEDGER_TOTAL_DIFFERENCE',
    ]);
    expect(extendedSectionValues(sql108)).toEqual(expect.arrayContaining(sectionValues(sql)));
    expect(extendedIssueCodeValues(sql108)).toEqual(expect.arrayContaining(issueCodeValues(sql)));
    expect([...extendedIssueCodeValues(sql108)].sort()).toEqual([...OB_EXCEPTION_ELIGIBLE_CODES].sort());
    for (const c of Object.values(OB_CODES).filter((x) => !OB_EXCEPTION_ELIGIBLE_CODES.includes(x))) {
      expect(extendedIssueCodeValues(sql108), c).not.toContain(c);
    }
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
