import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySensitivity } from '../src/modules/memberships/capability-sensitivity';
import { effectiveMode, fromCents, toCents } from '../src/modules/banking/bank-reconciliation-core';

const read = (path: string) => readFileSync(join(__dirname, path), 'utf8');
const sql = read('../migrations/088_bank_statement_reconciliation.sql');
const router = read('../src/modules/banking/bank-statement.router.ts');
const core = read('../src/modules/banking/bank-reconciliation-core.ts');
const monthly = read('../src/modules/monthly-close/monthly-close.router.ts');
const annual = read('../src/modules/annual-closing/annual-closing.service.ts');
const CAPABILITIES = ['bank.statement.manage', 'bank.statement.confirm', 'bank.reconciliation.settings'];

describe('T2 bank statement reconciliation contract', () => {
  it('registers three capabilities without granting them to any role and changes no existing table', () => {
    for (const c of CAPABILITIES) expect(sql).toContain(`('${c}')`);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+role_capabilities/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+(?!bank_)/i);
    const defaults = read('../src/modules/memberships/default-role-capabilities.ts');
    for (const c of CAPABILITIES) expect(defaults).not.toContain(c);
    expect(capabilitySensitivity('bank.reconciliation.settings')).toBe('critical');
    expect(capabilitySensitivity('bank.statement.confirm')).toBe('sensitive');
    expect(capabilitySensitivity('bank.statement.manage')).toBe('sensitive');
  });

  it('uses tenant-safe composite keys, immutability guards and append-only evidence', () => {
    for (const t of ['company_bank_reconciliation_settings', 'bank_account_ledger_links', 'bank_statement_balances', 'bank_reconciliation_snapshots']) expect(sql).toContain(`CREATE TABLE ${t}`);
    expect(sql).toContain('FOREIGN KEY (bank_account_id, company_id) REFERENCES bank_accounts(id, company_id)');
    expect(sql).toContain('FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id)');
    expect(sql).toContain('FOREIGN KEY (supersedes_id, company_id) REFERENCES bank_statement_balances(id, company_id)');
    expect(sql).toContain('bank_statement_balances_confirmed_uidx');
    expect(sql).toContain('Confirmed bank statement balance values are immutable');
    expect(sql).toContain('Bank reconciliation snapshots are append-only');
    expect(sql).toContain("daterange(NEW.valid_from, COALESCE(NEW.valid_to + 1, 'infinity'::date), '[)')");
    expect(sql).toContain("CHECK (mode <> 'enforce' OR enforce_from IS NOT NULL)");
  });

  it('binds every route to the intended capability and a same-origin check on writes', () => {
    expect(router).toContain("requireCapability('bank.statement.manage')");
    expect(router).toContain("requireCapability('bank.statement.confirm')");
    expect(router).toContain("requireCapability('bank.reconciliation.settings')");
    expect(router).toContain("requireCapability('bank.account.manage')");
    expect(router).toContain("const write = [requireSameOrigin, requireAuth, requireActiveCompany]");
    expect(router).not.toContain('company_id');
  });

  it('shares one calculation and one unresolved-transaction definition between monthly and annual closing', () => {
    expect(monthly).toContain('evaluateCompanyBankReconciliation');
    expect(annual).toContain('evaluateCompanyBankReconciliation');
    expect(monthly).toContain('UNRESOLVED_BANK_TRANSACTION_SQL');
    expect(annual).toContain('UNRESOLVED_BANK_TRANSACTION_SQL');
    expect(core).toContain('if (difference !== 0n) problems.push');
    expect(core).toContain('never assumed outstanding');
  });

  it('computes money in exact cents and resolves the rollout mode', () => {
    expect(fromCents(toCents('1234.5') + toCents('0.05'))).toBe('1234.55');
    expect(fromCents(toCents('-0.01'))).toBe('-0.01');
    expect(toCents('999.99') - toCents('1000.00')).toBe(-1n);
    expect(effectiveMode({ mode: 'off', enforce_from: null }, '2026-05-31')).toBe('off');
    expect(effectiveMode({ mode: 'warn', enforce_from: null }, '2026-05-31')).toBe('warn');
    expect(effectiveMode({ mode: 'enforce', enforce_from: '2026-06-01' }, '2026-05-31')).toBe('warn');
    expect(effectiveMode({ mode: 'enforce', enforce_from: '2026-06-01' }, '2026-06-30')).toBe('enforce');
  });
});
