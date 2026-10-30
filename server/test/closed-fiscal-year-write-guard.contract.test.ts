import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Static evidence: every dated financial write module routes through the centralized guards, which now also reject closed fiscal years.
const guarded = [
  'documents/document.service.ts', 'banking/bank.router.ts', 'banking/bank-statement.service.ts', 'banking/document-settlement.router.ts',
  'banking/bank-reconciliation.router.ts', 'banking/custody.router.ts', 'obligations/obligation.router.ts', 'fixed-assets/fixed-assets.router.ts',
  'fixed-assets/asset-estimate-change.router.ts', 'record-deletion/record-deletion.service.ts', 'opening-balances/opening-balances.router.ts',
  'periodic-adjustments/periodic-adjustments.router.ts', 'vat/vat.router.ts', 'vat/vat-adjustments.router.ts', 'partners/partner-transaction.service.ts',
  'personal-payments/personal-payment.service.ts', 'invoices/invoice-approval.service.ts', 'invoices/invoice-adjustment.service.ts',
  'accounting/accounting.router.ts', 'accounting/journal-posting.ts',
];

describe('closed fiscal year write guard coverage', () => {
  it.each(guarded)('%s uses the centralized accounting-date guard', (file) => {
    const source = readFileSync(new URL(`../src/modules/${file}`, import.meta.url), 'utf8');
    expect(source).toMatch(/assertAccounting(Date|Range)Writable/);
  });

  it('the guard checks the closed fiscal year before taking the month locks', () => {
    const source = readFileSync(new URL('../src/modules/monthly-close/accounting-period.guard.ts', import.meta.url), 'utf8');
    expect(source.indexOf('await assertFiscalYearsOpen(companyId, normalizedDate')).toBeLessThan(source.indexOf('await lockAccountingDate('));
    expect(source.indexOf('await assertFiscalYearsOpen(companyId, normalizedStart')).toBeLessThan(source.indexOf('await lockAccountingRange(companyId, normalizedStart'));
  });
});
