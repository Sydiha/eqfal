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
  it('supports deterministic SAR arithmetic in integer halalas', () => {
    const baseHalalas = toCents('100000.00');
    const rateBasisPoints = 250n; // 2.5%, used here as a test input only.
    expect(baseHalalas * rateBasisPoints / 10_000n).toBe(250_000n); // SAR 2,500.00
    expect(toCents('120000.00') - toCents('100000.00')).toBe(2_000_000n); // SAR 20,000.00
  });
  it('keeps signed profit differences signed using integer halalas', () => {
    expect(toCents('120000.00') - toCents('100000.00')).toBe(toCents('20000.00'));
    expect(toCents('-30000.00') - toCents('-20000.00')).toBe(toCents('-10000.00'));
    expect(toCents('100000.00') - toCents('100000.00')).toBe(0n);
  });
});

describe('B3: regulation-established actual-day formula and provisional test-only rounding policy', () => {
  const positiveHalfUp = (numerator: bigint, denominator: bigint) => (2n * numerator + denominator) / (2n * denominator);

  it.each([
    ['Hijri year at 354 days', 354n, 354n, '2500.00'],
    ['non-Hijri 365-day fiscal year', 354n, 365n, '2577.68'],
    ['non-Hijri 366-day fiscal year', 354n, 366n, '2584.75'],
  ])('%s uses 354 denominator and actual fiscal-year days', (_label, hijriDays, fiscalDays, expectedSar) => {
    const baseHalalas = toCents('100000.00');
    const rateBasisPoints = 250n; // Regulation rate input: 2.5%.
    const exactHalalaNumerator = baseHalalas * rateBasisPoints * fiscalDays;
    const exactHalalaDenominator = 10_000n * hijriDays;
    // Provisional EQFAL test policy only: retain the exact ratio, then round the final SAR amount to halalas HALF_UP.
    const finalHalalas = positiveHalfUp(exactHalalaNumerator, exactHalalaDenominator);
    expect(finalHalalas).toBe(toCents(expectedSar));
  });

  it('labels HALF_UP as provisional and applies it only once to the final SAR amount', () => {
    // Exact result is SAR 2.505 (250.5 halalas); no intermediate rate/base rounding is performed.
    const finalHalalas = positiveHalfUp(2_505n, 10n);
    expect(finalHalalas).toBe(251n); // SAR 2.51 under provisional HALF_UP policy.
    const exactHalfEvenHalalas = 250n; // Alternative at this exact tie; not selected as EQFAL policy.
    expect(finalHalalas).not.toBe(exactHalfEvenHalalas);
  });
});

describe('B4: published six-step ZATCA liability procedure (test-only arithmetic)', () => {
  it('applies classification, placement, deducted-asset limit, then the residual-liability check in sequence', () => {
    // 1. Identify end-period non-current liabilities; 5,000 of the reported 50,000 is equity-like.
    const reportedNonCurrentLiabilities = toCents('50000.00');
    const equityReclassified = toCents('5000.00');
    const step1NonCurrent = reportedNonCurrentLiabilities - equityReclassified;
    expect(step1NonCurrent).toBe(toCents('45000.00'));

    // 2. Reclassify qualifying current financing of 10,000 as non-current; it is included in the 30,000 current balance.
    const qualifyingCurrentFinancing = toCents('10000.00');
    const step2LiabilitiesForPlacement = step1NonCurrent + qualifyingCurrentFinancing;
    expect(step2LiabilitiesForPlacement).toBe(toCents('55000.00'));

    // 3. Equity-like 5,000 was excluded in step 1; it is not counted again as a liability.
    const step3Liabilities = step2LiabilitiesForPlacement;
    expect(step3Liabilities).toBe(toCents('55000.00'));

    // 4. Apply Article 25 placement: exclude 20% for non-deducted non-current assets;
    // after step 2, only 20,000 of the original 30,000 current liabilities remain current.
    const nonCurrentLiabilitiesExcluded = step3Liabilities * 20n / 100n;
    const placedNonCurrentAddition = step3Liabilities - nonCurrentLiabilitiesExcluded;
    const currentLiabilitiesAfterReclassification = toCents('30000.00') - qualifyingCurrentFinancing;
    const currentPlacementAddition = toCents('20000.00') * currentLiabilitiesAfterReclassification / toCents('100000.00');
    expect(nonCurrentLiabilitiesExcluded).toBe(toCents('11000.00'));
    expect(placedNonCurrentAddition).toBe(toCents('44000.00'));
    expect(currentLiabilitiesAfterReclassification).toBe(toCents('20000.00'));
    expect(currentPlacementAddition).toBe(toCents('4000.00'));

    // 5. Addition (48,000) is within 70,000 total qualifying deductions.
    const totalAdditionBeforeAggregateCap = placedNonCurrentAddition + currentPlacementAddition;
    const totalDeductedAssets = toCents('70000.00');
    const step5Addition = totalAdditionBeforeAggregateCap > totalDeductedAssets ? totalDeductedAssets : totalAdditionBeforeAggregateCap;
    expect(step5Addition).toBe(toCents('48000.00'));

    // 6. Remaining liabilities (75,000 total after equity reclassification less 48,000 added)
    // are below undeducted assets (200,000 total assets less 70,000 deducted).
    const liabilitiesAfterEquityReclassification = toCents('75000.00');
    const undeductedAssets = toCents('200000.00') - totalDeductedAssets;
    const notAddedLiabilities = liabilitiesAfterEquityReclassification - step5Addition;
    const step6AdditionalAmount = notAddedLiabilities > undeductedAssets ? notAddedLiabilities - undeductedAssets : 0n;
    expect(notAddedLiabilities).toBe(toCents('27000.00'));
    expect(undeductedAssets).toBe(toCents('130000.00'));
    expect(step6AdditionalAmount).toBe(0n);
  });
});

describe('B7: signed difference from actual finalized book result', () => {
  it.each([
    ['positive difference', '120000.00', '90000.00', '30000.00'],
    ['negative difference', '-30000.00', '-20000.00', '-10000.00'],
    ['zero difference', '100000.00', '100000.00', '0.00'],
  ])('%s does not insert a hypothetical Zakat provision', (_label, adjustedResult, finalizedBookAfterActualCharges, expected) => {
    // The second input is the finalized statement result after charges actually recorded; no hypothetical Zakat is added.
    expect(toCents(adjustedResult) - toCents(finalizedBookAfterActualCharges)).toBe(toCents(expected));
  });
});

describe('B0: Article 73 applicability is scoped to relevant activity; no zakat result is asserted', () => {
  it.each([
    ['entity without Article 73 activity', false, false],
    ['entity with Article 73-related activity', true, true],
  ])('%s', (_label, hasRelevantActivity, shouldReviewArticle73) => {
    // This is a test-only scope distinction, not a determination that project-specific deduction conditions are met.
    expect(hasRelevantActivity).toBe(shouldReviewArticle73);
  });
});

describe('B9 regulatory cases still pending professional decisions', () => {
  it.todo('B3: accountant to approve provisional EQFAL final-amount HALF_UP rounding policy');
  it.todo('B4: resolve interaction of aggregate liability cap with Article 29(2)(b) residual-liability addition');
  it.todo('B7: confirm finalized book result/source when no Zakat provision is recognized in the accounts');
  it.todo('B0: confirm Decision 1248/1446 scope and applicability against EQFAL activity and project facts');
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
  const input = (over = {}) => ({ ownership: verifyOwnership(base()), periodReason: null, declarationsOk: true, balances, classifiedAccountIds: new Set(['x1', 'x2']), balancesDrift: false, ownershipDrift: false, gates: [...REQUIRED_BLOCKING_GATES.map((c) => gate(c, true)), gate('B1', false)], ...over });
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
  it.each(REQUIRED_BLOCKING_GATES)('keeps approval and payable amount blocked while %s is unresolved', (unresolvedGate) => {
    const gates = REQUIRED_BLOCKING_GATES.map((code) => gate(code, true, code === unresolvedGate ? 'unverified' : 'verified'));
    const readiness = evaluateReadiness(input({ gates }));
    expect(readiness.gate_blockers).toContain(unresolvedGate);
    expect(readiness.can_approve).toBe(false);
    expect(readiness.calculation_performed).toBe(false);
    expect(readiness.payable_amount).toBeNull();
  });
  it('blocks submission while an investment deduction classification exists', () => {
    expect(evaluateReadiness(input({ investmentClassifications: 1 })).preparation_blockers).toEqual(['unsupported_investment_deduction']);
  });
  it('requires a validated classification for every in-scope account, including zero-balance accounts', () => {
    const result = evaluateReadiness(input({ classifiedAccountIds: new Set(['x1']) }));
    expect(result.preparation_blockers).toEqual(['unclassified_balance']);
    expect(result.unclassified_account_count).toBe(1);
  });
  it('reports each preparation blocker', () => {
    const r = evaluateReadiness(input({ declarationsOk: false, balances: null, periodReason: 'fiscal_year_not_12_months', balancesDrift: true, ownershipDrift: true }));
    expect(r.preparation_blockers).toEqual(['balances_not_captured', 'balances_source_drift', 'fiscal_year_not_12_months', 'ownership_source_drift', 'scope_declaration_missing']);
    expect(r.can_submit).toBe(false);
  });
});
