import { describe, expect, it } from 'vitest';
import { ZAKAT_TYPES } from '../src/modules/zakat-worksheets/zakat-worksheet.rules';
import {
  CLASSIFICATION_COMPONENTS,
  STATEMENT_CATEGORIES,
  validateCalculationInput,
  ZAKAT_CALCULATION_INPUT_VERSION,
  type ZakatCalculationInputV1,
} from '../src/modules/zakat-calculation/calculation-input';

const sourceReference = (recordId: string) => ({ source: 'synthetic-trial-balance', recordId });
const evidence = (referenceId: string) => [{ referenceId, kind: 'accounting_record' as const }];
const review = (recordId: string) => ({ reviewerReference: sourceReference(`reviewer-${recordId}`), reviewedAt: '2026-01-01T00:00:00.000Z', evidence: evidence(`review-${recordId}`) });
const decisionReferences = (disposition: 'decision_recorded' | 'pending' = 'decision_recorded') =>
  (['B0', 'B3', 'B4', 'B7', 'B9'] as const).map((gate) => ({
    gate,
    referenceId: `decision-${gate}`,
    sourceReference: sourceReference(`decision-source-${gate}`),
    disposition,
    reviewAttestation: review(`gate-${gate}`),
  }));

function validInput(): ZakatCalculationInputV1 {
  return {
    version: ZAKAT_CALCULATION_INPUT_VERSION,
    fiscalPeriod: { startDate: '2027-01-01', endDate: '2027-12-31', actualDays: 365, activityPeriod: 'regular' },
    sourceBalances: [
      {
        accountId: 'account-equity', statementCategory: 'equity', classification: 'equity_capital',
        amountSar: '5000.00', sign: 'positive', sourceReference: sourceReference('tb-equity'), evidence: evidence('equity-proof'),
        regulatoryDecisionReferenceIds: ['decision-B0'],
      },
      {
        accountId: 'account-bank', statementCategory: 'current_asset', classification: 'statutory_deposit',
        amountSar: '5000.00', sign: 'positive', sourceReference: sourceReference('tb-bank'), evidence: evidence('bank-proof'),
        regulatoryDecisionReferenceIds: ['decision-B4'],
      },
      {
        accountId: 'account-payroll', statementCategory: 'current_liability', classification: 'current_liability',
        amountSar: '4800.00', sign: 'positive', sourceReference: sourceReference('tb-payroll'), evidence: evidence('payroll-proof'),
        regulatoryDecisionReferenceIds: ['decision-B4'],
      },
      {
        accountId: 'account-zero-fixed-asset', statementCategory: 'non_current_asset', classification: 'deductible_fixed_asset',
        amountSar: '0.00', sign: 'zero', sourceReference: sourceReference('tb-zero-asset'), evidence: evidence('zero-asset-proof'),
        regulatoryDecisionReferenceIds: ['decision-B4'],
      },
    ],
    declaredStatementTotals: {
      current_asset: '5000.00', non_current_asset: '0.00', current_liability: '4800.00',
      non_current_liability: '0.00', equity: '5000.00',
    },
    adjustments: [{
      adjustmentId: 'adjustment-profit-zero', category: 'profit', direction: 'add', amountSar: '0.00',
      sourceReference: sourceReference('adjustment-source'), evidence: evidence('adjustment-proof'),
      regulatoryDecisionReferenceId: 'decision-B3',
    }],
    liabilityReclassifications: [],
    carriedForwardLossReconciliations: [],
    finalizedBookResult: {
      amountSar: '-1000.00', status: 'finalized', includesActuallyRecordedZakatAndTax: true,
      sourceReference: sourceReference('final-book-result'), evidence: evidence('final-book-proof'), actuallyRecordedCharges: [],
    },
    adjustedProfit: {
      amountSar: '-1000.00', sourceReferences: [sourceReference('adjusted-profit-source')],
      evidence: evidence('adjusted-profit-proof'), regulatoryDecisionReferenceId: 'decision-B7',
    },
    deductibleAssetCandidates: [{
      accountId: 'account-bank', amountSar: '5000.00', eligibilityStatus: 'verified', sourceReference: sourceReference('bank-allocation'),
      evidence: evidence('bank-allocation-proof'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('bank-allocation'),
    }, {
      accountId: 'account-zero-fixed-asset', amountSar: '0.00', eligibilityStatus: 'verified', sourceReference: sourceReference('zero-allocation'),
      evidence: evidence('zero-allocation-proof'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('zero-allocation'),
    }],
    undeductedAssets: [],
    declaredAssetTotals: { deductibleCandidateSar: '5000.00', undeductedSar: '0.00' },
    article73Assessment: { reviewed: true, sourceReference: sourceReference('art73-review'), evidence: evidence('art73-review-proof'), reviewAttestation: review('article73'), regulatoryDecisionReferenceId: 'decision-B0', projects: [] },
    regulatoryDecisionReferences: decisionReferences(),
  };
}

const issueCodes = (input: unknown) => {
  const result = validateCalculationInput(input);
  expect(result.valid).toBe(false);
  return result.issues.map((issue) => issue.code);
};

describe('versioned Zakat calculation input contract', () => {
  it('accepts complete input and maps only explicitly supported classifications without calculating an amount', () => {
    const result = validateCalculationInput(validInput());
    expect(result).toMatchObject({ valid: true, version: ZAKAT_CALCULATION_INPUT_VERSION, issues: [] });
    if (!result.valid) throw new Error('expected valid input');
    expect(result.mappedAccounts).toEqual([
      expect.objectContaining({ accountId: 'account-equity', component: 'equity_component', amountHalalas: '500000' }),
      expect.objectContaining({ accountId: 'account-bank', component: 'deductible_asset_candidate', amountHalalas: '500000' }),
      expect.objectContaining({ accountId: 'account-payroll', component: 'current_liability_candidate', amountHalalas: '480000' }),
      expect.objectContaining({ accountId: 'account-zero-fixed-asset', component: 'deductible_asset_candidate', amountHalalas: '0' }),
    ]);
    expect(result.mappedAccounts[0].sourceReference).toEqual(sourceReference('tb-equity'));
    expect(result.mappedAccounts[0].evidence).toEqual(evidence('equity-proof'));
    expect(result).not.toHaveProperty('zakatAmount');
  });

  it('keeps the mapping list aligned with the worksheet enum and maps only explicit cases', () => {
    expect(Object.keys(ZAKAT_TYPES).sort()).toEqual([
      'carried_forward_loss', 'current_liability', 'deductible_fixed_asset', 'deductible_intangible',
      'deductible_investment', 'deductible_spare_or_raw_material', 'deferred_tax_asset', 'equity_capital',
      'equity_reserve', 'non_current_liability', 'non_deductible_asset', 'other_manual',
      'partner_loan_credit_equity', 'partner_loan_credit_liability', 'provision_equity_like',
      'provision_eosb_leave', 'retained_earnings', 'statutory_deposit', 'treasury_shares',
    ].sort());
    expect(Object.keys(CLASSIFICATION_COMPONENTS).sort()).toEqual([
      'carried_forward_loss', 'current_liability', 'deductible_fixed_asset', 'deductible_intangible', 'deductible_investment', 'deferred_tax_asset',
      'deductible_spare_or_raw_material', 'equity_capital', 'equity_reserve', 'non_current_liability',
      'non_deductible_asset', 'partner_loan_credit_equity', 'partner_loan_credit_liability', 'provision_equity_like',
      'provision_eosb_leave', 'retained_earnings', 'statutory_deposit', 'treasury_shares',
    ].sort());
  });

  it('preserves explicit negative source balances without using the sign to change classification', () => {
    const input = validInput();
    input.sourceBalances[2] = {
      ...input.sourceBalances[2], amountSar: '-4800.00', sign: 'negative',
    };
    input.declaredStatementTotals.current_liability = '-4800.00';
    const result = validateCalculationInput(input);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid input');
    expect(result.mappedAccounts.find((row) => row.accountId === 'account-payroll')).toMatchObject({
      classification: 'current_liability', component: 'current_liability_candidate', amountHalalas: '-480000',
    });
  });

  it('accepts zero source balances and zero categorized adjustments exactly', () => {
    const result = validateCalculationInput(validInput());
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid input');
    expect(result.mappedAccounts.find((row) => row.accountId === 'account-zero-fixed-asset')?.amountHalalas).toBe('0');
  });

  it('accepts a zero carried-forward-loss balance without manufacturing a loss reconciliation', () => {
    const input = validInput();
    input.sourceBalances[0] = { ...input.sourceBalances[0], classification: 'carried_forward_loss', amountSar: '0.00', sign: 'zero' };
    input.declaredStatementTotals.equity = '0.00';
    expect(validateCalculationInput(input).valid).toBe(true);
  });

  it('rejects missing required inputs and unsupported contract versions', () => {
    expect(issueCodes({})).toEqual(expect.arrayContaining([
      'UNSUPPORTED_INPUT_VERSION', 'FISCAL_PERIOD_REQUIRED', 'SOURCE_BALANCES_REQUIRED',
      'DECLARED_STATEMENT_TOTALS_REQUIRED', 'ADJUSTMENTS_REQUIRED', 'FINALIZED_BOOK_RESULT_REQUIRED',
      'ADJUSTED_PROFIT_REQUIRED', 'ASSET_ALLOCATIONS_REQUIRED', 'DECLARED_ASSET_TOTALS_REQUIRED',
      'REGULATORY_REFERENCES_REQUIRED',
    ]));
    const input = validInput();
    input.version = 'zakat-calculation-input.v99' as typeof input.version;
    expect(issueCodes(input)).toContain('UNSUPPORTED_INPUT_VERSION');
  });

  it.each([1.23, '1.234', '1,000.00', '1e3', '+1.00', '01.00', 'NaN', ''])('rejects invalid monetary value %s', (amountSar) => {
    const input = validInput();
    input.sourceBalances[0].amountSar = amountSar as string;
    expect(issueCodes(input)).toContain('INVALID_SAR_AMOUNT');
  });

  it('rejects a sign inconsistent with the supplied signed source amount', () => {
    const input = validInput();
    input.sourceBalances[0].sign = 'negative';
    expect(issueCodes(input)).toContain('BALANCE_SIGN_MISMATCH');
  });

  it('blocks negative retained earnings instead of inferring a carried-forward loss', () => {
    const input = validInput();
    input.sourceBalances[0] = {
      ...input.sourceBalances[0], classification: 'retained_earnings', amountSar: '-5000.00', sign: 'negative',
    };
    input.declaredStatementTotals.equity = '-5000.00';
    expect(issueCodes(input)).toContain('CARRIED_FORWARD_LOSS_NOT_RECONCILED');
  });

  it('accepts negative retained earnings only with a matching evidenced Article 39 reconciliation', () => {
    const input = validInput();
    input.sourceBalances[0] = { ...input.sourceBalances[0], classification: 'retained_earnings', amountSar: '-5000.00', sign: 'negative', carriedForwardLossReconciliationId: 'loss-rec' };
    input.declaredStatementTotals.equity = '-5000.00';
    input.carriedForwardLossReconciliations = [{ reconciliationId: 'loss-rec', accountId: 'account-equity', openingLossSar: '4000.00', currentPeriodLossSar: '1000.00', otherMovementsSar: '0.00', closingLossSar: '5000.00', sourceReference: sourceReference('loss-rollforward'), evidence: evidence('loss-proof'), regulatoryDecisionReferenceId: 'decision-B0' }];
    expect(validateCalculationInput(input).valid).toBe(true);
  });

  it('requires adjusted profit to reconcile exactly to the finalized book result and signed adjustments', () => {
    const input = validInput();
    input.adjustedProfit.amountSar = '-999.99';
    expect(issueCodes(input)).toContain('ADJUSTED_PROFIT_RECONCILIATION_MISMATCH');
  });

  it('blocks recognized classifications whose component treatment is unresolved', () => {
    const input = validInput();
    input.sourceBalances[0] = { ...input.sourceBalances[0], classification: 'carried_forward_loss' };
    expect(issueCodes(input)).toContain('CARRIED_FORWARD_LOSS_NOT_RECONCILED');
  });

  it('rejects unknown classifications, category mismatches, and duplicate account mappings', () => {
    const unknown = validInput();
    unknown.sourceBalances[0].classification = 'made_up' as typeof unknown.sourceBalances[0]['classification'];
    expect(issueCodes(unknown)).toContain('UNSUPPORTED_CLASSIFICATION');

    const mismatch = validInput();
    mismatch.sourceBalances[0].statementCategory = 'current_asset';
    expect(issueCodes(mismatch)).toContain('CLASSIFICATION_CATEGORY_MISMATCH');

    const duplicate = validInput();
    duplicate.sourceBalances.push({ ...duplicate.sourceBalances[0] });
    expect(issueCodes(duplicate)).toContain('DUPLICATE_ACCOUNT_MAPPING');
  });

  it('rejects missing classification evidence and missing source traceability', () => {
    const input = validInput();
    input.sourceBalances[1].evidence = [];
    expect(issueCodes(input)).toContain('CLASSIFICATION_EVIDENCE_REQUIRED');

    const noAccountDecision = validInput();
    noAccountDecision.sourceBalances[0].regulatoryDecisionReferenceIds = [];
    expect(issueCodes(noAccountDecision)).toContain('ACCOUNT_DECISION_REFERENCE_REQUIRED');

    const noSource = validInput();
    (noSource.sourceBalances[0] as unknown as Record<string, unknown>).sourceReference = null;
    expect(issueCodes(noSource)).toContain('SOURCE_REFERENCE_REQUIRED');
  });

  it('rejects duplicate adjustment IDs, unsupported categories, negative amounts, and missing decisions', () => {
    const duplicate = validInput();
    duplicate.adjustments.push({ ...duplicate.adjustments[0] });
    expect(issueCodes(duplicate)).toContain('DUPLICATE_ADJUSTMENT');

    const unsupported = validInput();
    (unsupported.adjustments[0] as unknown as Record<string, unknown>).category = 'unknown';
    expect(issueCodes(unsupported)).toContain('UNSUPPORTED_ADJUSTMENT_CATEGORY');

    const negative = validInput();
    negative.adjustments[0].amountSar = '-0.01';
    expect(issueCodes(negative)).toContain('NEGATIVE_AMOUNT_NOT_ALLOWED');

    const noDecision = validInput();
    noDecision.adjustments[0].regulatoryDecisionReferenceId = 'missing-decision';
    expect(issueCodes(noDecision)).toContain('INVALID_ADJUSTMENT_DECISION_REFERENCE');

    const noEvidence = validInput();
    noEvidence.adjustments[0].evidence = [];
    expect(issueCodes(noEvidence)).toContain('ADJUSTMENT_EVIDENCE_REQUIRED');

    const untypedArticle63 = validInput();
    untypedArticle63.adjustments[0].amountSar = '1.00';
    expect(issueCodes(untypedArticle63)).toContain('ARTICLE63_BASIS_REQUIRED');

    const noGateReview = validInput();
    delete (noGateReview.regulatoryDecisionReferences[0] as Partial<typeof noGateReview.regulatoryDecisionReferences[0]>).reviewAttestation;
    expect(issueCodes(noGateReview)).toContain('REVIEW_ATTESTATION_REQUIRED');

    const noAssetReview = validInput();
    delete (noAssetReview.deductibleAssetCandidates[0] as Partial<typeof noAssetReview.deductibleAssetCandidates[0]>).reviewAttestation;
    expect(issueCodes(noAssetReview)).toContain('REVIEW_ATTESTATION_REQUIRED');

    const other = validInput();
    other.adjustments[0].category = 'other';
    expect(issueCodes(other)).toContain('UNRESOLVED_ADJUSTMENT_CATEGORY');
  });

  it('blocks unresolved or absent regulatory decision references without changing gate state', () => {
    const pending = validInput();
    pending.regulatoryDecisionReferences = decisionReferences('pending');
    expect(issueCodes(pending)).toContain('REGULATORY_DECISION_PENDING');

    const missing = validInput();
    missing.regulatoryDecisionReferences = missing.regulatoryDecisionReferences.filter((row) => row.gate !== 'B0');
    expect(issueCodes(missing)).toContain('REGULATORY_DECISION_REFERENCE_REQUIRED');
  });

  it('rejects mismatched fiscal days and invalid dates', () => {
    const mismatch = validInput();
    mismatch.fiscalPeriod.actualDays = 366;
    expect(issueCodes(mismatch)).toContain('FISCAL_DAY_COUNT_MISMATCH');

    const invalid = validInput();
    invalid.fiscalPeriod.startDate = '2027-02-30';
    expect(issueCodes(invalid)).toContain('INVALID_FISCAL_DATE');

    const shortUnresolved = validInput();
    shortUnresolved.fiscalPeriod.endDate = '2027-12-19';
    shortUnresolved.fiscalPeriod.actualDays = 353;
    shortUnresolved.fiscalPeriod.activityPeriod = 'regular';
    expect(issueCodes(shortUnresolved)).toContain('ARTICLE15_SHORT_PERIOD_CONTEXT_UNRESOLVED');

    const shortCessation = validInput();
    shortCessation.fiscalPeriod.endDate = '2027-12-19';
    shortCessation.fiscalPeriod.actualDays = 353;
    shortCessation.fiscalPeriod.activityPeriod = 'cessation';
    expect(validateCalculationInput(shortCessation).valid).toBe(true);
  });

  it('requires finalized book results and never infers actual Zakat or tax charges', () => {
    const draft = validInput();
    draft.finalizedBookResult.status = 'draft';
    draft.finalizedBookResult.includesActuallyRecordedZakatAndTax = false;
    expect(issueCodes(draft)).toEqual(expect.arrayContaining(['BOOK_RESULT_NOT_FINALIZED', 'ACTUAL_RECORDED_CHARGES_REQUIRED']));
  });

  it('requires a typed Article 63 basis and caller-supplied review record for nonzero profit adjustments', () => {
    const missingBasis = validInput();
    missingBasis.adjustments[0].amountSar = '1.00';
    expect(issueCodes(missingBasis)).toContain('ARTICLE63_BASIS_REQUIRED');

    const reviewed = validInput();
    reviewed.adjustments[0].amountSar = '1.00';
    reviewed.adjustments[0].article63ExpenseCategory = 'current_year_provision';
    reviewed.adjustments[0].reviewAttestation = review('article63-adjustment');
    reviewed.adjustedProfit.amountSar = '-999.00';
    expect(validateCalculationInput(reviewed).valid).toBe(true);

    delete (reviewed.adjustments[0] as Partial<typeof reviewed.adjustments[0]>).reviewAttestation;
    expect(issueCodes(reviewed)).toContain('REVIEW_ATTESTATION_REQUIRED');
  });

  it('rejects duplicate or excessive asset allocations and inconsistent declared totals', () => {
    const duplicate = validInput();
    duplicate.deductibleAssetCandidates.push({
      accountId: 'account-bank', amountSar: '0.00', eligibilityStatus: 'verified', sourceReference: sourceReference('duplicate-allocation'),
      evidence: evidence('duplicate-allocation-proof'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('duplicate-allocation'),
    });
    expect(issueCodes(duplicate)).toContain('DUPLICATE_ASSET_ALLOCATION');

    const excess = validInput();
    excess.deductibleAssetCandidates[0].amountSar = '5000.01';
    expect(issueCodes(excess)).toContain('ASSET_ALLOCATION_EXCEEDS_SOURCE');

    const totals = validInput();
    totals.declaredAssetTotals.deductibleCandidateSar = '4999.99';
    expect(issueCodes(totals)).toContain('ASSET_TOTAL_MISMATCH');
  });

  it('rejects inconsistent signed account totals and requires all statement categories', () => {
    const mismatch = validInput();
    mismatch.declaredStatementTotals.current_asset = '5000.01';
    expect(issueCodes(mismatch)).toContain('STATEMENT_TOTAL_MISMATCH');

    const missingCategory = validInput();
    delete (missingCategory.declaredStatementTotals as Partial<typeof missingCategory.declaredStatementTotals>).equity;
    expect(issueCodes(missingCategory)).toContain('INVALID_SAR_AMOUNT');
    expect(STATEMENT_CATEGORIES).toHaveLength(5);
  });
});
