import { describe, expect, it } from 'vitest';
import { composeZakatBaseComponents } from '../src/modules/zakat-calculation/zakat-base-composition';
import { ZAKAT_CALCULATION_INPUT_VERSION, type ZakatCalculationInputV1 } from '../src/modules/zakat-calculation/calculation-input';

const source = (recordId: string) => ({ source: 'synthetic-accounting', recordId });
const evidence = (referenceId: string) => [{ referenceId, kind: 'accounting_record' as const }];
const review = (recordId: string) => ({ reviewerReference: source(`reviewer-${recordId}`), reviewedAt: '2026-01-01T00:00:00.000Z', evidence: evidence(`review-${recordId}`) });
const decisions = (disposition: 'decision_recorded' | 'pending' = 'decision_recorded') =>
  (['B0', 'B3', 'B4', 'B7', 'B9'] as const).map((gate) => ({
    gate,
    referenceId: `ref-${gate}`,
    sourceReference: source(`reg-${gate}`),
    disposition,
    reviewAttestation: review(`gate-${gate}`),
  }));

function validInput(): ZakatCalculationInputV1 {
  return {
    version: ZAKAT_CALCULATION_INPUT_VERSION,
    fiscalPeriod: { startDate: '2027-01-01', endDate: '2027-12-31', actualDays: 365, activityPeriod: 'regular' },
    sourceBalances: [
      {
        accountId: 'capital', statementCategory: 'equity', classification: 'equity_capital',
        amountSar: '100.00', sign: 'positive', sourceReference: source('capital-row'), evidence: evidence('capital-proof'),
        regulatoryDecisionReferenceIds: ['ref-B0'],
      },
      {
        accountId: 'reserve-reduction', statementCategory: 'equity', classification: 'equity_reserve',
        amountSar: '-20.00', sign: 'negative', sourceReference: source('reserve-row'), evidence: evidence('reserve-proof'),
        regulatoryDecisionReferenceIds: ['ref-B0'],
      },
      {
        accountId: 'bank', statementCategory: 'current_asset', classification: 'statutory_deposit',
        amountSar: '50.00', sign: 'positive', sourceReference: source('bank-row'), evidence: evidence('bank-proof'),
        regulatoryDecisionReferenceIds: ['ref-B4'],
      },
      {
        accountId: 'fixed-asset', statementCategory: 'non_current_asset', classification: 'deductible_fixed_asset',
        amountSar: '25.00', sign: 'positive', sourceReference: source('fixed-asset-row'), evidence: evidence('fixed-asset-proof'),
        regulatoryDecisionReferenceIds: ['ref-B4'],
      },
    ],
    declaredStatementTotals: {
      current_asset: '50.00', non_current_asset: '25.00', current_liability: '0.00',
      non_current_liability: '0.00', equity: '80.00',
    },
    adjustments: [
      {
        adjustmentId: 'equity-increase', category: 'equity', direction: 'add', amountSar: '10.00',
        sourceReference: source('equity-increase'), evidence: evidence('equity-increase-proof'), regulatoryDecisionReferenceId: 'ref-B0', includedInArticle28ClosingEquity: true,
      },
      {
        adjustmentId: 'equity-reduction', category: 'equity', direction: 'deduct', amountSar: '2.00',
        sourceReference: source('equity-reduction'), evidence: evidence('equity-reduction-proof'), regulatoryDecisionReferenceId: 'ref-B0', includedInArticle28ClosingEquity: true,
      },
      {
        adjustmentId: 'profit-increase', category: 'profit', direction: 'add', amountSar: '15.00',
        sourceReference: source('profit-increase'), evidence: evidence('profit-increase-proof'), regulatoryDecisionReferenceId: 'ref-B7',
        article63ExpenseCategory: 'current_year_provision', reviewAttestation: review('profit-increase'),
      },
    ],
    liabilityReclassifications: [],
    carriedForwardLossReconciliations: [],
    finalizedBookResult: {
      amountSar: '40.00', status: 'finalized', includesActuallyRecordedZakatAndTax: true,
      sourceReference: source('book-result'), evidence: evidence('book-proof'), actuallyRecordedCharges: [],
    },
    adjustedProfit: {
      amountSar: '55.00', sourceReferences: [source('adjusted-profit')], evidence: evidence('adjusted-profit-proof'),
      regulatoryDecisionReferenceId: 'ref-B7',
    },
    deductibleAssetCandidates: [
      {
        accountId: 'bank', amountSar: '50.00', eligibilityStatus: 'verified', sourceReference: source('bank-allocation'),
        evidence: evidence('bank-eligibility'), regulatoryDecisionReferenceId: 'ref-B4', reviewAttestation: review('bank-allocation'),
      },
      {
        accountId: 'fixed-asset', amountSar: '25.00', eligibilityStatus: 'verified', sourceReference: source('fixed-allocation'),
        evidence: evidence('fixed-eligibility'), regulatoryDecisionReferenceId: 'ref-B4', reviewAttestation: review('fixed-allocation'),
      },
    ],
    undeductedAssets: [],
    declaredAssetTotals: { deductibleCandidateSar: '75.00', undeductedSar: '0.00' },
    article73Assessment: { reviewed: true, sourceReference: source('art73-review'), evidence: evidence('art73-proof'), reviewAttestation: review('article73'), regulatoryDecisionReferenceId: 'ref-B0', projects: [] },
    regulatoryDecisionReferences: decisions(),
  };
}

function issueCodes(input: unknown): string[] {
  return composeZakatBaseComponents(input).blockers.map((blocker) => blocker.code);
}

describe('isolated Zakat base component composition', () => {
  it('composes signed equity, verified assets, and signed Article 23(3) profit difference exactly', () => {
    const result = composeZakatBaseComponents(validInput());
    expect(result.status).toBe('COMPONENTS_ONLY');
    expect(result.totals).toEqual({
      equityAdditionsHalalas: '11000',
      equityReductionsHalalas: '2200',
      equityNetHalalas: '8800',
      verifiedDeductibleAssetCandidatesHalalas: '7500',
      article23ProfitDifferenceHalalas: '1500',
    });
    expect(result.finalZakatBaseHalalas).toBeNull();
    expect(result.payableAmountHalalas).toBeNull();
    expect(result.lines.find((line) => line.id === 'account:reserve-reduction')).toMatchObject({
      component: 'equity', direction: 'reduction', amountHalalas: '-2000',
      sourceReferences: [source('reserve-row')],
    });
    expect(result.lines.find((line) => line.id === 'asset:bank')).toMatchObject({
      component: 'verified_deductible_asset_candidate', direction: 'reduction', amountHalalas: '-5000',
      evidence: evidence('bank-eligibility'), regulatoryDecisionReferenceIds: ['ref-B4'],
    });
    expect(result.lines.find((line) => line.id === 'article23-3:profit-difference')).toMatchObject({
      amountHalalas: '1500', sourceReferences: [source('book-result'), source('adjusted-profit')],
    });
  });

  it('preserves negative profit differences without inserting a provision', () => {
    const input = validInput();
    input.adjustedProfit.amountSar = '20.00';
    input.adjustments[2].direction = 'deduct';
    input.adjustments[2].amountSar = '20.00';
    const result = composeZakatBaseComponents(input);
    expect(result.status).toBe('COMPONENTS_ONLY');
    expect(result.totals?.article23ProfitDifferenceHalalas).toBe('-2000');
  });

  it('accepts zero balances and zero components without manufacturing amounts', () => {
    const input = validInput();
    input.sourceBalances = [
      { ...input.sourceBalances[0], amountSar: '0.00', sign: 'zero' },
      { ...input.sourceBalances[2], amountSar: '0.00', sign: 'zero' },
    ];
    input.declaredStatementTotals = {
      current_asset: '0.00', non_current_asset: '0.00', current_liability: '0.00',
      non_current_liability: '0.00', equity: '0.00',
    };
    input.deductibleAssetCandidates = [{ ...input.deductibleAssetCandidates[0], amountSar: '0.00' }];
    input.declaredAssetTotals = { deductibleCandidateSar: '0.00', undeductedSar: '0.00' };
    input.adjustments = [];
    input.adjustedProfit.amountSar = input.finalizedBookResult.amountSar;
    const result = composeZakatBaseComponents(input);
    expect(result.status).toBe('COMPONENTS_ONLY');
    expect(result.totals).toEqual({
      equityAdditionsHalalas: '0', equityReductionsHalalas: '0', equityNetHalalas: '0',
      verifiedDeductibleAssetCandidatesHalalas: '0', article23ProfitDifferenceHalalas: '0',
    });
    expect(result.finalZakatBaseHalalas).toBeNull();
  });

  it('blocks duplicate account mappings', () => {
    const input = validInput();
    input.sourceBalances.push({ ...input.sourceBalances[0] });
    expect(issueCodes(input)).toContain('DUPLICATE_ACCOUNT_MAPPING');
    expect(composeZakatBaseComponents(input).totals).toBeNull();
  });

  it('blocks ambiguous negative retained earnings and carried-forward loss treatment', () => {
    const retained = validInput();
    retained.sourceBalances[0] = {
      ...retained.sourceBalances[0], classification: 'retained_earnings', amountSar: '-100.00', sign: 'negative',
    };
    retained.declaredStatementTotals.equity = '-120.00';
    expect(issueCodes(retained)).toContain('CARRIED_FORWARD_LOSS_NOT_RECONCILED');

    const loss = validInput();
    loss.sourceBalances[0] = { ...loss.sourceBalances[0], classification: 'carried_forward_loss' };
    expect(issueCodes(loss)).toContain('CARRIED_FORWARD_LOSS_NOT_RECONCILED');
  });

  it('blocks missing finalized profit inputs and pending regulatory decisions', () => {
    const missingProfit = validInput();
    (missingProfit as unknown as Record<string, unknown>).finalizedBookResult = null;
    expect(issueCodes(missingProfit)).toContain('FINALIZED_BOOK_RESULT_REQUIRED');

    const pending = validInput();
    pending.regulatoryDecisionReferences = decisions('pending');
    expect(issueCodes(pending)).toContain('REGULATORY_DECISION_PENDING');
  });

  it('blocks pending asset eligibility, missing eligibility, and unsupported deductions', () => {
    const pending = validInput();
    pending.deductibleAssetCandidates[0].eligibilityStatus = 'pending';
    expect(issueCodes(pending)).toContain('ASSET_ELIGIBILITY_UNVERIFIED');

    const missing = validInput();
    (missing.deductibleAssetCandidates[0] as unknown as Record<string, unknown>).eligibilityStatus = undefined;
    expect(issueCodes(missing)).toContain('ASSET_ELIGIBILITY_STATUS_REQUIRED');

    const unsupportedDeduction = validInput();
    unsupportedDeduction.adjustments.push({
      adjustmentId: 'unsupported-asset-deduction', category: 'asset_deduction', direction: 'deduct', amountSar: '1.00',
      sourceReference: source('unsupported-deduction'), evidence: evidence('unsupported-deduction-proof'),
      regulatoryDecisionReferenceId: 'ref-B4',
    });
    expect(issueCodes(unsupportedDeduction)).toContain('UNSUPPORTED_ASSET_DEDUCTION');
  });

  it('blocks nonzero liabilities rather than applying an unresolved cap or sequence', () => {
    const input = validInput();
    input.sourceBalances.push({
      accountId: 'payable', statementCategory: 'current_liability', classification: 'current_liability',
      amountSar: '10.00', sign: 'positive', sourceReference: source('payable-row'), evidence: evidence('payable-proof'),
      regulatoryDecisionReferenceIds: ['ref-B4'],
    });
    input.declaredStatementTotals.current_liability = '10.00';
    const result = composeZakatBaseComponents(input);
    expect(result.status).toBe('BLOCKED');
    expect(result.blockers.map((blocker) => blocker.code)).toContain('LIABILITY_CAPS_UNRESOLVED');
    expect(result.lines.find((line) => line.id === 'account:payable')).toMatchObject({
      component: 'liability_candidate', includedInComponentTotals: false,
    });
    expect(result.finalZakatBaseHalalas).toBeNull();
  });

  it('blocks deductible-classified assets without an explicit allocation', () => {
    const input = validInput();
    input.deductibleAssetCandidates = input.deductibleAssetCandidates.slice(0, 1);
    input.declaredAssetTotals.deductibleCandidateSar = '50.00';
    expect(issueCodes(input)).toContain('ASSET_SOURCE_ALLOCATION_MISMATCH');
  });
});
