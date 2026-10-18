import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySensitivity } from '../src/modules/memberships/capability-sensitivity';
import { inflow, isPartnerMappingKey, isPartnerTransactionType, journalSides, mappingKeyFor, PARTNER_MAPPING_ACCOUNT_TYPES, PARTNER_TRANSACTION_TYPES } from '../src/modules/accounting/partner-transaction-posting';
import { operationalSourceQuery, OPERATIONAL_SOURCE_TYPES } from '../src/modules/accounting/operational-sources';

const sql = readFileSync(join(__dirname, '../migrations/087_partner_transactions.sql'), 'utf8');
const router = readFileSync(join(__dirname, '../src/modules/partners/partner-transaction.router.ts'), 'utf8');
const NEW_CAPABILITIES = ['partner.transaction.view', 'partner.transaction.create', 'partner.transaction.post', 'partner.transaction.reverse', 'partner.account_mapping.manage'];

describe('partner transactions: accounting contract', () => {
  it('maps every type to exactly one partner-side class and the policy direction', () => {
    expect(PARTNER_TRANSACTION_TYPES).toEqual(['capital_contribution', 'current_deposit', 'current_withdrawal', 'loan_received', 'loan_repayment']);
    expect(PARTNER_TRANSACTION_TYPES.map(mappingKeyFor)).toEqual(['capital', 'current', 'current', 'loan', 'loan']);
    // Owner policy: an ordinary withdrawal debits the individual CURRENT account, never capital and never a distribution.
    expect(mappingKeyFor('current_withdrawal')).toBe('current');
    expect(isPartnerTransactionType('distribution')).toBe(false);
    expect(isPartnerTransactionType('capital_reduction')).toBe(false);
    expect(isPartnerMappingKey('distribution')).toBe(false);
  });

  it('produces balanced two-sided journals with the partner account on the correct side', () => {
    expect(journalSides('capital_contribution', 'P', 'C')).toEqual({ debit: 'C', credit: 'P' });
    expect(journalSides('current_deposit', 'P', 'C')).toEqual({ debit: 'C', credit: 'P' });
    expect(journalSides('loan_received', 'P', 'C')).toEqual({ debit: 'C', credit: 'P' });
    expect(journalSides('current_withdrawal', 'P', 'C')).toEqual({ debit: 'P', credit: 'C' });
    expect(journalSides('loan_repayment', 'P', 'C')).toEqual({ debit: 'P', credit: 'C' });
    expect(PARTNER_TRANSACTION_TYPES.filter(inflow)).toEqual(['capital_contribution', 'current_deposit', 'loan_received']);
  });

  it('keeps capital, current accounts and loans separately classified', () => {
    expect(PARTNER_MAPPING_ACCOUNT_TYPES.capital).toEqual(['equity']);
    expect(PARTNER_MAPPING_ACCOUNT_TYPES.loan).toEqual(['liability']);
    expect(PARTNER_MAPPING_ACCOUNT_TYPES.current).toEqual(['equity', 'liability']);
    expect(PARTNER_MAPPING_ACCOUNT_TYPES.cash).toEqual(['asset']);
  });

  it('is a journal-posting source only (never offered for manual journal creation) and reads the validated mappings', () => {
    expect(OPERATIONAL_SOURCE_TYPES as readonly string[]).not.toContain('partner_transaction');
    expect(OPERATIONAL_SOURCE_TYPES as readonly string[]).not.toContain('partner_transaction_reversal');
    const q = operationalSourceQuery('partner_transaction');
    expect(q).toContain("p.status='draft'");
    expect(q).toContain('partner_account_mappings');
    expect(q).toContain('partner_cash_account_mappings');
    expect(operationalSourceQuery('partner_transaction_reversal')).toContain("p.status='reversed'");
  });
});

describe('partner transactions: migration 087 and capabilities', () => {
  it('is additive: new tables, triggers and capabilities only', () => {
    expect(sql).not.toMatch(/^\s*DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)/im);
    expect(sql).not.toMatch(/^\s*ALTER\s+TABLE\b/im);
    expect(sql).not.toMatch(/^\s*(DELETE|UPDATE|TRUNCATE)\b/im);
    for (const t of ['partner_account_mappings', 'partner_cash_account_mappings', 'partner_transactions']) expect(sql).toContain(`CREATE TABLE ${t}`);
  });

  it('registers the capabilities without granting them to any role', () => {
    for (const c of NEW_CAPABILITIES) expect(sql).toContain(`('${c}')`);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+role_capabilities/i);
    const defaults = readFileSync(join(__dirname, '../src/modules/memberships/default-role-capabilities.ts'), 'utf8');
    for (const c of NEW_CAPABILITIES) expect(defaults).not.toContain(c);
  });

  it('classifies posting and reversal as critical and creation as sensitive', () => {
    expect(capabilitySensitivity('partner.transaction.post')).toBe('critical');
    expect(capabilitySensitivity('partner.transaction.reverse')).toBe('critical');
    expect(capabilitySensitivity('partner.transaction.create')).toBe('sensitive');
    expect(capabilitySensitivity('partner.account_mapping.manage')).toBe('sensitive');
    expect(capabilitySensitivity('partner.transaction.view')).toBe('normal');
  });

  it('guards the database: one live link per bank row, immutable posted rows, cross-table exclusivity', () => {
    expect(sql).toContain('partner_tx_bank_transaction_uidx');
    expect(sql).toContain('partner_transaction_guard');
    expect(sql).toContain('partner_transaction_bank_exclusivity');
    expect(sql).toContain('partner_bank_transaction_claim_guard');
    expect(sql).toMatch(/partner_tx_journal_uidx/);
    expect(sql).toMatch(/partner_tx_reversal_journal_uidx/);
  });

  it('wires every write route behind a specific capability and the same-origin check', () => {
    const writes = router.match(/partnerTransactionRouter\.(post|patch|put|delete)\(/g) ?? [];
    expect(writes.length).toBe(9);
    expect((router.match(/\.\.\.write/g) ?? []).length).toBe(writes.length);
    expect(router).toContain("requireCapability('partner.transaction.post')");
    expect(router).toContain("requireCapability('partner.transaction.reverse')");
    expect(router).toContain("requireCapability('partner.transaction.create')");
    expect(router).toContain("requireCapability('partner.account_mapping.manage')");
    expect((router.match(/\.\.\.read/g) ?? []).length).toBe(5);
  });
});
