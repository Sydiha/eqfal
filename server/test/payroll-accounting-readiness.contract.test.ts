import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/117_payroll_accounting_readiness.sql', import.meta.url), 'utf8');
const service = readFileSync(new URL('../src/modules/payroll/payroll-accounting.ts', import.meta.url), 'utf8');
const router = readFileSync(new URL('../src/modules/payroll/payroll.router.ts', import.meta.url), 'utf8');

describe('PAYROLL-02 accounting readiness contract', () => {
  it('adds tenant-scoped mappings with exact account identities and no default grants or data backfill', () => {
    expect(migration).toContain('UNIQUE (company_id, mapping_key)');
    expect(migration).toContain('FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id)');
    for (const key of ['earnings_expense','employer_contribution_expense','net_payroll_liability','employee_deduction_liability','employer_contribution_liability']) expect(migration).toContain(`'${key}'`);
    for (const cap of ['payroll.accounting.mapping.view','payroll.accounting.mapping.manage','payroll.accounting.preview']) expect(migration).toContain(`('${cap}', FALSE)`);
    expect(migration).not.toMatch(/INSERT INTO role_capabilities/i);
    expect(migration).not.toMatch(/INSERT INTO payroll_account_mappings/i);
    expect(service).toContain("account_type !== required.type");
    expect(service).toContain('!account.is_active');
  });

  it('requires explicit payroll/mapping permissions and exposes preview-only reads with no posting route', () => {
    expect(router).toContain("requireCapability('payroll.accounting.mapping.view')");
    expect(router).toContain("requireCapability('payroll.accounting.mapping.manage')");
    expect(router).toContain("requireCapability('payroll.accounting.preview')");
    expect(router).toContain("'/payroll/drafts/:id/accounting-preview'");
    expect(service).toContain('side_effects: false');
    expect(service).not.toContain('INSERT INTO journal_entries');
    expect(service).not.toContain('postJournalInTransaction');
  });

  it('uses decimal-safe arithmetic and identifies supported ECC overlaps and source-less journal ambiguity', () => {
    expect(service).toContain('BigInt');
    expect(service).toContain("r.status='approved'");
    expect(service).toContain('a.allocation_month=$2::date');
    expect(service).toContain('journal_entries WHERE company_id=$1 AND source_type IS NULL');
    expect(service).toContain("code: 'manual_journal_review'");
  });
});
