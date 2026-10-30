import { describe, expect, it } from 'vitest';
import { evaluateReadiness, REQUIRED_BLOCKING_GATES, fingerprintOf, toBps4, toCents, unsupportedPeriodReason, verifyOwnership, ZAKAT_TYPES, type GateRow, type OwnershipInputs } from '../src/modules/zakat-worksheets/zakat-worksheet.rules';

// G6-1 pure rules. No test here asserts a Zakat amount: the calculation is not implemented and its regulatory gates are unverified.
const profile = { id: 'p', ownership_context: 'saudi_gcc_only', tax_treatment: 'zakat_applicable' };
const base = (over: Partial<OwnershipInputs> = {}): OwnershipInputs => ({
  asOf: '2025-12-31', profile, partners: [{ id: 'a', name: 'A', is_active: true }],
  periods: [{ partner_id: 'a', pct: '100.0000', effective_from: '2025-01-01', effective_to: null, verification_status: 'confirmed' }],
  eligibility: [{ id: 'e', partner_id: 'a', ownership_class: 'saudi_natural', effective_from: '2025-01-01', effective_to: null, evidence_document_id: 'd', verification_status: 'confirmed', confirmed_by_user_id: 'u', confirmed_at: 'now' }],
  ...over,
});

describe('fiscal period scope', () => {
  it('accepts only calendar 12-month years starting in 2024 or later', () => {
    expect(unsupportedPeriodReason('2024-01-01', '2024-12-31')).toBeNull();
    expect(unsupportedPeriodReason('2025-04-01', '2026-03-31')).toBeNull();
    expect(unsupportedPeriodReason('2023-07-01', '2024-06-30')).toBe('fiscal_year_starts_before_2024');
    expect(unsupportedPeriodReason('2025-01-01', '2025-06-30')).toBe('fiscal_year_not_12_months');
    expect(unsupportedPeriodReason('2025-01-01', '2026-12-31')).toBe('fiscal_year_not_12_months');
  });
});

describe('exact numeric parsing', () => {
  it('uses integer units, never floats', () => {
    expect(toCents('1234.50')).toBe(123450n); expect(toCents('-0.05')).toBe(-5n); expect(toCents('7')).toBe(700n);
    expect(toBps4('100')).toBe(1_000_000n); expect(toBps4('33.3333')).toBe(333_333n); expect(toBps4('33.33334')).toBe(333_333n);
  });
});

describe('ownership verification (never inferred)', () => {
  it('qualifies only with confirmed 100% ownership, confirmed qualifying eligibility and a Saudi/GCC profile', () => {
    expect(verifyOwnership(base())).toMatchObject({ qualified: true, blockers: [], total_ownership_bps4: '1000000' });
  });
  it.each([
    ['no approved profile', { profile: null }, 'zakat_path_not_approved'],
    ['profile says includes non-Saudi', { profile: { ...profile, ownership_context: 'includes_non_saudi' } }, 'profile_ownership_context_not_saudi_gcc'],
    ['income-tax profile', { profile: { ...profile, tax_treatment: 'income_tax_applicable' } }, 'zakat_path_not_approved'],
    ['no ownership rows', { periods: [] }, 'no_confirmed_ownership'],
    ['99.9999%', { periods: [{ partner_id: 'a', pct: '99.9999', effective_from: '2025-01-01', effective_to: null, verification_status: 'confirmed' }] }, 'ownership_total_not_100'],
    ['undated unconfirmed period', { periods: [...base().periods, { partner_id: 'a', pct: null, effective_from: null, effective_to: null, verification_status: 'unconfirmed' }] }, 'unconfirmed_ownership_period'],
    ['ownership ended before year end', { periods: [{ partner_id: 'a', pct: '100', effective_from: '2025-01-01', effective_to: '2025-11-30', verification_status: 'confirmed' }] }, 'no_confirmed_ownership'],
    ['active partner without ownership', { partners: [...base().partners, { id: 'b', name: 'B', is_active: true }] }, 'partner_without_ownership_at_year_end'],
    ['no eligibility row', { eligibility: [] }, 'partner_eligibility_missing'],
    ['unconfirmed eligibility', { eligibility: [{ ...base().eligibility[0]!, verification_status: 'unconfirmed' }] }, 'partner_eligibility_unconfirmed'],
    ['eligibility not covering year end', { eligibility: [{ ...base().eligibility[0]!, effective_to: '2025-06-30' }] }, 'partner_eligibility_missing'],
    ['non-qualifying class', { eligibility: [{ ...base().eligibility[0]!, ownership_class: 'other' }] }, 'partner_class_not_qualifying'],
    ['unknown class', { eligibility: [{ ...base().eligibility[0]!, ownership_class: 'unknown' }] }, 'partner_class_not_qualifying'],
  ] as const)('%s blocks', (_n, over, code) => {
    const v = verifyOwnership(base(over as Partial<OwnershipInputs>));
    expect(v.qualified).toBe(false); expect(v.blockers).toContain(code);
  });
  it('splits ownership across partners and the fingerprint is stable and sensitive', () => {
    const two = base({ partners: [{ id: 'a', name: 'A', is_active: true }, { id: 'b', name: 'B', is_active: true }],
      periods: ['a', 'b'].map((p) => ({ partner_id: p, pct: '50', effective_from: '2025-01-01', effective_to: null, verification_status: 'confirmed' })),
      eligibility: ['a', 'b'].map((p) => ({ ...base().eligibility[0]!, id: `e-${p}`, partner_id: p, ownership_class: p === 'a' ? 'saudi_natural' : 'gcc_natural' })) });
    const v = verifyOwnership(two);
    expect(v.qualified).toBe(true);
    expect(fingerprintOf(v)).toBe(fingerprintOf(verifyOwnership(two)));
    expect(fingerprintOf(v)).not.toBe(fingerprintOf(verifyOwnership(base())));
  });
});

describe('classification catalogue', () => {
  it('only allows statement categories consistent with each classification and requires evidence where the regulation conditions apply', () => {
    expect(ZAKAT_TYPES['deductible_fixed_asset']!.categories).toEqual(['non_current_asset']);
    expect(ZAKAT_TYPES['equity_capital']!.categories).toEqual(['equity']);
    expect(ZAKAT_TYPES['current_liability']!.categories).toEqual(['current_liability']);
    for (const t of ['partner_loan_credit_liability', 'deductible_investment', 'statutory_deposit', 'deductible_spare_or_raw_material', 'other_manual']) expect(ZAKAT_TYPES[t]!.evidence).toBe(true);
  });
});

describe('readiness', () => {
  const gate = (code: string, blocks: boolean, status = 'unverified'): GateRow => ({ code, title: code, article_ref: 'x', blocks_approval: blocks, status, verified_by_name: null, verified_on: null, verification_reference: null });
  const balances = { as_of_date: '2025-12-31', current_period_earnings_cents: '0', totals_cents: {}, accounts: [
    { account_id: 'x1', code: '1', name: 'Cap', name_ar: null, statement_category: 'equity', account_type: 'equity', is_contra: false, amount_cents: '100' },
    { account_id: 'x2', code: '2', name: 'Zero', name_ar: null, statement_category: 'current_asset', account_type: 'asset', is_contra: false, amount_cents: '0' },
    { account_id: 'x3', code: '3', name: 'Rev', name_ar: null, statement_category: 'revenue', account_type: 'revenue', is_contra: false, amount_cents: '50' },
  ] };
  const input = (over = {}) => ({ ownership: verifyOwnership(base()), periodReason: null, declarationsOk: true, balances, classifiedAccountIds: new Set(['x1']), balancesDrift: false, ownershipDrift: false, gates: [...REQUIRED_BLOCKING_GATES.map((c) => gate(c, true)), gate('B1', false)], ...over });
  it('never reports an amount and keeps approval blocked while a blocking gate is unverified', () => {
    const r = evaluateReadiness(input());
    expect(r).toMatchObject({ preparation_blockers: [], gate_blockers: [...REQUIRED_BLOCKING_GATES].sort(), can_submit: true, can_approve: false, calculation_performed: false, payable_amount: null, payable_amount_status: 'withheld_regulatory_gates' });
  });
  it('allows approval only when every blocking gate is verified', () => {
    expect(evaluateReadiness(input({ gates: [...REQUIRED_BLOCKING_GATES.map((c) => gate(c, true, 'verified')), gate('B1', false)] })).can_approve).toBe(true);
  });
  it('treats a missing, downgraded or unverified required gate row as blocking, so a data change alone cannot unlock approval', () => {
    const verified = REQUIRED_BLOCKING_GATES.map((c) => gate(c, true, 'verified'));
    expect(evaluateReadiness(input({ gates: verified.slice(1) })).can_approve).toBe(false);
    expect(evaluateReadiness(input({ gates: [] })).gate_blockers).toEqual([...REQUIRED_BLOCKING_GATES].sort());
    expect(evaluateReadiness(input({ gates: verified.map((g, i) => (i === 4 ? { ...g, blocks_approval: false, status: 'unverified' } : g)) })).can_approve).toBe(false);
    expect(REQUIRED_BLOCKING_GATES).toContain('B9_reference_cases_approval');
    expect(evaluateReadiness(input({ gates: verified })).payable_amount).toBeNull();
  });
  it('blocks submission while an investment deduction classification exists', () => {
    expect(evaluateReadiness(input({ investmentClassifications: 1 })).preparation_blockers).toEqual(['unsupported_investment_deduction']);
  });
  it('requires classification only for non-zero balance-sheet accounts and reports each preparation blocker', () => {
    expect(evaluateReadiness(input({ classifiedAccountIds: new Set() })).preparation_blockers).toEqual(['unclassified_balance']);
    const r = evaluateReadiness(input({ declarationsOk: false, balances: null, periodReason: 'fiscal_year_not_12_months', balancesDrift: true, ownershipDrift: true }));
    expect(r.preparation_blockers).toEqual(['balances_not_captured', 'balances_source_drift', 'fiscal_year_not_12_months', 'ownership_source_drift', 'scope_declaration_missing']);
    expect(r.can_submit).toBe(false);
  });
});
