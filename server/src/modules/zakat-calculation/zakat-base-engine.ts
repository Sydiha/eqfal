/**
 * Isolated end-to-end Zakat base engine. It consumes only the validated, versioned contract and
 * has no worksheet, API, persistence, tenant, or UI dependencies. Rounding is applied only to the
 * final payable amount and is explicitly provisional EQFAL policy.
 */
import type { PoolClient } from 'pg';
import {
  validateCalculationInput,
  type EvidenceReference,
  type InputIssue,
  type SourceReference,
  type ZakatCalculationInputV1,
} from './calculation-input';
import {
  calculatePeriodZakatFromExactHalalas,
  parseSarToHalalas,
  PROVISIONAL_DEFAULT_CALCULATION_OPTIONS,
  type CalculationOptions,
  type ExactHalalas,
} from './zakat-calculation';
import { composeZakatBaseComponents } from './zakat-base-composition';

type Rational = { n: bigint; d: bigint };
const ZERO: Rational = { n: 0n, d: 1n };
const abs = (n: bigint) => n < 0n ? -n : n;
function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a); let y = abs(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x || 1n;
}
function rat(n: bigint, d = 1n): Rational {
  if (d === 0n) throw new Error('zero rational denominator');
  const sign = d < 0n ? -1n : 1n;
  const divisor = gcd(n, d);
  return { n: n / divisor * sign, d: abs(d) / divisor };
}
const add = (a: Rational, b: Rational): Rational => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Rational, b: Rational): Rational => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Rational, b: Rational): Rational => rat(a.n * b.n, a.d * b.d);
const div = (a: Rational, b: Rational): Rational => rat(a.n * b.d, a.d * b.n);
const cmp = (a: Rational, b: Rational): number => {
  const diff = a.n * b.d - b.n * a.d;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
};
const min = (a: Rational, b: Rational): Rational => cmp(a, b) <= 0 ? a : b;
const max = (a: Rational, b: Rational): Rational => cmp(a, b) >= 0 ? a : b;
const maxZero = (a: Rational): Rational => max(a, ZERO);
const fromSar = (value: string, path: string): Rational => rat(parseSarToHalalas(value, path));
const serialize = (value: Rational): ExactHalalas => ({ numerator: value.n.toString(), denominator: value.d.toString() });
const json = (value: Rational): string => `${value.n}/${value.d}`;

export type LiabilityTraceLine = {
  accountId: string;
  stage: 'article25_current' | 'article25_non_current' | 'article29_current_surplus';
  originalLiabilityHalalas: string;
  candidateAdditionHalalas: ExactHalalas;
  finalAddedHalalas: ExactHalalas;
  sourceReferences: SourceReference[];
  evidence: EvidenceReference[];
  regulatoryDecisionReferenceIds: string[];
  allocationPolicy: 'proportional_internal_traceability_only';
};

export type LiabilityProcedure = {
  step1NonCurrentLiabilitiesHalalas: ExactHalalas;
  step2CurrentToNonCurrentReclassifiedHalalas: ExactHalalas;
  step3PartnerLoansReclassifiedToEquityHalalas: ExactHalalas;
  step4Article25CurrentAddedHalalas: ExactHalalas;
  step4Article25NonCurrentExcludedHalalas: ExactHalalas;
  step4Article25NonCurrentRemainingHalalas: ExactHalalas;
  step5AggregateCapHalalas: ExactHalalas;
  step5AdditionsAfterAggregateCapHalalas: ExactHalalas;
  step6Article29SurplusCandidateHalalas: ExactHalalas;
  finalLiabilityAdditionsHalalas: ExactHalalas;
  accountAllocations: LiabilityTraceLine[];
  allocationPolicy: 'proportional_internal_traceability_only';
};

export type BaseEngineBlocker = Pick<InputIssue, 'code' | 'path' | 'message' | 'disposition'>;
export type BaseEngineTraceLine = {
  id: string;
  component: string;
  amountHalalas: ExactHalalas;
  sourceReferences: SourceReference[];
  evidence: EvidenceReference[];
  regulatoryDecisionReferenceIds: string[];
};
export type Article73ProjectEvaluation = {
  projectId: string;
  accountId: string;
  treatment: 'construction_sale_after_completion' | 'licensed_off_plan_sale';
  costOfSalesRatio: { numerator: string; denominator: string } | null;
  calculatedDeductionHalalas: ExactHalalas;
  eligibleForDeduction: boolean;
  sourceReference: SourceReference;
  evidence: EvidenceReference[];
};
export type BaseEngineResult = {
  status: 'BLOCKED' | 'READY' | 'EXEMPT';
  /** True only for the server workflow using approved registry evidence. */
  inputAssertionsAuthenticated: boolean;
  exemptionCode: string | null;
  finalZakatBaseHalalas: ExactHalalas | null;
  payableAmountHalalas: string | null;
  payableRounding: CalculationOptions['finalRounding'] | null;
  ordinaryBaseBeforeLimitsHalalas: ExactHalalas | null;
  article27MinimumAppliedHalalas: ExactHalalas | null;
  article28MaximumHalalas: ExactHalalas | null;
  liabilityProcedure: LiabilityProcedure | null;
  article73ProjectEvaluations: Article73ProjectEvaluation[];
  traceLines: BaseEngineTraceLine[];
  sourceReferences: SourceReference[];
  blockers: BaseEngineBlocker[];
};

type LiabilityEntry = {
  accountId: string;
  amount: Rational;
  sourceReference: SourceReference;
  evidence: EvidenceReference[];
  regulatoryDecisionReferenceIds: string[];
};

function blocked(issues: BaseEngineBlocker[]): BaseEngineResult {
  return {
    status: 'BLOCKED', inputAssertionsAuthenticated: false, exemptionCode: null, finalZakatBaseHalalas: null, payableAmountHalalas: null, payableRounding: null,
    ordinaryBaseBeforeLimitsHalalas: null, article27MinimumAppliedHalalas: null, article28MaximumHalalas: null,
    liabilityProcedure: null, article73ProjectEvaluations: [], traceLines: [], sourceReferences: [], blockers: issues,
  };
}
/** Account-level distribution is trace-only; statutory totals are calculated independently. */
function proportionalTraceAllocation(lines: { amount: Rational }[], aggregate: Rational): Rational[] {
  const total = lines.reduce((sum, line) => add(sum, line.amount), ZERO);
  if (total.n === 0n || cmp(total, aggregate) <= 0) return lines.map((line) => line.amount);
  const scale = div(aggregate, total);
  return lines.map((line) => mul(line.amount, scale));
}
function exemptArticle15Period(): BaseEngineResult {
  return {
    status: 'BLOCKED', inputAssertionsAuthenticated: false, exemptionCode: null, finalZakatBaseHalalas: null, payableAmountHalalas: null,
    payableRounding: null, ordinaryBaseBeforeLimitsHalalas: null, article27MinimumAppliedHalalas: null,
    article28MaximumHalalas: null, liabilityProcedure: null, article73ProjectEvaluations: [], traceLines: [],
    sourceReferences: [], blockers: [{
      code: 'ARTICLE15_CESSATION_EVIDENCE_NOT_AUTHENTICATED', path: 'fiscalPeriod.activityPeriod',
      message: 'A caller-supplied cessation assertion cannot establish a final Article 15(4) exemption.', disposition: 'blocked',
    }],
  };
}

/** Runs review arithmetic; caller assertions cannot authorize a final base or payable amount. */
export function calculateZakatBase(
  input: unknown,
  options: CalculationOptions = PROVISIONAL_DEFAULT_CALCULATION_OPTIONS,
): BaseEngineResult {
  return runBaseEngine(input, options, 'review');
}

/** Finalization verifies the worksheet and all five decisions inside the caller's database transaction. */
export async function calculateApprovedZakatBase(
  client: PoolClient, company: string, year: string, worksheet: string, actor: string | null,
  fingerprint: string, input: ZakatCalculationInputV1, options: CalculationOptions, currentEarningsHalalas: bigint,
): Promise<BaseEngineResult> {
  const scope = (await client.query<{ status: string; approved_by_user_id: string | null; prepared_by_user_id: string; reviewed_by_user_id: string | null }>(
    `SELECT w.status,w.approved_by_user_id,w.prepared_by_user_id,w.reviewed_by_user_id FROM zakat_worksheets w
     WHERE w.id=$1 AND w.company_id=$2 AND w.fiscal_year_id=$3 FOR SHARE`, [worksheet, company, year])).rows[0];
  if (!scope || !(scope.status === 'approved' || scope.status === 'reviewed' && actor)
    || scope.status === 'approved' && scope.approved_by_user_id !== actor && actor !== null
    || scope.status === 'reviewed' && (actor === scope.prepared_by_user_id || actor === scope.reviewed_by_user_id)) {
    return blocked([{ code: 'WORKSHEET_APPROVAL_REQUIRED', path: 'worksheet', message: 'A trusted worksheet approval context is required.', disposition: 'blocked' }]);
  }
  const decisions = (await client.query<{ gate: string; id: string; submitted_by: string }>(
    `SELECT d.gate,d.id,d.submitted_by FROM zakat_regulatory_decisions d
     JOIN documents e ON e.id=d.evidence_document_id AND e.company_id=d.company_id AND e.status='approved' AND e.sha256=d.evidence_sha256
     JOIN zakat_regulatory_reviewers a ON a.company_id=d.company_id AND a.user_id=d.reviewed_by AND a.appointment_reference=d.reviewer_appointment
     JOIN users u ON u.id=d.reviewed_by AND u.is_active
     WHERE d.company_id=$1 AND d.fiscal_year_id=$2 AND d.worksheet_id=$3 AND d.source_fingerprint=$4
       AND d.approved_at IS NOT NULL AND d.ended_at IS NULL FOR SHARE OF d,e`,
    [company, year, worksheet, fingerprint])).rows;
  const required = ['B0', 'B3', 'B4', 'B7', 'B9'];
  const actual = new Map(decisions.map((row) => [row.gate, row]));
  if (actual.size !== required.length || required.some((gate) => !actual.has(gate))
    || scope.status === 'reviewed' && decisions.some((row) => row.submitted_by === actor)
    || input.regulatoryDecisionReferences.length !== required.length
    || input.regulatoryDecisionReferences.some((row) => actual.get(row.gate)?.id !== row.referenceId)) {
    return blocked([{ code: 'REGULATORY_GATE_AUTHENTICATION_REQUIRED', path: 'regulatoryDecisionReferences', message: 'Current persisted decisions are required.', disposition: 'blocked' }]);
  }
  return runBaseEngine(input, options, 'approved', currentEarningsHalalas);
}

function runBaseEngine(
  input: unknown, options: CalculationOptions, mode: 'review' | 'validate' | 'approved', currentEarningsHalalas = 0n,
): BaseEngineResult {
  const authenticated = mode !== 'review';
  const validation = validateCalculationInput(input);
  if (!validation.valid) return blocked(validation.issues.map(({ code, path, message, disposition }) => ({ code, path, message, disposition })));
  const data = input as ZakatCalculationInputV1;
  const cessation = data.fiscalPeriod.actualDays < 354 && data.fiscalPeriod.activityPeriod === 'cessation';
  if (cessation && !authenticated) return exemptArticle15Period();
  const composed = composeZakatBaseComponents(data);
  const compositionBlockers = composed.blockers.filter((blocker) => blocker.code !== 'LIABILITY_CAPS_UNRESOLVED');
  if (!composed.totals || compositionBlockers.length > 0) {
    return blocked(compositionBlockers.length > 0 ? compositionBlockers : [{ code: 'BASE_COMPONENTS_UNAVAILABLE', path: 'input', message: 'Validated base component composition is unavailable.', disposition: 'blocked' }]);
  }
  const blockers: BaseEngineBlocker[] = [];
  const addBlocker = (code: string, path: string, message: string) => blockers.push({ code, path, message, disposition: 'blocked' });
  const accountRows = new Map(data.sourceBalances.map((row) => [row.accountId, row]));
  for (const adjustment of data.adjustments) {
    const amount = fromSar(adjustment.amountSar, `adjustments.${adjustment.adjustmentId}.amountSar`);
    if (amount.n === 0n) continue;
    if (adjustment.category === 'liability') addBlocker('UNSUPPORTED_LIABILITY_ADJUSTMENT', `adjustments.${adjustment.adjustmentId}`, 'Liability adjustments must be represented by validated Article 25/29 source liabilities and reclassification evidence.');
    if (adjustment.category === 'asset_deduction') addBlocker('UNSUPPORTED_ASSET_DEDUCTION_ADJUSTMENT', `adjustments.${adjustment.adjustmentId}`, 'Asset deductions must be represented by fully allocated, explicitly eligible source assets.');
  }
  const statement = Object.fromEntries(Object.entries(data.declaredStatementTotals).map(([key, value]) => [key, fromSar(value, `declaredStatementTotals.${key}`)])) as Record<string, Rational>;
  const mapped = validation.mappedAccounts;
  const liabilities: LiabilityEntry[] = mapped
    .filter((row) => row.component === 'current_liability_candidate' || row.component === 'non_current_liability_candidate')
    .map((row) => ({
      accountId: row.accountId,
      amount: rat(BigInt(row.amountHalalas)),
      sourceReference: row.sourceReference,
      evidence: row.evidence,
      regulatoryDecisionReferenceIds: row.regulatoryDecisionReferenceIds,
    }));

  const currentByAccount = new Map<string, Rational>();
  const nonCurrentByAccount = new Map<string, Rational>();
  for (const entry of liabilities) {
    const source = accountRows.get(entry.accountId)!;
    if (entry.amount.n < 0n) addBlocker('NEGATIVE_LIABILITY_BALANCE', `sourceBalances[accountId=${entry.accountId}]`, 'Negative liability balances require accounting resolution before liability allocation.');
    else if (source.statementCategory === 'current_liability' && source.classification !== 'provision_eosb_leave') currentByAccount.set(entry.accountId, entry.amount);
    else nonCurrentByAccount.set(entry.accountId, entry.amount);
  }

  let reclassifiedToEquity = ZERO;
  let currentToNonCurrent = ZERO;
  const currentReclassified = new Map<string, Rational>();
  const equityReclassified = new Map<string, Rational>();
  for (const row of data.liabilityReclassifications) {
    const value = fromSar(row.amountSar, `liabilityReclassifications.${row.reclassificationId}.amountSar`);
    if (row.treatment === 'current_to_non_current') {
      currentReclassified.set(row.accountId, add(currentReclassified.get(row.accountId) ?? ZERO, value));
      currentToNonCurrent = add(currentToNonCurrent, value);
    } else {
      equityReclassified.set(row.accountId, add(equityReclassified.get(row.accountId) ?? ZERO, value));
      reclassifiedToEquity = add(reclassifiedToEquity, value);
    }
  }
  for (const [accountId, amount] of currentReclassified) {
    const current = currentByAccount.get(accountId) ?? ZERO;
    if (cmp(amount, current) > 0) addBlocker('CURRENT_RECLASSIFICATION_OVERLAP', `liabilityReclassifications[accountId=${accountId}]`, 'Combined current-to-noncurrent reclassifications exceed the source liability.');
    else {
      currentByAccount.set(accountId, sub(current, amount));
      nonCurrentByAccount.set(accountId, add(nonCurrentByAccount.get(accountId) ?? ZERO, amount));
    }
  }
  for (const [accountId, amount] of equityReclassified) {
    const current = currentByAccount.get(accountId) ?? ZERO;
    const nonCurrent = nonCurrentByAccount.get(accountId) ?? ZERO;
    if (cmp(amount, add(current, nonCurrent)) > 0) addBlocker('EQUITY_RECLASSIFICATION_OVERLAP', `liabilityReclassifications[accountId=${accountId}]`, 'Combined partner-loan-to-equity reclassifications exceed the source liability.');
    else {
      const fromCurrent = min(current, amount);
      currentByAccount.set(accountId, sub(current, fromCurrent));
      nonCurrentByAccount.set(accountId, sub(nonCurrent, sub(amount, fromCurrent)));
    }
  }

  const totalCurrentAssets = statement.current_asset ?? ZERO;
  const totalNonCurrentAssets = statement.non_current_asset ?? ZERO;
  const currentLiabilityTotal = [...currentByAccount.values()].reduce(add, ZERO);
  const nonCurrentLiabilityTotal = [...nonCurrentByAccount.values()].reduce(add, ZERO);
  const assetAllocations = data.deductibleAssetCandidates.map((row) => ({ accountId: row.accountId, amount: fromSar(row.amountSar, `deductibleAssetCandidates.${row.accountId}.amountSar`) }));
  const deductedCurrentAssets = assetAllocations.filter((row) => accountRows.get(row.accountId)?.statementCategory === 'current_asset').reduce((sum, row) => add(sum, row.amount), ZERO);
  const deductedNonCurrentAssets = assetAllocations.filter((row) => accountRows.get(row.accountId)?.statementCategory === 'non_current_asset').reduce((sum, row) => add(sum, row.amount), ZERO);
  const undeductedCurrentAssets = sub(totalCurrentAssets, deductedCurrentAssets);
  const undeductedNonCurrentAssets = sub(totalNonCurrentAssets, deductedNonCurrentAssets);
  const totalDeductibleAssets = assetAllocations.reduce((sum, row) => add(sum, row.amount), ZERO);
  if (totalCurrentAssets.n < 0n || totalNonCurrentAssets.n < 0n || cmp(deductedCurrentAssets, totalCurrentAssets) > 0 || cmp(deductedNonCurrentAssets, totalNonCurrentAssets) > 0) {
    addBlocker('INVALID_ASSET_TOTALS_FOR_LIABILITY_SEQUENCE', 'declaredStatementTotals', 'Asset totals and eligible allocations must be nonnegative and internally consistent for Article 25.');
  }
  if (currentLiabilityTotal.n > 0n && totalCurrentAssets.n === 0n) addBlocker('ARTICLE25_CURRENT_DENOMINATOR_ZERO', 'declaredStatementTotals.current_asset', 'Article 25 current-liability allocation requires positive total current assets.');
  if (nonCurrentLiabilityTotal.n > 0n && totalNonCurrentAssets.n === 0n) addBlocker('ARTICLE25_NONCURRENT_DENOMINATOR_ZERO', 'declaredStatementTotals.non_current_asset', 'Article 25 noncurrent-liability allocation requires positive total noncurrent assets.');

  let currentAdditionCandidates: { accountId: string; amount: Rational; stage: LiabilityTraceLine['stage']; entry: LiabilityEntry }[] = [];
  let nonCurrentAdditionCandidates: { accountId: string; amount: Rational; stage: LiabilityTraceLine['stage']; entry: LiabilityEntry }[] = [];
  const ratioCurrent = totalCurrentAssets.n > 0n ? div(deductedCurrentAssets, totalCurrentAssets) : ZERO;
  const rawCurrent = [...currentByAccount.entries()].map(([accountId, amount]) => ({ accountId, amount: mul(amount, ratioCurrent), entry: liabilities.find((row) => row.accountId === accountId)! }));
  const currentRawTotal = rawCurrent.reduce((sum, row) => add(sum, row.amount), ZERO);
  const step4Current = min(currentRawTotal, deductedCurrentAssets);
  const currentAllocated = proportionalTraceAllocation(rawCurrent, step4Current);
  rawCurrent.forEach((row, index) => currentAdditionCandidates.push({ accountId: row.accountId, amount: currentAllocated[index], stage: 'article25_current', entry: row.entry }));
  const ratioNonCurrent = totalNonCurrentAssets.n > 0n ? div(undeductedNonCurrentAssets, totalNonCurrentAssets) : ZERO;
  const rawExcluded = [...nonCurrentByAccount.entries()].map(([accountId, amount]) => ({ accountId, amount: mul(amount, ratioNonCurrent), liability: amount, entry: liabilities.find((row) => row.accountId === accountId)! }));
  const excludedRawTotal = rawExcluded.reduce((sum, row) => add(sum, row.amount), ZERO);
  const step4Excluded = min(excludedRawTotal, undeductedNonCurrentAssets);
  const excludedAllocated = proportionalTraceAllocation(rawExcluded, step4Excluded);
  rawExcluded.forEach((row, index) => nonCurrentAdditionCandidates.push({ accountId: row.accountId, amount: sub(row.liability, excludedAllocated[index]), stage: 'article25_non_current', entry: row.entry }));
  const step4Remaining = sub(nonCurrentLiabilityTotal, step4Excluded);

  const step5Candidates = [...currentAdditionCandidates, ...nonCurrentAdditionCandidates];
  const step5Amounts = step5Candidates.map((row) => row.amount);
  const step5AfterCap = step5Amounts.reduce(add, ZERO);
  const step5CurrentAfterCap = step5Candidates.reduce((sum, row, index) => row.stage === 'article25_current' ? add(sum, step5Amounts[index]) : sum, ZERO);
  // Apply the detailed guideline reconciliation after Article 25 placement: only the current
  // liabilities still unadded are compared with current assets not deducted, avoiding double count.
  const currentNotAdded = maxZero(sub(currentLiabilityTotal, step5CurrentAfterCap));
  const step6Surplus = maxZero(sub(currentNotAdded, undeductedCurrentAssets));
  const step5CurrentAccountAdded = new Map<string, Rational>();
  step5Candidates.forEach((row, index) => { if (row.stage === 'article25_current') step5CurrentAccountAdded.set(row.accountId, step5Amounts[index]); });
  const step6AccountWeights = [...currentByAccount.entries()].map(([accountId, amount]) => ({ accountId, amount: maxZero(sub(amount, step5CurrentAccountAdded.get(accountId) ?? ZERO)) }));
  const residualWeight = step6AccountWeights.reduce((sum, row) => add(sum, row.amount), ZERO);
  const step6Allocations = step6AccountWeights.map((row) => ({ ...row, amount: residualWeight.n === 0n ? ZERO : mul(step6Surplus, div(row.amount, residualWeight)) }));
  const preFinalLiabilities = add(step5AfterCap, step6Surplus);
  if (cmp(preFinalLiabilities, totalDeductibleAssets) > 0) {
    addBlocker('B4_AGGREGATE_LIABILITY_INTERACTION_UNRESOLVED', 'liabilityProcedure.aggregateCap', 'Article 25(4) aggregate-cap interaction with the Article 29(2)(b) current-liability surplus is unresolved; no liability amount or Zakat result is emitted.');
  }
  const finalLiabilityTotal = preFinalLiabilities;
  const finalStep6Total = step6Surplus;
  const finalLines: LiabilityTraceLine[] = [];
  step5Candidates.forEach((row, index) => {
    finalLines.push({
      accountId: row.accountId, stage: row.stage,
      originalLiabilityHalalas: row.entry.amount.n.toString(), candidateAdditionHalalas: serialize(row.amount), finalAddedHalalas: serialize(step5Amounts[index]),
      sourceReferences: [row.entry.sourceReference], evidence: row.entry.evidence,
      regulatoryDecisionReferenceIds: row.entry.regulatoryDecisionReferenceIds,
      allocationPolicy: 'proportional_internal_traceability_only',
    });
  });
  step6Allocations.forEach((row) => {
    const entry = liabilities.find((item) => item.accountId === row.accountId)!;
    const added = residualWeight.n === 0n ? ZERO : mul(finalStep6Total, div(row.amount, residualWeight));
    finalLines.push({
      accountId: row.accountId, stage: 'article29_current_surplus', originalLiabilityHalalas: entry.amount.n.toString(),
      candidateAdditionHalalas: serialize(row.amount), finalAddedHalalas: serialize(added),
      sourceReferences: [entry.sourceReference], evidence: entry.evidence,
      regulatoryDecisionReferenceIds: entry.regulatoryDecisionReferenceIds,
      allocationPolicy: 'proportional_internal_traceability_only',
    });
  });
  const liabilityProcedure: LiabilityProcedure = {
    step1NonCurrentLiabilitiesHalalas: serialize(nonCurrentLiabilityTotal),
    step2CurrentToNonCurrentReclassifiedHalalas: serialize(currentToNonCurrent),
    step3PartnerLoansReclassifiedToEquityHalalas: serialize(reclassifiedToEquity),
    step4Article25CurrentAddedHalalas: serialize(step4Current),
    step4Article25NonCurrentExcludedHalalas: serialize(step4Excluded),
    step4Article25NonCurrentRemainingHalalas: serialize(step4Remaining),
    step5AggregateCapHalalas: serialize(totalDeductibleAssets),
    step5AdditionsAfterAggregateCapHalalas: serialize(step5AfterCap),
    step6Article29SurplusCandidateHalalas: serialize(step6Surplus),
    finalLiabilityAdditionsHalalas: serialize(finalLiabilityTotal),
    accountAllocations: finalLines,
    allocationPolicy: 'proportional_internal_traceability_only',
  };

  if (blockers.length > 0) return blocked(blockers);

  const currentEarnings = rat(currentEarningsHalalas);
  let closingEquityForArticle28 = currentEarnings;
  for (const row of mapped) {
    if (row.component === 'equity_component') {
      closingEquityForArticle28 = add(closingEquityForArticle28, rat(BigInt(row.amountHalalas)));
    }
  }
  const equityForBase = add(rat(BigInt(composed.totals.equityNetHalalas)), currentEarnings);
  for (const adjustment of data.adjustments) {
    if (adjustment.category === 'equity') {
      const amount = fromSar(adjustment.amountSar, `adjustments.${adjustment.adjustmentId}.amountSar`);
      const signed = adjustment.direction === 'add' ? amount : rat(-amount.n, amount.d);
      if (adjustment.includedInArticle28ClosingEquity) closingEquityForArticle28 = add(closingEquityForArticle28, signed);
    }
  }
  const equityAfterReclass = add(equityForBase, reclassifiedToEquity);
  const closingEquityAfterReclass = add(closingEquityForArticle28, reclassifiedToEquity);
  const profitDifference = rat(BigInt(composed.totals.article23ProfitDifferenceHalalas));
  const deductible = rat(BigInt(composed.totals.verifiedDeductibleAssetCandidatesHalalas));
  const normalBase = add(sub(add(equityAfterReclass, finalLiabilityTotal), deductible), profitDifference);
  const adjustedProfit = fromSar(data.adjustedProfit.amountSar, 'adjustedProfit.amountSar');
  let article27Minimum: Rational | null = null;
  let baseAfterMinimum = normalBase;
  if (adjustedProfit.n <= 0n) {
    if (normalBase.n < 0n) baseAfterMinimum = ZERO; // Article 27(3): no base where both base and adjusted result are negative/non-positive.
  } else if (cmp(normalBase, adjustedProfit) < 0) {
    // Article 27(2) includes the signed difference between adjusted and book results.
    const statutoryFloor = min(add(add(undeductedCurrentAssets, undeductedNonCurrentAssets), profitDifference), adjustedProfit);
    article27Minimum = max(normalBase, statutoryFloor);
    baseAfterMinimum = article27Minimum;
  }
  const article28Maximum = add(closingEquityAfterReclass, profitDifference);
  if (article28Maximum.n < 0n && normalBase.n > 0n) {
    return blocked([{ code: 'ARTICLE28_NEGATIVE_CEILING_CONFLICT', path: 'article28Maximum', message: 'A negative Article 28 ceiling conflicts with a positive computed base; no payable result is emitted.', disposition: 'blocked' }]);
  }
  if (article27Minimum !== null && cmp(article27Minimum, article28Maximum) > 0) {
    return blocked([{ code: 'ARTICLE27_ARTICLE28_LIMIT_CONFLICT', path: 'article27/article28', message: 'The Article 27 minimum exceeds the Article 28 maximum; no statutory result is emitted pending resolution.', disposition: 'blocked' }]);
  }
  let finalBase = min(baseAfterMinimum, article28Maximum);
  if (finalBase.n < 0n) finalBase = ZERO;
  const period = mode !== 'approved' || cessation ? null : calculatePeriodZakatFromExactHalalas(serialize(finalBase), data.fiscalPeriod.actualDays, options, data.fiscalPeriod.activityPeriod);
  const traceLines: BaseEngineTraceLine[] = [
    ...(currentEarningsHalalas === 0n ? [] : [{
      id: 'ledger:current_period_earnings', component: 'current_period_earnings',
      amountHalalas: serialize(currentEarnings), sourceReferences: [data.finalizedBookResult.sourceReference],
      evidence: data.finalizedBookResult.evidence, regulatoryDecisionReferenceIds: [data.adjustedProfit.regulatoryDecisionReferenceId],
    }]),
    ...data.sourceBalances.map((row) => ({
      id: `balance:${row.accountId}`, component: row.classification,
      amountHalalas: serialize(fromSar(row.amountSar, `sourceBalances.${row.accountId}.amountSar`)),
      sourceReferences: [row.sourceReference], evidence: row.evidence, regulatoryDecisionReferenceIds: row.regulatoryDecisionReferenceIds,
    })),
    ...data.adjustments.map((row) => {
      const amount = fromSar(row.amountSar, `adjustments.${row.adjustmentId}.amountSar`);
      return {
        id: `adjustment:${row.adjustmentId}`, component: row.category,
        amountHalalas: serialize(row.direction === 'add' ? amount : rat(-amount.n, amount.d)),
        sourceReferences: [row.sourceReference], evidence: row.evidence, regulatoryDecisionReferenceIds: [row.regulatoryDecisionReferenceId],
      };
    }),
    ...data.liabilityReclassifications.map((row) => ({
      id: `liability-reclassification:${row.reclassificationId}`, component: row.treatment,
      amountHalalas: serialize(fromSar(row.amountSar, `liabilityReclassifications.${row.reclassificationId}.amountSar`)),
      sourceReferences: [row.sourceReference], evidence: row.evidence, regulatoryDecisionReferenceIds: [row.regulatoryDecisionReferenceId],
    })),
    ...data.carriedForwardLossReconciliations.map((row) => ({
      id: `carried-loss:${row.reconciliationId}`, component: 'article39_carried_forward_loss',
      amountHalalas: serialize(rat(-parseSarToHalalas(row.closingLossSar))),
      sourceReferences: [row.sourceReference], evidence: row.evidence, regulatoryDecisionReferenceIds: [row.regulatoryDecisionReferenceId],
    })),
    ...data.deductibleAssetCandidates.map((row) => ({
      id: `deductible-asset:${row.accountId}`, component: 'deductible_asset',
      amountHalalas: serialize(rat(-parseSarToHalalas(row.amountSar))), sourceReferences: [row.sourceReference],
      evidence: row.evidence, regulatoryDecisionReferenceIds: [row.regulatoryDecisionReferenceId],
    })),
    ...data.undeductedAssets.map((row) => ({
      id: `undeducted-asset:${row.accountId}`, component: 'undeducted_asset',
      amountHalalas: serialize(fromSar(row.amountSar, `undeductedAssets.${row.accountId}.amountSar`)), sourceReferences: [row.sourceReference],
      evidence: row.evidence, regulatoryDecisionReferenceIds: [row.regulatoryDecisionReferenceId],
    })),
    ...data.finalizedBookResult.actuallyRecordedCharges.map((row) => ({
      id: `recorded-charge:${row.chargeId}`, component: row.kind,
      amountHalalas: serialize(fromSar(row.amountSar, `recordedCharges.${row.chargeId}.amountSar`)),
      sourceReferences: [row.sourceReference], evidence: row.evidence, regulatoryDecisionReferenceIds: [],
    })),
    {
      id: 'article23-3:profit-difference', component: 'adjusted_profit_less_finalized_book_result',
      amountHalalas: serialize(profitDifference), sourceReferences: [data.finalizedBookResult.sourceReference, ...data.adjustedProfit.sourceReferences],
      evidence: [...data.finalizedBookResult.evidence, ...data.adjustedProfit.evidence], regulatoryDecisionReferenceIds: [data.adjustedProfit.regulatoryDecisionReferenceId],
    },
    {
      id: 'article73:assessment', component: 'article73_project_inventory_review', amountHalalas: serialize(ZERO),
      sourceReferences: [data.article73Assessment.sourceReference], evidence: data.article73Assessment.evidence,
      regulatoryDecisionReferenceIds: [data.article73Assessment.regulatoryDecisionReferenceId],
    },
    ...data.article73Assessment.projects.map((project) => ({
      id: `article73:project:${project.accountId}`, component: 'article73_project_facts', amountHalalas: serialize(ZERO),
      sourceReferences: [project.sourceReference], evidence: project.evidence,
      regulatoryDecisionReferenceIds: [data.article73Assessment.regulatoryDecisionReferenceId],
    })),
    {
      id: 'base:ordinary', component: 'articles23-26-composed-base', amountHalalas: serialize(normalBase),
      sourceReferences: [
        ...data.sourceBalances.map((row) => row.sourceReference),
        ...data.adjustments.map((row) => row.sourceReference),
        ...data.deductibleAssetCandidates.map((row) => row.sourceReference),
        data.finalizedBookResult.sourceReference, ...data.adjustedProfit.sourceReferences,
        ...data.liabilityReclassifications.map((row) => row.sourceReference),
      ],
      evidence: [
        ...data.sourceBalances.flatMap((row) => row.evidence),
        ...data.adjustments.flatMap((row) => row.evidence),
        ...data.deductibleAssetCandidates.flatMap((row) => row.evidence),
        ...data.finalizedBookResult.evidence, ...data.adjustedProfit.evidence,
      ],
      regulatoryDecisionReferenceIds: [...new Set([
        ...data.sourceBalances.flatMap((row) => row.regulatoryDecisionReferenceIds),
        ...data.adjustments.map((row) => row.regulatoryDecisionReferenceId),
        ...data.deductibleAssetCandidates.map((row) => row.regulatoryDecisionReferenceId),
        data.adjustedProfit.regulatoryDecisionReferenceId,
      ])],
    },
    {
      id: 'base:article27-minimum', component: 'article27-minimum', amountHalalas: serialize(article27Minimum ?? ZERO),
      sourceReferences: [...data.undeductedAssets.map((row) => row.sourceReference), data.finalizedBookResult.sourceReference, ...data.adjustedProfit.sourceReferences],
      evidence: [...data.undeductedAssets.flatMap((row) => row.evidence), ...data.finalizedBookResult.evidence, ...data.adjustedProfit.evidence],
      regulatoryDecisionReferenceIds: [data.adjustedProfit.regulatoryDecisionReferenceId],
    },
    {
      id: 'base:article28-maximum', component: 'article28-maximum', amountHalalas: serialize(article28Maximum),
      sourceReferences: [...data.sourceBalances.filter((row) => row.statementCategory === 'equity').map((row) => row.sourceReference), ...data.liabilityReclassifications.map((row) => row.sourceReference), data.finalizedBookResult.sourceReference, ...data.adjustedProfit.sourceReferences],
      evidence: [...data.sourceBalances.filter((row) => row.statementCategory === 'equity').flatMap((row) => row.evidence), ...data.liabilityReclassifications.flatMap((row) => row.evidence), ...data.finalizedBookResult.evidence, ...data.adjustedProfit.evidence],
      regulatoryDecisionReferenceIds: [data.adjustedProfit.regulatoryDecisionReferenceId],
    },
  ];
  const article73Groups = new Map<string, ZakatCalculationInputV1['article73Assessment']['projects']>();
  for (const project of data.article73Assessment.projects) {
    article73Groups.set(project.projectId, [...(article73Groups.get(project.projectId) ?? []), project]);
  }
  const article73ProjectEvaluations: Article73ProjectEvaluation[] = [...article73Groups.entries()].map(([projectId, projects]) => {
    const treatment = projects[0].treatment;
    const closing = projects.reduce((sum, project) => add(sum, fromSar(project.closingBalanceSar, `article73.${project.accountId}.closingBalanceSar`)), ZERO);
    const additions = projects.reduce((sum, project) => add(sum, fromSar(project.additionsSar, `article73.${project.accountId}.additionsSar`)), ZERO);
    const opening = projects.reduce((sum, project) => add(sum, fromSar(project.openingBalanceSar, `article73.${project.accountId}.openingBalanceSar`)), ZERO);
    const costOfSales = projects.reduce((sum, project) => add(sum, fromSar(project.costOfSalesSar, `article73.${project.accountId}.costOfSalesSar`)), ZERO);
    if (treatment === 'licensed_off_plan_sale') {
      const calculatedDeduction = maxZero(sub(closing, additions));
      return {
        projectId, accountId: projects.map((project) => project.accountId).join(','), treatment,
        costOfSalesRatio: null, calculatedDeductionHalalas: serialize(calculatedDeduction),
        eligibleForDeduction: projects.every((project) => project.licensedForOffPlanSale) && calculatedDeduction.n > 0n,
        sourceReference: projects[0].sourceReference, evidence: projects.flatMap((project) => project.evidence),
      };
    }
    const denominator = add(opening, additions);
    const qualifies = projects.every((project) => project.isUnderConstruction && project.intendedForSaleAfterCompletion && !project.offeredForSaleAsIs) && cmp(mul(costOfSales, rat(4n)), denominator) <= 0;
    return {
      projectId, accountId: projects.map((project) => project.accountId).join(','), treatment,
      costOfSalesRatio: serialize(div(costOfSales, denominator)),
      calculatedDeductionHalalas: serialize(qualifies ? closing : ZERO),
      eligibleForDeduction: qualifies,
      sourceReference: projects[0].sourceReference, evidence: projects.flatMap((project) => project.evidence),
    };
  });
  return {
    status: authenticated ? (cessation ? 'EXEMPT' : 'READY') : 'BLOCKED',
    inputAssertionsAuthenticated: authenticated, exemptionCode: authenticated && cessation ? 'ARTICLE15_CESSATION_SHORT_PERIOD' : null,
    finalZakatBaseHalalas: period ? serialize(finalBase) : null,
    payableAmountHalalas: period?.finalAmountHalalas ?? null,
    payableRounding: period?.roundingMode ?? null, ordinaryBaseBeforeLimitsHalalas: serialize(normalBase),
    article27MinimumAppliedHalalas: article27Minimum === null ? null : serialize(article27Minimum),
    article28MaximumHalalas: serialize(article28Maximum), liabilityProcedure, article73ProjectEvaluations, traceLines,
    sourceReferences: traceLines.flatMap((line) => line.sourceReferences),
    blockers: authenticated ? [] : [{
      code: 'REGULATORY_GATE_AUTHENTICATION_REQUIRED', path: 'regulatoryDecisionReferences',
      message: 'Caller-supplied decision references cannot authenticate B0, B3, B4, B7, or B9; no final base or payable amount is released.',
      disposition: 'blocked',
    }],
  };
}
