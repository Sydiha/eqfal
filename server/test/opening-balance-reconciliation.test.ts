import { describe, expect, it } from 'vitest';
import {
  evaluateOpeningReconciliation, OB_CODES, type ReconciliationInput, type ReconciliationItem, type ReconciliationObligation,
} from '../src/modules/opening-balances/opening-balance-reconciliation';

// C4-P2a: pure classification rules. The database-backed behaviour is covered by opening-balance-reconciliation.http.postgres.test.ts.
const START = '2026-01-01';
let n = 0;
const item = (o: Partial<ReconciliationItem>): ReconciliationItem => ({
  id: `i${++n}`, category: 'bank', account_id: 'gl-bank', amount: '100.00', balance_side: 'debit',
  counterparty_id: null, bank_account_id: null, obligation_id: null, ...o,
});
const obl = (o: Partial<ReconciliationObligation>): ReconciliationObligation => ({
  id: `o${++n}`, direction: 'receivable', counterparty_id: 'cp1', original_amount: '100.00', source_type: 'opening_balance', is_cancelled: false, recognized_on: START, ...o,
});
function input(o: Partial<ReconciliationInput>): ReconciliationInput {
  return {
    startDate: START, functionalCurrency: 'SAR', items: [], bankAccounts: new Map(), bankLinks: new Map(), statements: new Map(),
    referencedObligations: new Map(), openingObligations: [], controlAccounts: new Map(), ...o,
  };
}
const codes = (r: ReturnType<typeof evaluateOpeningReconciliation>) => r.issues.map((i) => i.code).sort();
const bankSetup = (extra: Partial<ReconciliationInput> = {}) => ({
  bankAccounts: new Map([['b1', { currency_code: 'SAR' }]]), bankLinks: new Map([['b1', ['gl-bank']]]), ...extra,
});

describe('opening balance reconciliation: bank', () => {
  it('verifies an allocated bank balance equal to the confirmed statement, and ignores any running balance', () => {
    const r = evaluateOpeningReconciliation(input({ items: [item({ bank_account_id: 'b1' })], ...bankSetup({ statements: new Map([['b1', { closing_balance: '100.00', currency_code: 'SAR' }]]) }) }));
    expect(r.status).toBe('verified');
    expect(r.blocking).toBe(false);
  });
  it('reports a one-halala difference as a mismatch with exact amounts', () => {
    const r = evaluateOpeningReconciliation(input({ items: [item({ bank_account_id: 'b1', amount: '100.01' })], ...bankSetup({ statements: new Map([['b1', { closing_balance: '100.00', currency_code: 'SAR' }]]) }) }));
    expect(r.status).toBe('mismatch');
    expect(r.blocking).toBe(true);
    expect(r.issues[0]).toMatchObject({ code: OB_CODES.bankAmountMismatch, detail: { expected: '100.00', actual: '100.01', difference: '0.01' } });
  });
  it('treats a credit balance as negative when comparing', () => {
    const r = evaluateOpeningReconciliation(input({ items: [item({ bank_account_id: 'b1', balance_side: 'credit' })], ...bankSetup({ statements: new Map([['b1', { closing_balance: '-100.00', currency_code: 'SAR' }]]) }) }));
    expect(r.status).toBe('verified');
  });
  it('treats a missing confirmed statement as incomplete evidence, not a mismatch', () => {
    const r = evaluateOpeningReconciliation(input({ items: [item({ bank_account_id: 'b1' })], ...bankSetup() }));
    expect(codes(r)).toEqual([OB_CODES.bankEvidenceMissing]);
    expect(r.status).toBe('incomplete_evidence');
    expect(r.blocking).toBe(false);
  });
  it('classifies an aggregate-only bank item (no bank account) as incomplete evidence', () => {
    const r = evaluateOpeningReconciliation(input({ items: [item({})] }));
    expect(codes(r)).toEqual([OB_CODES.bankAggregateOnly]);
    expect(r.blocking).toBe(false);
  });
  it('blocks an unknown bank account, a missing ledger link, a different GL account and a duplicate reference', () => {
    expect(codes(evaluateOpeningReconciliation(input({ items: [item({ bank_account_id: 'zz' })] })))).toEqual([OB_CODES.referenceInvalid]);
    expect(codes(evaluateOpeningReconciliation(input({ items: [item({ bank_account_id: 'b1' })], bankAccounts: new Map([['b1', { currency_code: 'SAR' }]]) })))).toContain(OB_CODES.bankLedgerLinkMissing);
    expect(codes(evaluateOpeningReconciliation(input({ items: [item({ bank_account_id: 'b1', account_id: 'other' })], ...bankSetup() })))).toContain(OB_CODES.bankGlMismatch);
    const dup = evaluateOpeningReconciliation(input({ items: [item({ bank_account_id: 'b1' }), item({ bank_account_id: 'b1' })], ...bankSetup() }));
    expect(codes(dup).filter((c) => c === OB_CODES.bankDuplicate)).toHaveLength(2);
    expect(dup.status).toBe('blocked');
  });
  it('does not compare a bank account in another currency, or when the functional currency is unknown', () => {
    const stmt = new Map([['b1', { closing_balance: '999.00', currency_code: 'USD' }]]);
    const usd = evaluateOpeningReconciliation(input({ items: [item({ bank_account_id: 'b1' })], bankAccounts: new Map([['b1', { currency_code: 'USD' }]]), bankLinks: new Map([['b1', ['gl-bank']]]), statements: stmt }));
    expect(codes(usd)).toEqual([OB_CODES.bankCurrencyNotComparable]);
    expect(usd.blocking).toBe(false);
    const unknown = evaluateOpeningReconciliation(input({ functionalCurrency: null, items: [item({ bank_account_id: 'b1' })], ...bankSetup({ statements: stmt }) }));
    expect(codes(unknown)).toEqual([OB_CODES.functionalCurrencyUnknown]);
    const stmtCurrency = evaluateOpeningReconciliation(input({ items: [item({ bank_account_id: 'b1' })], ...bankSetup({ statements: stmt }) }));
    expect(codes(stmtCurrency)).toEqual([OB_CODES.bankCurrencyNotComparable]);
  });
});

describe('opening balance reconciliation: receivable and payable', () => {
  const control = new Map<'receivable' | 'payable', Set<string>>([['receivable', new Set(['ar', 'ar-child'])], ['payable', new Set(['ap'])]]);
  const linked = (o: ReconciliationObligation, extra: Partial<ReconciliationItem> = {}) =>
    item({ category: o.direction, account_id: o.direction === 'receivable' ? 'ar' : 'ap', amount: o.original_amount, balance_side: o.direction === 'receivable' ? 'debit' : 'credit', obligation_id: o.id, counterparty_id: o.counterparty_id, ...extra });

  it('verifies several obligations of one counterparty, each on its own item', () => {
    const a = obl({ original_amount: '100.00' }), b = obl({ original_amount: '250.50' }), c = obl({ direction: 'payable', original_amount: '40.00' });
    const r = evaluateOpeningReconciliation(input({ items: [linked(a), linked(b, { account_id: 'ar-child' }), linked(c)], referencedObligations: new Map([a, b, c].map((x) => [x.id, x])), openingObligations: [a, b, c], controlAccounts: control }));
    expect(r.status).toBe('verified');
    expect(r.sections.receivable).toMatchObject({ gl_total: '350.50', subledger_total: '350.50', item_count: 2 });
  });
  it('blocks the same obligation on two items', () => {
    const a = obl({});
    const r = evaluateOpeningReconciliation(input({ items: [linked(a), linked(a)], referencedObligations: new Map([[a.id, a]]), openingObligations: [a], controlAccounts: control }));
    expect(codes(r)).toContain(OB_CODES.obligationDuplicate);
    expect(r.status).toBe('blocked');
  });
  it('blocks an unknown, cancelled, non-opening or wrong-direction obligation and a different counterparty', () => {
    const cancelled = obl({ is_cancelled: true }), doc = obl({ source_type: 'document' }), wrongDay = obl({ recognized_on: '2026-01-02' }), pay = obl({ direction: 'payable' }), a = obl({});
    const base = { controlAccounts: control, referencedObligations: new Map([cancelled, doc, wrongDay, pay, a].map((x) => [x.id, x])) };
    expect(codes(evaluateOpeningReconciliation(input({ ...base, items: [item({ category: 'receivable', account_id: 'ar', obligation_id: 'nope' })] })))).toContain(OB_CODES.obligationInvalid);
    expect(codes(evaluateOpeningReconciliation(input({ ...base, items: [linked(cancelled, { category: 'receivable' })] })))).toContain(OB_CODES.obligationInvalid);
    expect(codes(evaluateOpeningReconciliation(input({ ...base, items: [linked(doc)] })))).toContain(OB_CODES.obligationNotOpening);
    expect(codes(evaluateOpeningReconciliation(input({ ...base, items: [linked(wrongDay)] })))).toContain(OB_CODES.obligationNotOpening);
    expect(codes(evaluateOpeningReconciliation(input({ ...base, items: [linked(pay, { category: 'receivable', account_id: 'ar', balance_side: 'debit' })] })))).toContain(OB_CODES.obligationDirectionMismatch);
    expect(codes(evaluateOpeningReconciliation(input({ ...base, items: [linked(a, { counterparty_id: 'someone-else' })] })))).toContain(OB_CODES.counterpartyMismatch);
  });
  it('reports a one-halala amount difference and a wrong side as mismatches', () => {
    const a = obl({ original_amount: '100.00' });
    const base = { referencedObligations: new Map([[a.id, a]]), openingObligations: [a], controlAccounts: control };
    const off = evaluateOpeningReconciliation(input({ ...base, items: [linked(a, { amount: '99.99' })] }));
    expect(off.status).toBe('mismatch');
    expect(off.issues.find((i) => i.code === OB_CODES.obligationAmountMismatch)?.detail).toMatchObject({ expected: '100.00', actual: '99.99', difference: '-0.01' });
    expect(codes(evaluateOpeningReconciliation(input({ ...base, items: [linked(a, { balance_side: 'credit' })] })))).toContain(OB_CODES.obligationSideMismatch);
  });
  it('blocks a GL account outside the mapped control account, and reports an unmapped control account as incomplete evidence', () => {
    const a = obl({});
    const base = { referencedObligations: new Map([[a.id, a]]), openingObligations: [a] };
    expect(codes(evaluateOpeningReconciliation(input({ ...base, controlAccounts: control, items: [linked(a, { account_id: 'elsewhere' })] })))).toContain(OB_CODES.controlAccountMismatch);
    const unmapped = evaluateOpeningReconciliation(input({ ...base, items: [linked(a)] }));
    expect(codes(unmapped)).toEqual([OB_CODES.controlAccountUnmapped]);
    expect(unmapped.blocking).toBe(false);
  });
  it('reports an obligation left out of fully allocated items as a total mismatch', () => {
    const a = obl({ original_amount: '100.00' }), b = obl({ original_amount: '30.00' });
    const r = evaluateOpeningReconciliation(input({ items: [linked(a)], referencedObligations: new Map([[a.id, a]]), openingObligations: [a, b], controlAccounts: control }));
    expect(r.status).toBe('mismatch');
    expect(codes(r)).toEqual([OB_CODES.subledgerTotalMismatch, OB_CODES.subledgerUnlinkedObligation].sort());
    expect(r.issues.find((i) => i.code === OB_CODES.subledgerTotalMismatch)?.detail).toMatchObject({ gl_total: '100.00', subledger_total: '130.00', difference: '-30.00' });
  });
  it('keeps aggregate-only trial balance items supported as incomplete evidence, even when the subledger total differs', () => {
    const b = obl({ original_amount: '30.00' });
    const r = evaluateOpeningReconciliation(input({ items: [item({ category: 'receivable', account_id: 'ar', amount: '500.00' }), item({ category: 'payable', account_id: 'ap', amount: '10.00', balance_side: 'credit' })], openingObligations: [b], controlAccounts: control }));
    expect(r.status).toBe('incomplete_evidence');
    expect(r.blocking).toBe(false);
    expect(r.issues.some((i) => i.code === OB_CODES.subledgerAggregateOnly && i.detail?.['difference'] === '470.00')).toBe(true);
  });
  it('is verified when the review has no bank, receivable or payable items and no opening obligations exist', () => {
    expect(evaluateOpeningReconciliation(input({ items: [item({ category: 'equity', account_id: 'eq', balance_side: 'credit' })] })).status).toBe('verified');
  });
});
