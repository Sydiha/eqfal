import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySensitivity } from '../src/modules/memberships/capability-sensitivity';
import { isPersonalPaymentSourceType, PERSONAL_PAYMENT_SOURCE_TYPES } from '../src/modules/accounting/personal-payment-posting';
import { operationalSourceQuery, OPERATIONAL_SOURCE_TYPES } from '../src/modules/accounting/operational-sources';

const sql = readFileSync(join(__dirname, '../migrations/089_personal_payments.sql'), 'utf8');
const router = readFileSync(join(__dirname, '../src/modules/personal-payments/personal-payment.router.ts'), 'utf8');
const CAPABILITIES = ['personal_payment.view', 'personal_payment.create', 'personal_payment.submit', 'personal_payment.review', 'personal_payment.reimburse', 'personal_payment.audit.view', 'personal_payment.payer.manage'];

describe('personal payments: accounting contract', () => {
  it('knows exactly the two journal source types and never offers them for manual journals', () => {
    expect(PERSONAL_PAYMENT_SOURCE_TYPES).toEqual(['personal_payment', 'personal_payment_reimbursement']);
    expect(isPersonalPaymentSourceType('personal_payment')).toBe(true);
    expect(isPersonalPaymentSourceType('partner_transaction')).toBe(false);
    for (const t of PERSONAL_PAYMENT_SOURCE_TYPES) expect(OPERATIONAL_SOURCE_TYPES as readonly string[]).not.toContain(t);
  });

  it('only posts approved-for-review payments and reimbursements that are not yet journaled', () => {
    expect(operationalSourceQuery('personal_payment')).toContain("status IN ('submitted','approved')");
    expect(operationalSourceQuery('personal_payment_reimbursement')).toContain('personal_payment_reimbursements');
  });
});

describe('personal payments: migration 089 and capabilities', () => {
  it('registers capabilities without granting them to any role', () => {
    for (const c of CAPABILITIES) expect(sql).toContain(`('${c}')`);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+role_capabilities/i);
  });

  it('classifies approval and reimbursement as critical and creation/submission as sensitive', () => {
    expect(capabilitySensitivity('personal_payment.review')).toBe('critical');
    expect(capabilitySensitivity('personal_payment.reimburse')).toBe('critical');
    expect(capabilitySensitivity('personal_payment.create')).toBe('sensitive');
    expect(capabilitySensitivity('personal_payment.submit')).toBe('sensitive');
  });

  it('keeps partner payers off any parallel payable and protects history', () => {
    expect(sql).toMatch(/one_account_path/);
    expect(sql).toMatch(/append-only/);
    expect(sql).toContain('personal_payments_document_uidx');
    expect(sql).toMatch(/UNIQUE[^;]*bank_transaction_id/i);
    expect(sql).toContain('obligation_adjustment_net');
  });

  it('protects every route with an explicit capability and same-origin checks on writes', () => {
    for (const c of CAPABILITIES) expect(router).toContain(`'${c}'`);
    expect(router).toMatch(/const write = \[requireSameOrigin/);
    const handlers = router.match(/personalPaymentRouter\.(get|post|patch|delete|put)\(/g) ?? [];
    expect(handlers.length).toBe(17);
    const writes = router.match(/personalPaymentRouter\.(post|patch|delete|put)\([^\n]*/g) ?? [];
    for (const w of writes) expect(w).toContain('...write');
  });
});
