/**
 * Isolated Phase 1 component composition. It never returns a Zakat base or payable amount.
 * All monetary arithmetic uses exact halalas and all inputs are revalidated at the boundary.
 */

import {
  validateCalculationInput,
  type EvidenceReference,
  type InputIssue,
  type SourceReference,
  type ZakatCalculationInputV1,
} from './calculation-input';
import { calculateProfitDifference, parseSarToHalalas } from './zakat-calculation';

export type CompositionBlocker = Pick<InputIssue, 'code' | 'path' | 'message' | 'disposition'>;
export type CompositionDirection = 'addition' | 'reduction' | 'difference' | 'memorandum';
export type CompositionLine = {
  id: string;
  component: 'equity' | 'verified_deductible_asset_candidate' | 'profit_difference' | 'liability_candidate' | 'undeducted_asset' | 'non_deductible_asset';
  direction: CompositionDirection;
  /** Signed component amount in exact halalas. A deduction candidate is represented as negative. */
  amountHalalas: string;
  includedInComponentTotals: boolean;
  sourceReferences: SourceReference[];
  evidence: EvidenceReference[];
  regulatoryDecisionReferenceIds: string[];
};

export type CompositionTotals = {
  equityAdditionsHalalas: string;
  equityReductionsHalalas: string;
  equityNetHalalas: string;
  verifiedDeductibleAssetCandidatesHalalas: string;
  article23ProfitDifferenceHalalas: string;
};

export type ZakatBaseComposition = {
  status: 'COMPONENTS_ONLY' | 'BLOCKED';
  /** Deliberately absent until all calculation rules and gates are resolved. */
  finalZakatBaseHalalas: null;
  payableAmountHalalas: null;
  totals: CompositionTotals | null;
  lines: CompositionLine[];
  blockers: CompositionBlocker[];
};

function blockedFromValidation(issues: InputIssue[]): ZakatBaseComposition {
  return {
    status: 'BLOCKED',
    finalZakatBaseHalalas: null,
    payableAmountHalalas: null,
    totals: null,
    lines: [],
    blockers: issues.map(({ code, path, message, disposition }) => ({ code, path, message, disposition })),
  };
}

function line(input: {
  id: string;
  component: CompositionLine['component'];
  amount: bigint;
  direction: CompositionDirection;
  included: boolean;
  sourceReferences: SourceReference[];
  evidence: EvidenceReference[];
  decisionIds: string[];
}): CompositionLine {
  return {
    id: input.id,
    component: input.component,
    direction: input.direction,
    amountHalalas: input.amount.toString(),
    includedInComponentTotals: input.included,
    sourceReferences: input.sourceReferences,
    evidence: input.evidence,
    regulatoryDecisionReferenceIds: input.decisionIds,
  };
}

function addBlocker(blockers: CompositionBlocker[], code: string, path: string, message: string): void {
  blockers.push({ code, path, message, disposition: 'blocked' });
}

/**
 * Produces auditable component subtotals from validated contract data.
 * Liability amounts are recorded for traceability but never placed into the base.
 */
export function composeZakatBaseComponents(input: unknown): ZakatBaseComposition {
  const validation = validateCalculationInput(input);
  if (!validation.valid) return blockedFromValidation(validation.issues);

  const data = input as ZakatCalculationInputV1;
  const blockers: CompositionBlocker[] = [];
  const lines: CompositionLine[] = [];
  let equityAdditions = 0n;
  let equityReductions = 0n;
  let deductibleAssetCandidates = 0n;

  for (const account of validation.mappedAccounts) {
    const amount = BigInt(account.amountHalalas);
    if (account.component === 'equity_component') {
      const direction: CompositionDirection = amount > 0n ? 'addition' : amount < 0n ? 'reduction' : 'memorandum';
      if (amount > 0n) equityAdditions += amount;
      if (amount < 0n) equityReductions += -amount;
      lines.push(line({
        id: `account:${account.accountId}`,
        component: 'equity',
        amount,
        direction,
        included: amount !== 0n,
        sourceReferences: [account.sourceReference],
        evidence: account.evidence,
        decisionIds: account.regulatoryDecisionReferenceIds,
      }));
    } else if (account.component === 'current_liability_candidate' || account.component === 'non_current_liability_candidate') {
      if (amount !== 0n) {
        addBlocker(blockers, 'LIABILITY_CAPS_UNRESOLVED', `sourceBalances[accountId=${account.accountId}]`, 'Liability caps and sequencing remain unresolved; no liability amount is included.');
      }
      lines.push(line({
        id: `account:${account.accountId}`,
        component: 'liability_candidate',
        amount,
        direction: 'memorandum',
        included: false,
        sourceReferences: [account.sourceReference],
        evidence: account.evidence,
        decisionIds: account.regulatoryDecisionReferenceIds,
      }));
    }
  }

  for (const adjustment of data.adjustments) {
    const unsignedAmount = parseSarToHalalas(adjustment.amountSar, `adjustments.${adjustment.adjustmentId}.amountSar`);
    const amount = adjustment.direction === 'add' ? unsignedAmount : -unsignedAmount;
    if (adjustment.category === 'equity') {
      if (amount > 0n) equityAdditions += amount;
      if (amount < 0n) equityReductions += -amount;
      lines.push(line({
        id: `adjustment:${adjustment.adjustmentId}`,
        component: 'equity',
        amount,
        direction: amount > 0n ? 'addition' : amount < 0n ? 'reduction' : 'memorandum',
        included: amount !== 0n,
        sourceReferences: [adjustment.sourceReference],
        evidence: adjustment.evidence,
        decisionIds: [adjustment.regulatoryDecisionReferenceId],
      }));
    } else if (adjustment.category === 'liability' && unsignedAmount !== 0n) {
      addBlocker(blockers, 'LIABILITY_ADJUSTMENT_UNRESOLVED', `adjustments.${adjustment.adjustmentId}`, 'Liability adjustments are not composed while cap and sequencing rules remain unresolved.');
    } else if (adjustment.category === 'asset_deduction' && unsignedAmount !== 0n) {
      addBlocker(blockers, 'UNSUPPORTED_ASSET_DEDUCTION', `adjustments.${adjustment.adjustmentId}`, 'Asset deductions must use explicitly verified asset allocations; this adjustment is not applied.');
    } else if (adjustment.category === 'other' && unsignedAmount !== 0n) {
      addBlocker(blockers, 'UNSUPPORTED_ADJUSTMENT', `adjustments.${adjustment.adjustmentId}`, 'Other adjustments have no supported component mapping.');
    }
    // Profit adjustments are traceable inputs only. The supplied adjusted result is the Article 23(3) input;
    // this module does not infer or reconstruct that result from adjustment labels.
  }

  const allocationByAccount = new Map(data.deductibleAssetCandidates.map((asset) => [asset.accountId, asset]));
  const undeductedAccountIds = new Set(data.undeductedAssets.map((asset) => asset.accountId));
  const mappedDeductibleAccounts = new Set(validation.mappedAccounts
    .filter((account) => account.component === 'deductible_asset_candidate')
    .map((account) => account.accountId));
  for (const accountId of mappedDeductibleAccounts) {
    if (!allocationByAccount.has(accountId) && !undeductedAccountIds.has(accountId)) {
      addBlocker(blockers, 'ASSET_ELIGIBILITY_UNSPECIFIED', `sourceBalances[accountId=${accountId}]`, 'A deductible asset classification needs an explicit, verified asset allocation.');
    }
  }

  for (const asset of data.deductibleAssetCandidates) {
    const amount = parseSarToHalalas(asset.amountSar, `deductibleAssetCandidates.${asset.accountId}.amountSar`);
    const sourceBalance = data.sourceBalances.find((row) => row.accountId === asset.accountId);
    if (sourceBalance && parseSarToHalalas(sourceBalance.amountSar, `sourceBalances.${asset.accountId}.amountSar`) < 0n && amount > 0n) {
      addBlocker(blockers, 'NEGATIVE_ASSET_ELIGIBILITY_INPUT', `deductibleAssetCandidates[accountId=${asset.accountId}]`, 'A negative asset source balance cannot be treated as a deductible asset without accounting resolution.');
    }
    deductibleAssetCandidates += amount;
    lines.push(line({
      id: `asset:${asset.accountId}`,
      component: 'verified_deductible_asset_candidate',
      amount: -amount,
      direction: amount === 0n ? 'memorandum' : 'reduction',
      included: amount !== 0n,
      sourceReferences: [asset.sourceReference],
      evidence: asset.evidence,
      decisionIds: [asset.regulatoryDecisionReferenceId],
    }));
  }

  for (const asset of data.undeductedAssets) {
    const amount = parseSarToHalalas(asset.amountSar, `undeductedAssets.${asset.accountId}.amountSar`);
    lines.push(line({
      id: `asset-undeducted:${asset.accountId}`,
      component: 'undeducted_asset',
      amount,
      direction: 'memorandum',
      included: false,
      sourceReferences: [asset.sourceReference],
      evidence: asset.evidence,
      decisionIds: [asset.regulatoryDecisionReferenceId],
    }));
  }

  for (const account of validation.mappedAccounts.filter((row) => row.component === 'non_deductible_asset')) {
    lines.push(line({
      id: `account:${account.accountId}`,
      component: 'non_deductible_asset',
      amount: BigInt(account.amountHalalas),
      direction: 'memorandum',
      included: false,
      sourceReferences: [account.sourceReference],
      evidence: account.evidence,
      decisionIds: account.regulatoryDecisionReferenceIds,
    }));
  }

  const profitDifference = calculateProfitDifference(data.adjustedProfit.amountSar, data.finalizedBookResult.amountSar);
  const profitDifferenceHalalas = BigInt(profitDifference.differenceHalalas);
  lines.push(line({
    id: 'article23-3:profit-difference',
    component: 'profit_difference',
    amount: profitDifferenceHalalas,
    direction: 'difference',
    included: true,
    sourceReferences: [data.finalizedBookResult.sourceReference, ...data.adjustedProfit.sourceReferences],
    evidence: [...data.finalizedBookResult.evidence, ...data.adjustedProfit.evidence],
    decisionIds: [data.adjustedProfit.regulatoryDecisionReferenceId],
  }));

  return {
    status: blockers.length > 0 ? 'BLOCKED' : 'COMPONENTS_ONLY',
    finalZakatBaseHalalas: null,
    payableAmountHalalas: null,
    totals: {
      equityAdditionsHalalas: equityAdditions.toString(),
      equityReductionsHalalas: equityReductions.toString(),
      equityNetHalalas: (equityAdditions - equityReductions).toString(),
      verifiedDeductibleAssetCandidatesHalalas: deductibleAssetCandidates.toString(),
      article23ProfitDifferenceHalalas: profitDifferenceHalalas.toString(),
    },
    lines,
    blockers,
  };
}
