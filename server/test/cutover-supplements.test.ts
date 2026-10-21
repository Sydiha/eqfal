import { describe, expect, it } from 'vitest';
import { cents, evaluateSupplement, ledgerFingerprint, money, parseSupplementInput, SupplementLine, type EvaluationContext } from '../src/modules/accounting/cutover-supplements';
import { buildCutoverDisclosure, preCutover } from '../src/modules/accounting/cutover-disclosure';

const acc = (id: string, cash_role: string, cash_flow_category: string, statement_category: string) => ({ id, cash_role, cash_flow_category, statement_category });
const accounts = new Map([acc('bank', 'cash', 'unmapped', 'current_asset'), acc('usd', 'cash', 'unmapped', 'current_asset'), acc('cap', 'non_cash', 'financing', 'equity'), acc('re', 'non_cash', 'financing', 'equity')].map((a) => [a.id, a]));
const ctx = (over: Partial<EvaluationContext> = {}): EvaluationContext => ({
  journal: [
    { account_id: 'bank', debit: '200.00', credit: '0.00', cash_role: 'cash', cash_flow_category: 'unmapped', statement_category: 'current_asset' },
    { account_id: 'usd', debit: '70.00', credit: '0.00', cash_role: 'cash', cash_flow_category: 'unmapped', statement_category: 'current_asset' },
    { account_id: 'cap', debit: '0.00', credit: '270.00', cash_role: 'non_cash', cash_flow_category: 'financing', statement_category: 'equity' },
  ],
  accounts, functional_currency: 'SAR', foreign_cash_account_ids: [], retained_earnings_account_id: 're', ...over,
});
const line = (x: Partial<SupplementLine>): SupplementLine => ({ line_type: 'cash_flow', account_id: null, section: null, movement_type: null, label: null, amount: null, opening_amount: null, closing_amount: null, classification_override_reason: null, ...x });
const version = { functional_currency: 'SAR', fx_translation_evidence: null as string | null };
const cash = [
  line({ line_type: 'cash_balance', account_id: 'bank', opening_amount: '10.00', closing_amount: '200.00' }),
  line({ line_type: 'cash_balance', account_id: 'usd', opening_amount: '0.00', closing_amount: '70.00' }),
  line({ section: 'operating', label: 'ops', amount: '255.00' }),
  line({ section: 'fx_effect', label: 'fx', amount: '5.00' }),
];

describe('S2 supplement invariants (pure, exact halalas)', () => {
  it('converts money exactly, never through floating point', () => {
    expect([cents('0.1') + cents('0.2'), money(cents('-0.07')), money(cents('12345678901234.99') + 1n)]).toEqual([30n, '-0.07', '12345678901235.00']);
  });
  it('C5: fx_effect only with a foreign-currency linked cash account and written evidence', () => {
    expect(evaluateSupplement('cash_flow', version, cash, ctx()).issues.map((i) => i.code)).toEqual(['SUPPLEMENT_FX_EFFECT_NOT_ALLOWED']);
    expect(evaluateSupplement('cash_flow', version, cash, ctx({ foreign_cash_account_ids: ['usd'] })).issues.map((i) => i.code)).toEqual(['SUPPLEMENT_FX_EVIDENCE_REQUIRED']);
    const ok = evaluateSupplement('cash_flow', { ...version, fx_translation_evidence: 'SAMA rates' }, cash, ctx({ foreign_cash_account_ids: ['usd'] }));
    expect([ok.valid, ok.totals]).toEqual([true, { opening: '10.00', operating: '255.00', investing: '0.00', financing: '0.00', fx_effect: '5.00', net_change: '260.00', closing: '270.00' }]);
    expect(evaluateSupplement('cash_flow', { ...version, functional_currency: 'USD' }, cash, ctx({ foreign_cash_account_ids: ['usd'] })).issues.map((i) => i.code)).toContain('SUPPLEMENT_CURRENCY_MISMATCH');
  });
  it('a one-halala difference fails the roll-forward (no tolerance)', () => {
    const off = cash.map((l) => (l.section === 'operating' ? { ...l, amount: '254.99' } : l));
    expect(evaluateSupplement('cash_flow', { ...version, fx_translation_evidence: 'x' }, off, ctx({ foreign_cash_account_ids: ['usd'] })).issues).toEqual([
      { code: 'SUPPLEMENT_CASH_ROLLFORWARD_MISMATCH', detail: { opening: '10.00', net_change: '259.99', closing: '270.00', difference: '-0.01' } },
    ]);
  });
  it('C1: duplicate or extra cash accounts are refused', () => {
    const dup = [...cash, line({ line_type: 'cash_balance', account_id: 'bank', opening_amount: '0.00', closing_amount: '0.00' })];
    expect(evaluateSupplement('cash_flow', version, dup, ctx()).issues.map((i) => i.code)).toContain('SUPPLEMENT_DUPLICATE_ACCOUNT');
    const extra = evaluateSupplement('cash_flow', version, cash, ctx({ journal: ctx().journal.filter((l) => l.account_id !== 'usd') }));
    expect(extra.issues.map((i) => i.code)).toContain('SUPPLEMENT_CASH_ACCOUNT_EXTRA');
  });
  it('E1: an equity account absent from the journal is accepted only when it rolls to zero', () => {
    const lines = [line({ line_type: 'equity_opening', account_id: 'cap', opening_amount: '270.00' }), line({ line_type: 'equity_opening', account_id: 're', opening_amount: '0.00' })];
    expect(evaluateSupplement('equity', version, lines, ctx()).valid).toBe(true);
    const bad = [lines[0]!, line({ line_type: 'equity_opening', account_id: 're', opening_amount: '5.00' })];
    expect(evaluateSupplement('equity', version, bad, ctx()).issues.map((i) => i.code)).toEqual(['SUPPLEMENT_RETAINED_EARNINGS_MISMATCH', 'SUPPLEMENT_EQUITY_ACCOUNT_EXTRA']);
  });
  it('the ledger fingerprint changes with any cut-over line and ignores line order', () => {
    const j = ctx().journal;
    expect(ledgerFingerprint('j', j)).toBe(ledgerFingerprint('j', [...j].reverse()));
    expect(ledgerFingerprint('j', j)).not.toBe(ledgerFingerprint('j', j.map((l, i) => (i === 0 ? { ...l, debit: '200.01' } : l))));
    expect(ledgerFingerprint('j', j)).not.toBe(ledgerFingerprint('k', j));
  });
  it('parser rejects lines of the other kind and malformed amounts', () => {
    const b = { source_system: 'x', evidence_reference: 'y', lines: [{ line_type: 'equity_opening', account_id: '00000000-0000-4000-8000-000000000000', opening_amount: '1.00' }] };
    expect(parseSupplementInput('cash_flow', b)).toBeNull();
    expect(parseSupplementInput('equity', b)?.lines[0]!.opening_amount).toBe('1.00');
    expect(parseSupplementInput('equity', { ...b, lines: [{ ...b.lines[0], opening_amount: '1e3' }] })).toBeNull();
    expect(parseSupplementInput('equity', { ...b, extra: 1 })).toBeNull();
  });
});

describe('S2 disclosure completeness', () => {
  const row = { fy_start: '2026-01-01', from_date: '2026-01-01', to_date: '2026-06-30', cutover_journal_id: 'j', tb_reference: 'TB', tb_prepared_by: 'A', acknowledgements: { pre_closing_trial_balance: true }, activation_snapshot: { tb_source_system: 'ERP' } };
  const status = (state: 'complete' | 'missing' | 'invalid', reasons: string[] = []) => ({ kind: 'cash_flow' as const, state, version_id: null, version_no: state === 'missing' ? null : 3, revision_pending: false, reasons, issues: [], totals: null, lines: [] });
  it('cash flow / equity are full-year only with a complete supplement; an invalid one stays visible', () => {
    const d = buildCutoverDisclosure(row, { cash_flow: status('complete'), equity: status('invalid', ['SUPPLEMENT_LEDGER_FINGERPRINT_CHANGED']) });
    expect([d.completeness.cash_flow.full_year_complete, d.completeness.cash_flow.status]).toEqual([true, 'reconciled']);
    expect([d.completeness.changes_in_equity.full_year_complete, d.completeness.changes_in_equity.reasons]).toEqual([false, ['SUPPLEMENT_LEDGER_FINGERPRINT_CHANGED']]);
    expect(preCutover(d, 'cash_flow', false)).toMatchObject({ pre_cutover: { completeness: { full_year_complete: false, reasons: ['REPORT_RANGE_NOT_FULL_YEAR'] } } });
  });
  it('missing trial-balance evidence keeps every statement unverified, even with complete supplements', () => {
    const d = buildCutoverDisclosure({ ...row, acknowledgements: {} }, { cash_flow: status('complete'), equity: status('complete') });
    for (const c of Object.values(d.completeness)) expect([c.full_year_complete, c.reasons]).toEqual([false, expect.arrayContaining(['TB_BASIS_NOT_RECORDED'])]);
  });
});
