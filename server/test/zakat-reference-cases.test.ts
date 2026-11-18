import { describe, expect, it } from 'vitest';
import { ZAKAT_CALCULATION_INPUT_VERSION, type ZakatCalculationInputV1 } from '../src/modules/zakat-calculation/calculation-input';
import { composeZakatBaseComponents } from '../src/modules/zakat-calculation/zakat-base-composition';
import { calculateZakatBase } from '../src/modules/zakat-calculation/zakat-base-engine';
import {
  assertAggregateLiabilityResultResolved,
  calculateArticle25Placement,
  calculatePeriodZakat,
  calculateProfitDifference,
} from '../src/modules/zakat-calculation/zakat-calculation';

// Synthetic inputs characterize deterministic accounting/arithmetic behavior only. They are not
// accountant-approved reference cases and must not be treated as regulatory conclusions.
const src = (recordId: string) => ({ source: 'synthetic-ledger', recordId });
const ev = (referenceId: string) => [{ referenceId, kind: 'accounting_record' as const }];
const review = (recordId: string) => ({ reviewerReference: src(`reviewer-${recordId}`), reviewedAt: '2026-01-01T00:00:00.000Z', evidence: ev(`review-${recordId}`) });

function referenceInput(): ZakatCalculationInputV1 {
  return {
    version: ZAKAT_CALCULATION_INPUT_VERSION,
    fiscalPeriod: { startDate: '2027-01-01', endDate: '2027-12-31', actualDays: 365, activityPeriod: 'regular' },
    sourceBalances: [
      { accountId: 'cash', statementCategory: 'current_asset', classification: 'statutory_deposit', amountSar: '100.00', sign: 'positive', sourceReference: src('cash'), evidence: ev('cash-proof'), regulatoryDecisionReferenceIds: ['decision-B4'] },
      { accountId: 'property', statementCategory: 'non_current_asset', classification: 'deductible_fixed_asset', amountSar: '100.00', sign: 'positive', sourceReference: src('property'), evidence: ev('property-proof'), regulatoryDecisionReferenceIds: ['decision-B4'] },
      { accountId: 'ap', statementCategory: 'current_liability', classification: 'current_liability', amountSar: '120.00', sign: 'positive', sourceReference: src('ap'), evidence: ev('ap-proof'), regulatoryDecisionReferenceIds: ['decision-B4'] },
      { accountId: 'loan', statementCategory: 'non_current_liability', classification: 'non_current_liability', amountSar: '200.00', sign: 'positive', sourceReference: src('loan'), evidence: ev('loan-proof'), regulatoryDecisionReferenceIds: ['decision-B4'] },
      { accountId: 'capital', statementCategory: 'equity', classification: 'equity_capital', amountSar: '0.00', sign: 'zero', sourceReference: src('capital'), evidence: ev('capital-proof'), regulatoryDecisionReferenceIds: ['decision-B0'] },
    ],
    declaredStatementTotals: { current_asset: '100.00', non_current_asset: '100.00', current_liability: '120.00', non_current_liability: '200.00', equity: '0.00' },
    adjustments: [],
    liabilityReclassifications: [],
    carriedForwardLossReconciliations: [],
    finalizedBookResult: { amountSar: '0.00', status: 'finalized', includesActuallyRecordedZakatAndTax: true, sourceReference: src('book-result'), evidence: ev('book-proof'), actuallyRecordedCharges: [] },
    adjustedProfit: { amountSar: '0.00', sourceReferences: [src('adjusted-profit')], evidence: ev('adjusted-profit-proof'), regulatoryDecisionReferenceId: 'decision-B7' },
    deductibleAssetCandidates: [
      { accountId: 'cash', amountSar: '20.00', eligibilityStatus: 'verified', sourceReference: src('cash-deduction'), evidence: ev('cash-deduction-proof'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('cash-deductible') },
      { accountId: 'property', amountSar: '80.00', eligibilityStatus: 'verified', sourceReference: src('property-deduction'), evidence: ev('property-deduction-proof'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('property-deduction') },
    ],
    undeductedAssets: [
      { accountId: 'cash', amountSar: '80.00', eligibilityStatus: 'verified', sourceReference: src('cash-undeducted'), evidence: ev('cash-undeducted-proof'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('cash-undeducted') },
      { accountId: 'property', amountSar: '20.00', eligibilityStatus: 'verified', sourceReference: src('property-undeducted'), evidence: ev('property-undeducted-proof'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('property-undeducted') },
    ],
    declaredAssetTotals: { deductibleCandidateSar: '100.00', undeductedSar: '100.00' },
    article73Assessment: { reviewed: true, sourceReference: src('art73-review'), evidence: ev('art73-review-proof'), reviewAttestation: review('article73'), regulatoryDecisionReferenceId: 'decision-B0', projects: [] },
    // Structurally valid synthetic references let the isolated primitives run. They do not verify
    // any real gate or authenticate these caller-supplied assertions.
    regulatoryDecisionReferences: (['B0', 'B3', 'B4', 'B7', 'B9'] as const).map((gate) => ({
      gate, referenceId: `decision-${gate}`, sourceReference: src(`decision-${gate}`), disposition: 'decision_recorded' as const, reviewAttestation: review(`gate-${gate}`),
    })),
  };
}

describe('B9 synthetic reference suite — verified arithmetic/accounting invariants only', () => {
  it('composes asset candidates in exact halalas without producing a base or payable amount', () => {
    const result = composeZakatBaseComponents(referenceInput());
    expect(result.status).toBe('BLOCKED'); // Liability placement is deliberately unresolved.
    expect(result.totals?.verifiedDeductibleAssetCandidatesHalalas).toBe('10000');
    expect(result.finalZakatBaseHalalas).toBeNull();
    expect(result.payableAmountHalalas).toBeNull();
  });

  it('keeps liability candidates as memorandum lines while liability-cap treatment is unresolved', () => {
    const result = composeZakatBaseComponents(referenceInput());
    const current = result.lines.find((line) => line.id === 'account:ap');
    const nonCurrent = result.lines.find((line) => line.id === 'account:loan');
    expect(current).toMatchObject({ component: 'liability_candidate', amountHalalas: '12000', direction: 'memorandum', includedInComponentTotals: false });
    expect(nonCurrent).toMatchObject({ component: 'liability_candidate', amountHalalas: '20000', direction: 'memorandum', includedInComponentTotals: false });
    expect(result.blockers.map((blocker) => blocker.code)).toContain('LIABILITY_CAPS_UNRESOLVED');
    expect(result.finalZakatBaseHalalas).toBeNull();
    expect(result.payableAmountHalalas).toBeNull();
  });

  it('tracks positive, zero, and negative equity signs without assigning an approved Zakat effect', () => {
    const positive = referenceInput();
    positive.sourceBalances.find((row) => row.accountId === 'capital')!.amountSar = '25.00';
    positive.sourceBalances.find((row) => row.accountId === 'capital')!.sign = 'positive';
    positive.declaredStatementTotals.equity = '25.00';
    const positiveResult = composeZakatBaseComponents(positive);
    expect(positiveResult.totals?.equityAdditionsHalalas).toBe('2500');
    expect(positiveResult.totals?.equityReductionsHalalas).toBe('0');

    const zeroResult = composeZakatBaseComponents(referenceInput());
    expect(zeroResult.lines.find((line) => line.id === 'account:capital')).toMatchObject({ amountHalalas: '0', direction: 'memorandum', includedInComponentTotals: false });

    const negative = referenceInput();
    negative.sourceBalances = [{ ...negative.sourceBalances[4]!, classification: 'carried_forward_loss', amountSar: '-25.00', sign: 'negative', carriedForwardLossReconciliationId: 'loss-rec' }];
    negative.declaredStatementTotals = { current_asset: '0.00', non_current_asset: '0.00', current_liability: '0.00', non_current_liability: '0.00', equity: '-25.00' };
    negative.deductibleAssetCandidates = [];
    negative.undeductedAssets = [];
    negative.declaredAssetTotals = { deductibleCandidateSar: '0.00', undeductedSar: '0.00' };
    negative.carriedForwardLossReconciliations = [{ reconciliationId: 'loss-rec', accountId: 'capital', openingLossSar: '20.00', currentPeriodLossSar: '5.00', otherMovementsSar: '0.00', closingLossSar: '25.00', sourceReference: src('loss-rec'), evidence: ev('loss-rollforward'), regulatoryDecisionReferenceId: 'decision-B0' }];
    const negativeResult = composeZakatBaseComponents(negative);
    expect(negativeResult.totals?.equityReductionsHalalas).toBe('2500');
    expect(negativeResult.lines.find((line) => line.id === 'account:capital')).toMatchObject({ amountHalalas: '-2500', direction: 'reduction' });
  });

  it('preserves exact Article 25 placement arithmetic and fails closed beyond the aggregate cap', () => {
    // This characterizes the existing helper and its fail-closed boundary; it does not resolve the
    // regulatory sequencing question recorded by B4.
    const placement = calculateArticle25Placement({
      totalCurrentAssetsSar: '100.00', deductedCurrentAssetSar: '20.00', currentLiabilitiesSar: '30.00',
      totalNonCurrentAssetsSar: '100.00', nonDeductedNonCurrentAssetSar: '20.00', nonCurrentLiabilitiesSar: '40.00',
    });
    expect(placement.currentLiabilitiesAddedHalalas).toEqual({ numerator: '600', denominator: '1' });
    expect(placement.nonCurrentLiabilitiesExcludedHalalas).toEqual({ numerator: '800', denominator: '1' });
    expect(() => assertAggregateLiabilityResultResolved({ totalLiabilityAdditionsHalalas: { numerator: '4000', denominator: '1' }, totalDeductedAssetsSar: '50.00' })).not.toThrow();
    expect(() => assertAggregateLiabilityResultResolved({ totalLiabilityAdditionsHalalas: { numerator: '4000', denominator: '1' }, article29ResidualAdditionHalalas: { numerator: '2000', denominator: '1' }, totalDeductedAssetsSar: '50.00' })).toThrowError(expect.objectContaining({ code: 'AGGREGATE_LIABILITY_CAP_UNRESOLVED' }));
  });

  it('computes the signed difference between supplied adjusted and finalized accounting results', () => {
    // The subtraction is deterministic for the supplied values. Whether the supplied book result
    // meets Article 23(3) when no Zakat provision is recorded remains pending under B7.
    expect(calculateProfitDifference('120000.00', '90000.00')).toEqual({ differenceHalalas: '3000000' });
    expect(calculateProfitDifference('-30000.00', '-20000.00')).toEqual({ differenceHalalas: '-1000000' });
    expect(calculateProfitDifference('0.00', '0.00')).toEqual({ differenceHalalas: '0' });
  });

  it.each([
    ['below half-halala boundary', '10.19', { numerator: '1019', denominator: '40' }],
    ['at half-halala boundary', '10.20', { numerator: '51', denominator: '2' }],
    ['above half-halala boundary', '10.21', { numerator: '1021', denominator: '40' }],
  ])('retains exact Article 15 arithmetic %s and labels final rounding provisional', (_label, baseSar, expectedExact) => {
    const result = calculatePeriodZakat(baseSar, 354);
    expect(result.exactHalalas).toEqual(expectedExact);
    expect(result.roundingPolicyStatus).toBe('provisional');
    // finalAmountHalalas is intentionally not asserted until B3 has a professional decision.
  });

  it.each(['B0', 'B3', 'B4', 'B7', 'B9'] as const)('keeps the engine blocked when %s has a pending decision reference', (gate) => {
    const data = referenceInput();
    data.regulatoryDecisionReferences.find((reference) => reference.gate === gate)!.disposition = 'pending';
    const result = calculateZakatBase(data);
    expect(result.status).toBe('BLOCKED');
    expect(result.blockers.some((blocker) => blocker.code === 'REGULATORY_DECISION_PENDING' && blocker.message.includes(`${gate} decision is unresolved`))).toBe(true);
    expect(result.finalZakatBaseHalalas).toBeNull();
    expect(result.payableAmountHalalas).toBeNull();
  });

  it('withholds a final amount even when synthetic decision and reviewer assertions claim every gate is resolved', () => {
    const data = referenceInput();
    for (const account of data.sourceBalances.filter((row) => row.statementCategory.endsWith('liability'))) {
      account.amountSar = '0.00';
      account.sign = 'zero';
    }
    data.declaredStatementTotals.current_liability = '0.00';
    data.declaredStatementTotals.non_current_liability = '0.00';
    const result = calculateZakatBase(data);
    expect(result.status).toBe('BLOCKED');
    expect(result.blockers.map((blocker) => blocker.code)).toContain('REGULATORY_GATE_AUTHENTICATION_REQUIRED');
    expect(result.finalZakatBaseHalalas).toBeNull();
    expect(result.payableAmountHalalas).toBeNull();
    expect(result.traceLines.some((line) => line.id === 'zakat:period-amount')).toBe(false);
  });
});

describe('B9 reference outcomes pending professional approval', () => {
  it.todo('B0: approve reference outcomes for Decision 1248/1446 scope and Article 73 project applicability');
  it.todo('B3: approve final payable rounding outcomes at below, exact, and above half-halala boundaries');
  it.todo('B4: approve reference outcomes for aggregate liability caps interacting with Article 29(2)(b)');
  it.todo('B7: approve reference outcomes for Article 23(3) when no Zakat provision is recorded');
  it.todo('B9: accountant to approve the complete numerical reference suite before any calculation activation');
});
