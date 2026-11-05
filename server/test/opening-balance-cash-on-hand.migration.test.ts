import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/107_cash_on_hand_opening_balance.sql', import.meta.url), 'utf8');
const router = readFileSync(new URL('../src/modules/opening-balances/opening-balances.router.ts', import.meta.url), 'utf8');
const reconciliation = readFileSync(new URL('../src/modules/opening-balances/opening-balance-reconciliation.ts', import.meta.url), 'utf8');
const exceptions = readFileSync(new URL('../src/modules/opening-balances/opening-balance-exceptions.ts', import.meta.url), 'utf8');
const carryforward = readFileSync(new URL('../src/modules/fiscal-years/fiscal-year-carryforward.ts', import.meta.url), 'utf8');

describe('cash-on-hand opening balance contract', () => {
  it('adds the new category with a forward-only constraint migration and retains all existing categories', () => {
    expect(migration).toContain("DROP CONSTRAINT opening_balance_items_category_check");
    expect(migration).toContain("'cash_on_hand'");
    for (const category of ['bank', 'receivable', 'payable', 'partner_capital', 'partner_current', 'partner_loan', 'custody_advance', 'vat_tax', 'inventory', 'fixed_asset_cost', 'accumulated_depreciation', 'other_asset', 'other_liability', 'equity']) expect(migration).toContain(`'${category}'`);
    expect(router).toContain("'cash_on_hand'");
  });

  it('validates cash account class at entry and approval, defines physical-count evidence, and keeps bank checks separate', () => {
    expect(router).toContain("input.category==='cash_on_hand'");
    expect(router).toContain("a.account_type!=='asset'||a.cash_role!=='cash'");
    expect(reconciliation).toContain('physicalCashEvidenceMissing');
    expect(reconciliation).toContain('physicalCashEvidenceUserDeclared');
    expect(reconciliation).toContain("i.category === 'bank'");
    expect(reconciliation).toContain("i.category === 'cash_on_hand'");
    expect(exceptions).toContain("'OB_PHYSICAL_CASH_EVIDENCE_MISSING'");
  });

  it('carries cash-classified ledger balances once under the cash-on-hand category', () => {
    expect(carryforward).toContain("row.account_type === 'asset' && row.cash_role === 'cash' ? (row.bank_linked ? 'bank' : 'cash_on_hand')");
    expect(carryforward).toContain('EXISTS(SELECT 1 FROM bank_account_ledger_links bl WHERE bl.company_id=a.company_id AND bl.account_id=a.id) bank_linked');
    expect(carryforward).toContain('OPENING_BALANCE_ALREADY_EXISTS');
  });
});
