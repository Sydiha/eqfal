import { describe, expect, it } from 'vitest';
import { ZAKAT_CALCULATION_INPUT_VERSION, type ZakatCalculationInputV1 } from '../src/modules/zakat-calculation/calculation-input';
import { calculateZakatBase } from '../src/modules/zakat-calculation/zakat-base-engine';

const src = (recordId: string) => ({ source: 'synthetic-ledger', recordId });
const ev = (referenceId: string) => [{ referenceId, kind: 'accounting_record' as const }];
const review = (recordId: string) => ({ reviewerReference: src(`reviewer-${recordId}`), reviewedAt: '2026-01-01T00:00:00.000Z', evidence: ev(`review-${recordId}`) });
const gates = () => (['B0', 'B3', 'B4', 'B7', 'B9'] as const).map((gate) => ({
  gate, referenceId: `decision-${gate}`, sourceReference: src(`decision-${gate}`), disposition: 'decision_recorded' as const, reviewAttestation: review(`gate-${gate}`),
}));

function input(): ZakatCalculationInputV1 {
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
      { accountId: 'property', amountSar: '80.00', eligibilityStatus: 'verified', sourceReference: src('property-deduction'), evidence: ev('property-deduction-proof'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('property-deductible') },
    ],
    undeductedAssets: [
      { accountId: 'cash', amountSar: '80.00', eligibilityStatus: 'verified', sourceReference: src('cash-undeducted'), evidence: ev('cash-undeducted-proof'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('cash-undeducted') },
      { accountId: 'property', amountSar: '20.00', eligibilityStatus: 'verified', sourceReference: src('property-undeducted'), evidence: ev('property-undeducted-proof'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('property-undeducted') },
    ],
    declaredAssetTotals: { deductibleCandidateSar: '100.00', undeductedSar: '100.00' },
    article73Assessment: { reviewed: true, sourceReference: src('art73-review'), evidence: ev('art73-review-proof'), reviewAttestation: review('article73'), regulatoryDecisionReferenceId: 'decision-B0', projects: [] },
    regulatoryDecisionReferences: gates(),
  };
}

const codes = (result: ReturnType<typeof calculateZakatBase>) => result.blockers.map((b) => b.code);
function zeroLiabilities(data: ZakatCalculationInputV1): void {
  data.sourceBalances = data.sourceBalances.map((row) => row.statementCategory === 'current_liability' || row.statementCategory === 'non_current_liability'
    ? { ...row, amountSar: '0.00', sign: 'zero' }
    : row);
  data.declaredStatementTotals.current_liability = '0.00';
  data.declaredStatementTotals.non_current_liability = '0.00';
}

describe('isolated end-to-end Zakat base engine', () => {
  it('blocks an unauthenticated Article 15(4) cessation claim without a base or payable amount', () => {
    const data = input();
    data.fiscalPeriod.endDate = '2027-12-19';
    data.fiscalPeriod.actualDays = 353;
    data.fiscalPeriod.activityPeriod = 'cessation';
    const result = calculateZakatBase(data);
    expect(result.status).toBe('BLOCKED');
    expect(result.exemptionCode).toBeNull();
    expect(codes(result)).toContain('ARTICLE15_CESSATION_EVIDENCE_NOT_AUTHENTICATED');
    expect(result.finalZakatBaseHalalas).toBeNull();
    expect(result.payableAmountHalalas).toBeNull();
    expect(result.inputAssertionsAuthenticated).toBe(false);
  });

  it('blocks when Article 25(4) and Article 29(2)(b) liability totals exceed the unresolved aggregate cap', () => {
    const result = calculateZakatBase(input());
    expect(result.status).toBe('BLOCKED');
    expect(codes(result)).toContain('B4_AGGREGATE_LIABILITY_INTERACTION_UNRESOLVED');
    expect(result.finalZakatBaseHalalas).toBeNull();
    expect(result.payableAmountHalalas).toBeNull();
  });

  it('traces an under-cap Article 29 residual while withholding the final result', () => {
    const data = input();
    data.sourceBalances = data.sourceBalances.filter((row) => row.accountId !== 'loan');
    data.declaredStatementTotals.non_current_liability = '0.00';
    data.sourceBalances.find((row) => row.accountId === 'ap')!.amountSar = '120.00';
    const result = calculateZakatBase(data);
    expect(codes(result)).toContain('REGULATORY_GATE_AUTHENTICATION_REQUIRED');
    expect(result.status).toBe('BLOCKED');
    const liabilities = result.liabilityProcedure!.finalLiabilityAdditionsHalalas;
    expect(liabilities).toEqual({ numerator: '4000', denominator: '1' });
    expect(result.inputAssertionsAuthenticated).toBe(false);
    expect(result.liabilityProcedure?.allocationPolicy).toBe('proportional_internal_traceability_only');
  });

  it('preserves fractional halalas through Article 25 allocation without intermediate rounding', () => {
    const data = input();
    data.sourceBalances = [
      { ...data.sourceBalances[0], amountSar: '3.00' },
      { ...data.sourceBalances[2], amountSar: '1.00' },
      { ...data.sourceBalances[4], amountSar: '100.00', sign: 'positive' },
    ];
    data.declaredStatementTotals = { current_asset: '3.00', non_current_asset: '0.00', current_liability: '1.00', non_current_liability: '0.00', equity: '100.00' };
    data.deductibleAssetCandidates = [{ accountId: 'cash', amountSar: '1.00', eligibilityStatus: 'verified', sourceReference: src('cash-deductible'), evidence: ev('cash-deductible'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('cash-deductible') }];
    data.undeductedAssets = [{ accountId: 'cash', amountSar: '2.00', eligibilityStatus: 'verified', sourceReference: src('cash-undeducted'), evidence: ev('cash-undeducted'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('cash-undeducted') }];
    data.declaredAssetTotals = { deductibleCandidateSar: '1.00', undeductedSar: '2.00' };
    const result = calculateZakatBase(data);
    expect(result.status).toBe('BLOCKED');
    expect(result.liabilityProcedure?.step4Article25CurrentAddedHalalas).toEqual({ numerator: '100', denominator: '3' });
  });

  it('records evidence-backed current-to-noncurrent and partner-loan-to-equity reclassifications', () => {
    const current = input();
    current.sourceBalances = current.sourceBalances.filter((row) => row.accountId !== 'loan');
    current.declaredStatementTotals.non_current_liability = '0.00';
    current.liabilityReclassifications = [{ reclassificationId: 'renewed-ap', accountId: 'ap', amountSar: '50.00', treatment: 'current_to_non_current', confirmed: true, currentDebtFacts: { sameCreditor: true, samePurpose: true, renewedOrRescheduled: true }, sourceReference: src('renewal'), evidence: ev('renewal-agreement'), regulatoryDecisionReferenceId: 'decision-B4' }];
    const currentResult = calculateZakatBase(current);
    expect(currentResult.status).toBe('BLOCKED');
    expect(currentResult.liabilityProcedure?.step2CurrentToNonCurrentReclassifiedHalalas).toEqual({ numerator: '5000', denominator: '1' });

    const partnerLoan = input();
    partnerLoan.sourceBalances = partnerLoan.sourceBalances.filter((row) => row.accountId !== 'ap');
    partnerLoan.declaredStatementTotals.current_liability = '0.00';
    partnerLoan.sourceBalances.find((row) => row.accountId === 'loan')!.amountSar = '50.00';
    partnerLoan.sourceBalances.find((row) => row.accountId === 'loan')!.classification = 'partner_loan_credit_liability';
    partnerLoan.declaredStatementTotals.non_current_liability = '50.00';
    partnerLoan.liabilityReclassifications = [{ reclassificationId: 'partner-loan-equity', accountId: 'loan', amountSar: '50.00', treatment: 'partner_loan_to_equity', confirmed: true, partnerLoanFacts: { entityType: 'non_listed_capital_company', auditedFinancialStatements: true, classifiedAsLiability: true, repaymentTermDefined: false, returnAtMarketRate: true, singleOwnerControl: false }, sourceReference: src('partner-loan'), evidence: ev('loan-agreement-and-resolution'), regulatoryDecisionReferenceId: 'decision-B4' }];
    const equityResult = calculateZakatBase(partnerLoan);
    expect(equityResult.status).toBe('BLOCKED');
    expect(equityResult.liabilityProcedure?.step3PartnerLoansReclassifiedToEquityHalalas).toEqual({ numerator: '5000', denominator: '1' });

    current.liabilityReclassifications[0].currentDebtFacts!.samePurpose = false;
    expect(codes(calculateZakatBase(current))).toContain('CURRENT_DEBT_RECLASSIFICATION_NOT_ELIGIBLE');
    partnerLoan.liabilityReclassifications[0].partnerLoanFacts!.repaymentTermDefined = true;
    expect(codes(calculateZakatBase(partnerLoan))).toContain('PARTNER_LOAN_QUALIFIES_AS_LIABILITY');
  });

  it('treats EOSB and statutory-leave provisions as noncurrent under Article 24 regardless of current classification', () => {
    const data = input();
    data.sourceBalances = data.sourceBalances.filter((row) => row.accountId !== 'ap' && row.accountId !== 'loan');
    data.declaredStatementTotals.current_liability = '10.00';
    data.declaredStatementTotals.non_current_liability = '0.00';
    data.sourceBalances.push({ accountId: 'eosb', statementCategory: 'current_liability', classification: 'provision_eosb_leave', amountSar: '10.00', sign: 'positive', sourceReference: src('eosb'), evidence: ev('eosb-ledger'), regulatoryDecisionReferenceIds: ['decision-B4'] });
    const result = calculateZakatBase(data);
    expect(result.status).toBe('BLOCKED');
    expect(result.liabilityProcedure?.step1NonCurrentLiabilitiesHalalas).toEqual({ numerator: '1000', denominator: '1' });
  });

  it('applies Article 27 minimum, applies Article 28 maximum, and blocks a floor-ceiling conflict', () => {
    const data = input();
    data.sourceBalances = [
      { ...data.sourceBalances[0], amountSar: '250.00' },
      { ...data.sourceBalances[4], amountSar: '200.00', sign: 'positive' },
    ];
    data.declaredStatementTotals = { current_asset: '250.00', non_current_asset: '0.00', current_liability: '0.00', non_current_liability: '0.00', equity: '200.00' };
    data.deductibleAssetCandidates[0].amountSar = '100.00';
    data.deductibleAssetCandidates = [data.deductibleAssetCandidates[0]];
    data.undeductedAssets = [{ accountId: 'cash', amountSar: '150.00', eligibilityStatus: 'verified', sourceReference: src('cash-undeducted'), evidence: ev('cash-undeducted-proof'), regulatoryDecisionReferenceId: 'decision-B4', reviewAttestation: review('cash-undeducted') }];
    data.declaredAssetTotals = { deductibleCandidateSar: '100.00', undeductedSar: '150.00' };
    data.finalizedBookResult.amountSar = '190.00';
    data.adjustedProfit.amountSar = '200.00';
    data.adjustments = [{ adjustmentId: 'profit-adjustment', category: 'profit', direction: 'add', amountSar: '10.00', sourceReference: src('profit-adjustment'), evidence: ev('profit-adjustment-proof'), regulatoryDecisionReferenceId: 'decision-B7', article63ExpenseCategory: 'current_year_provision', reviewAttestation: review('profit-adjustment') }];
    // Ordinary base 11,000 SAR; statutory floor = min(15,000 + 1,000, 20,000) = 16,000;
    // Article 28 ceiling = 20,000 + 1,000 = 21,000, so the floor is accepted.
    const floor = calculateZakatBase(data);
    expect(floor.status).toBe('BLOCKED');
    expect(floor.ordinaryBaseBeforeLimitsHalalas).toEqual({ numerator: '11000', denominator: '1' });
    expect(floor.article27MinimumAppliedHalalas).toEqual({ numerator: '16000', denominator: '1' });
    expect(floor.finalZakatBaseHalalas).toBeNull();

    data.sourceBalances[1].amountSar = '140.00';
    data.declaredStatementTotals.equity = '140.00';
    const conflict = calculateZakatBase(data);
    expect(conflict.status).toBe('BLOCKED');
    expect(codes(conflict)).toContain('ARTICLE27_ARTICLE28_LIMIT_CONFLICT');
  });

  it('applies the Article 28 ceiling using closing equity, excluding an explicitly unreflected base adjustment', () => {
    const data = input();
    zeroLiabilities(data);
    data.sourceBalances.find((row) => row.accountId === 'capital')!.amountSar = '200.00';
    data.sourceBalances.find((row) => row.accountId === 'capital')!.sign = 'positive';
    data.declaredStatementTotals.equity = '200.00';
    data.adjustments = [{ adjustmentId: 'unreflected-equity-addition', category: 'equity', direction: 'add', amountSar: '5000.00', sourceReference: src('equity-adjustment'), evidence: ev('equity-adjustment-proof'), regulatoryDecisionReferenceId: 'decision-B0', includedInArticle28ClosingEquity: false }];
    const result = calculateZakatBase(data);
    expect(codes(result)).toContain('REGULATORY_GATE_AUTHENTICATION_REQUIRED');
    expect(result.status).toBe('BLOCKED');
    expect(result.ordinaryBaseBeforeLimitsHalalas).toEqual({ numerator: '510000', denominator: '1' });
    expect(result.article28MaximumHalalas).toEqual({ numerator: '20000', denominator: '1' });
    expect(result.finalZakatBaseHalalas).toBeNull();
  });

  it('uses only reconciled Article 39 closing losses and blocks a mismatched rollforward', () => {
    const data = input();
    data.sourceBalances = [{ ...data.sourceBalances[4], amountSar: '-25.00', sign: 'negative', classification: 'carried_forward_loss', carriedForwardLossReconciliationId: 'loss-rec' }];
    data.declaredStatementTotals = { current_asset: '0.00', non_current_asset: '0.00', current_liability: '0.00', non_current_liability: '0.00', equity: '-25.00' };
    data.deductibleAssetCandidates = [];
    data.undeductedAssets = [];
    data.declaredAssetTotals = { deductibleCandidateSar: '0.00', undeductedSar: '0.00' };
    data.carriedForwardLossReconciliations = [{ reconciliationId: 'loss-rec', accountId: 'capital', openingLossSar: '20.00', currentPeriodLossSar: '5.00', otherMovementsSar: '0.00', closingLossSar: '25.00', sourceReference: src('loss-rec'), evidence: ev('loss-rollforward'), regulatoryDecisionReferenceId: 'decision-B0' }];
    const accepted = calculateZakatBase(data);
    expect(accepted.status).toBe('BLOCKED');
    expect(accepted.finalZakatBaseHalalas).toBeNull();
    data.carriedForwardLossReconciliations[0].closingLossSar = '24.00';
    const blocked = calculateZakatBase(data);
    expect(blocked.status).toBe('BLOCKED');
    expect(codes(blocked)).toContain('CARRIED_LOSS_ROLLFORWARD_MISMATCH');
  });

  it('uses finalized book result after only evidenced, actually recorded charges', () => {
    const data = input();
    zeroLiabilities(data);
    data.finalizedBookResult.actuallyRecordedCharges = [{ chargeId: 'zakat-prov', kind: 'zakat_provision', amountSar: '6.00', includedInFinalizedBookResult: true, sourceReference: src('zakat-prov'), evidence: ev('posted-provision') }];
    expect(calculateZakatBase(data).status).toBe('BLOCKED');
    data.finalizedBookResult.actuallyRecordedCharges[0].includedInFinalizedBookResult = false as never;
    expect(codes(calculateZakatBase(data))).toContain('RECORDED_CHARGE_NOT_IN_BOOK_RESULT');
  });

  it('blocks generic Article 63 adjustments and exposes review claims as unauthenticated', () => {
    const data = input();
    zeroLiabilities(data);
    data.adjustments = [{ adjustmentId: 'unsupported-profit-adjustment', category: 'profit', direction: 'add', amountSar: '1.00', sourceReference: src('profit-adjustment'), evidence: ev('profit-adjustment-proof'), regulatoryDecisionReferenceId: 'decision-B7' }];
    data.adjustedProfit.amountSar = '1.00';
    const blocked = calculateZakatBase(data);
    expect(blocked.status).toBe('BLOCKED');
    expect(codes(blocked)).toContain('ARTICLE63_BASIS_REQUIRED');
    expect(blocked.payableAmountHalalas).toBeNull();

    data.adjustments[0].article63ExpenseCategory = 'current_year_provision';
    data.adjustments[0].reviewAttestation = review('supported-profit-adjustment');
    const reviewed = calculateZakatBase(data);
    expect(reviewed.status).toBe('BLOCKED');
    expect(reviewed.inputAssertionsAuthenticated).toBe(false);
  });

  it('checks Article 73 project conditions and 25 percent boundary without inferring eligibility', () => {
    const data = input();
    zeroLiabilities(data);
    data.article73Assessment.projects = [{ projectId: 'project-1', accountId: 'property', treatment: 'construction_sale_after_completion', licensedForOffPlanSale: false, isUnderConstruction: true, intendedForSaleAfterCompletion: true, offeredForSaleAsIs: false, statementCategory: 'non_current_asset', openingBalanceSar: '50.00', additionsSar: '50.00', costOfSalesSar: '25.00', otherMovementsSar: '25.00', closingBalanceSar: '100.00', sourceReference: src('project'), evidence: ev('project-facts') }];
    data.deductibleAssetCandidates[1].amountSar = '100.00';
    data.undeductedAssets[1].amountSar = '0.00';
    data.declaredAssetTotals = { deductibleCandidateSar: '120.00', undeductedSar: '80.00' };
    const boundary = calculateZakatBase(data);
    expect(boundary.status).toBe('BLOCKED');
    expect(boundary.article73ProjectEvaluations[0].eligibleForDeduction).toBe(true); // exactly 25%
    data.article73Assessment.projects[0].costOfSalesSar = '50.02';
    const blocked = calculateZakatBase(data);
    expect(blocked.status).toBe('BLOCKED');
    expect(codes(blocked)).toContain('ARTICLE_73_DEDUCTION_ALLOCATION_MISMATCH');
    data.article73Assessment.projects[0].treatment = 'licensed_off_plan_sale';
    data.article73Assessment.projects[0].licensedForOffPlanSale = true;
    data.sourceBalances[1].amountSar = '70.00';
    data.sourceBalances.push({ accountId: 'offplan-current', statementCategory: 'current_asset', classification: 'deductible_spare_or_raw_material', amountSar: '30.00', sign: 'positive', sourceReference: src('offplan-current'), evidence: ev('offplan-current-proof'), regulatoryDecisionReferenceIds: ['decision-B0'] });
    data.declaredStatementTotals.current_asset = '130.00';
    data.declaredStatementTotals.non_current_asset = '70.00';
    data.deductibleAssetCandidates[1].amountSar = '70.00';
    data.deductibleAssetCandidates.push({ accountId: 'offplan-current', amountSar: '10.00', eligibilityStatus: 'verified', sourceReference: src('offplan-current-deduction'), evidence: ev('offplan-current-deduction-proof'), regulatoryDecisionReferenceId: 'decision-B0', reviewAttestation: review('offplan-current-deduction') });
    data.undeductedAssets[1].amountSar = '0.00';
    data.undeductedAssets.push({ accountId: 'offplan-current', amountSar: '20.00', eligibilityStatus: 'verified', sourceReference: src('offplan-current-undeducted'), evidence: ev('offplan-current-undeducted-proof'), regulatoryDecisionReferenceId: 'decision-B0', reviewAttestation: review('offplan-current-undeducted') });
    data.declaredAssetTotals = { deductibleCandidateSar: '100.00', undeductedSar: '100.00' };
    data.article73Assessment.projects = [
      { ...data.article73Assessment.projects[0], openingBalanceSar: '0.00', additionsSar: '20.00', costOfSalesSar: '0.00', otherMovementsSar: '0.00', closingBalanceSar: '70.00' },
      { ...data.article73Assessment.projects[0], accountId: 'offplan-current', statementCategory: 'current_asset', openingBalanceSar: '0.00', additionsSar: '0.00', costOfSalesSar: '0.00', otherMovementsSar: '0.00', closingBalanceSar: '30.00', sourceReference: src('offplan-current-facts'), evidence: ev('offplan-current-facts-proof') },
    ];
    const offPlan = calculateZakatBase(data);
    expect(offPlan.status).toBe('BLOCKED');
    expect(offPlan.article73ProjectEvaluations[0].treatment).toBe('licensed_off_plan_sale');
    expect(offPlan.article73ProjectEvaluations[0].calculatedDeductionHalalas).toEqual({ numerator: '8000', denominator: '1' });
  });

  it('withholds final payable rounding while the policy remains provisional', () => {
    const data = input();
    data.sourceBalances = [{ ...data.sourceBalances[4], amountSar: '100.20', sign: 'positive' }];
    data.declaredStatementTotals = { current_asset: '0.00', non_current_asset: '0.00', current_liability: '0.00', non_current_liability: '0.00', equity: '100.20' };
    data.deductibleAssetCandidates = [];
    data.undeductedAssets = [];
    data.declaredAssetTotals = { deductibleCandidateSar: '0.00', undeductedSar: '0.00' };
    data.finalizedBookResult.amountSar = '0.00';
    data.adjustedProfit.amountSar = '0.00';
    const result = calculateZakatBase(data);
    expect(result.status).toBe('BLOCKED');
    expect(result.finalZakatBaseHalalas).toBeNull();
    expect(result.payableRounding).toBeNull();
    expect(result.payableAmountHalalas).toBeNull();
  });

  it('blocks pending gates and unresolved asset/reclassification facts', () => {
    const pending = input();
    pending.regulatoryDecisionReferences[0].disposition = 'pending';
    expect(codes(calculateZakatBase(pending))).toContain('REGULATORY_DECISION_PENDING');
    const missingArticle73 = input();
    (missingArticle73 as unknown as Record<string, unknown>).article73Assessment = undefined;
    expect(codes(calculateZakatBase(missingArticle73))).toContain('ARTICLE_73_ASSESSMENT_REQUIRED');
  });
});
