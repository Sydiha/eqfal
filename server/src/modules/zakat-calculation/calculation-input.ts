/**
 * Versioned, pure input contract for future Zakat calculation work.
 * Validation only: this module does not calculate a base/amount or access application services.
 */

import { ZAKAT_TYPES } from '../zakat-worksheets/zakat-worksheet.rules';
import { parseSarToHalalas, ZakatInputError } from './zakat-calculation';

export const ZAKAT_CALCULATION_INPUT_VERSION = 'zakat-calculation-input.v1' as const;

export const STATEMENT_CATEGORIES = [
  'current_asset',
  'non_current_asset',
  'current_liability',
  'non_current_liability',
  'equity',
] as const;
export type StatementCategory = (typeof STATEMENT_CATEGORIES)[number];
export type ZakatClassification =
  | 'equity_capital'
  | 'equity_reserve'
  | 'retained_earnings'
  | 'carried_forward_loss'
  | 'treasury_shares'
  | 'provision_equity_like'
  | 'provision_eosb_leave'
  | 'partner_loan_credit_liability'
  | 'partner_loan_credit_equity'
  | 'non_current_liability'
  | 'current_liability'
  | 'deductible_fixed_asset'
  | 'deductible_intangible'
  | 'deductible_spare_or_raw_material'
  | 'statutory_deposit'
  | 'deferred_tax_asset'
  | 'deductible_investment'
  | 'non_deductible_asset'
  | 'other_manual';

export type RegulatoryGate = 'B0' | 'B3' | 'B4' | 'B7' | 'B9';
export type Component =
  | 'equity_component'
  | 'current_liability_candidate'
  | 'non_current_liability_candidate'
  | 'liability_candidate'
  | 'deductible_asset_candidate'
  | 'non_deductible_asset';
export type AdjustmentCategory = 'profit' | 'equity' | 'liability' | 'asset_deduction' | 'other';
export type AdjustmentDirection = 'add' | 'deduct';
export type BalanceSign = 'positive' | 'negative' | 'zero';
export type Article15ActivityPeriod = 'regular' | 'commencement' | 'cessation' | 'unresolved';
export const ARTICLE63_EXPENSE_CATEGORIES = [
  'bad_debt', 'depreciation', 'employee_housing_finance_return', 'owner_wages_registered_with_gosi',
  'board_member_remuneration', 'documented_wage_difference', 'licensed_donation',
  'employee_education_expense', 'current_year_provision', 'zakat_or_income_tax_paid',
] as const;
export type Article63ExpenseCategory = (typeof ARTICLE63_EXPENSE_CATEGORIES)[number];

export type SourceReference = { source: string; recordId: string };
export type EvidenceReference = { referenceId: string; kind: 'document' | 'accounting_record' | 'decision' };
export type ReviewAttestation = {
  reviewerReference: SourceReference;
  reviewedAt: string;
  evidence: EvidenceReference[];
};

export type SourceBalance = {
  accountId: string;
  statementCategory: StatementCategory;
  classification: ZakatClassification;
  /** Signed decimal SAR as received from the named source. Floats are forbidden. */
  amountSar: string;
  /** Explicit arithmetic sign copied with the source amount; never used to infer classification. */
  sign: BalanceSign;
  sourceReference: SourceReference;
  evidence: EvidenceReference[];
  regulatoryDecisionReferenceIds: string[];
  carriedForwardLossReconciliationId?: string;
};

/** Article 39 support for treating a closing equity debit as accumulated losses. */
export type CarriedForwardLossReconciliation = {
  reconciliationId: string;
  accountId: string;
  openingLossSar: string;
  currentPeriodLossSar: string;
  otherMovementsSar: string;
  closingLossSar: string;
  sourceReference: SourceReference;
  evidence: EvidenceReference[];
  regulatoryDecisionReferenceId: string;
};

export type ActuallyRecordedCharge = {
  chargeId: string;
  kind: 'zakat_provision' | 'tax_provision' | 'zakat_paid' | 'tax_paid';
  amountSar: string;
  includedInFinalizedBookResult: true;
  sourceReference: SourceReference;
  evidence: EvidenceReference[];
};

export type Article73ProjectFacts = {
  projectId: string;
  accountId: string;
  treatment: 'construction_sale_after_completion' | 'licensed_off_plan_sale';
  licensedForOffPlanSale: boolean;
  isUnderConstruction: boolean;
  intendedForSaleAfterCompletion: boolean;
  offeredForSaleAsIs: boolean;
  statementCategory: 'current_asset' | 'non_current_asset';
  openingBalanceSar: string;
  additionsSar: string;
  costOfSalesSar: string;
  otherMovementsSar: string;
  closingBalanceSar: string;
  sourceReference: SourceReference;
  evidence: EvidenceReference[];
};

export type Article73Assessment = {
  reviewed: true;
  sourceReference: SourceReference;
  evidence: EvidenceReference[];
  reviewAttestation: ReviewAttestation;
  regulatoryDecisionReferenceId: string;
  projects: Article73ProjectFacts[];
};

export type LiabilityReclassification = {
  reclassificationId: string;
  accountId: string;
  amountSar: string;
  treatment: 'current_to_non_current' | 'partner_loan_to_equity';
  confirmed: true;
  currentDebtFacts?: { sameCreditor: boolean; samePurpose: boolean; renewedOrRescheduled: boolean };
  partnerLoanFacts?: {
    entityType: 'listed_company' | 'non_listed_capital_company' | 'partnership' | 'sole_person_company' | 'individual_establishment';
    auditedFinancialStatements: boolean;
    classifiedAsLiability: boolean;
    repaymentTermDefined: boolean;
    returnAtMarketRate: boolean;
    singleOwnerControl: boolean;
  };
  sourceReference: SourceReference;
  evidence: EvidenceReference[];
  regulatoryDecisionReferenceId: string;
};

export type CategorizedAdjustment = {
  adjustmentId: string;
  category: AdjustmentCategory;
  direction: AdjustmentDirection;
  /** Nonnegative decimal SAR; direction carries the add/deduct meaning. */
  amountSar: string;
  sourceReference: SourceReference;
  evidence: EvidenceReference[];
  regulatoryDecisionReferenceId: string;
  /** Required for nonzero profit adjustments; identifies the enumerated Article 63 basis. */
  article63ExpenseCategory?: Article63ExpenseCategory;
  reviewAttestation?: ReviewAttestation;
  /** Required for equity adjustments: confirms whether the adjustment is already reflected in closing equity for Article 28. */
  includedInArticle28ClosingEquity?: boolean;
};

export type AssetAllocation = {
  accountId: string;
  amountSar: string;
  /** Explicit preparer/reviewer assertion for this treatment; this contract does not establish legal eligibility. */
  eligibilityStatus: 'verified' | 'pending';
  sourceReference: SourceReference;
  evidence: EvidenceReference[];
  regulatoryDecisionReferenceId: string;
  /** Caller-supplied review provenance; the isolated engine cannot authenticate this assertion. */
  reviewAttestation: ReviewAttestation;
};

export type RegulatoryDecisionReference = {
  gate: RegulatoryGate;
  referenceId: string;
  sourceReference: SourceReference;
  /** This is input provenance, not a regulatory-gate status mutation. */
  disposition: 'decision_recorded' | 'pending';
  /** Caller-supplied review provenance; this is not an independently authenticated gate state. */
  reviewAttestation: ReviewAttestation;
};

export type ZakatCalculationInputV1 = {
  version: typeof ZAKAT_CALCULATION_INPUT_VERSION;
  fiscalPeriod: { startDate: string; endDate: string; actualDays: number; activityPeriod: Article15ActivityPeriod };
  sourceBalances: SourceBalance[];
  /** Signed row totals by source statement category, reconciled exactly to sourceBalances. */
  declaredStatementTotals: Record<StatementCategory, string>;
  adjustments: CategorizedAdjustment[];
  liabilityReclassifications: LiabilityReclassification[];
  carriedForwardLossReconciliations: CarriedForwardLossReconciliation[];
  finalizedBookResult: {
    amountSar: string;
    status: 'finalized' | 'draft';
    includesActuallyRecordedZakatAndTax: boolean;
    sourceReference: SourceReference;
    evidence: EvidenceReference[];
    actuallyRecordedCharges: ActuallyRecordedCharge[];
  };
  adjustedProfit: {
    amountSar: string;
    sourceReferences: SourceReference[];
    evidence: EvidenceReference[];
    regulatoryDecisionReferenceId: string;
  };
  deductibleAssetCandidates: AssetAllocation[];
  undeductedAssets: AssetAllocation[];
  declaredAssetTotals: { deductibleCandidateSar: string; undeductedSar: string };
  article73Assessment: Article73Assessment;
  regulatoryDecisionReferences: RegulatoryDecisionReference[];
};

export type InputIssue = {
  code: string;
  path: string;
  message: string;
  disposition: 'invalid' | 'blocked';
};
export type MappedAccount = {
  accountId: string;
  classification: ZakatClassification;
  component: Component;
  amountHalalas: string;
  sourceReference: SourceReference;
  evidence: EvidenceReference[];
  regulatoryDecisionReferenceIds: string[];
};
export type CalculationInputValidation =
  | { valid: true; version: typeof ZAKAT_CALCULATION_INPUT_VERSION; mappedAccounts: MappedAccount[]; issues: [] }
  | { valid: false; version: typeof ZAKAT_CALCULATION_INPUT_VERSION | null; mappedAccounts: []; issues: InputIssue[] };

/** Only classification-to-source-component links with an explicit current mapping are listed. */
export const CLASSIFICATION_COMPONENTS: Partial<Record<ZakatClassification, Component>> = {
  equity_capital: 'equity_component',
  equity_reserve: 'equity_component',
  retained_earnings: 'equity_component',
  carried_forward_loss: 'equity_component',
  treasury_shares: 'equity_component',
  provision_equity_like: 'equity_component',
  partner_loan_credit_equity: 'equity_component',
  current_liability: 'current_liability_candidate',
  non_current_liability: 'non_current_liability_candidate',
  partner_loan_credit_liability: 'liability_candidate',
  provision_eosb_leave: 'liability_candidate',
  deductible_fixed_asset: 'deductible_asset_candidate',
  deductible_intangible: 'deductible_asset_candidate',
  deductible_spare_or_raw_material: 'deductible_asset_candidate',
  statutory_deposit: 'deductible_asset_candidate',
  deductible_investment: 'deductible_asset_candidate',
  deferred_tax_asset: 'deductible_asset_candidate',
  non_deductible_asset: 'non_deductible_asset',
};

const GATES: readonly RegulatoryGate[] = ['B0', 'B3', 'B4', 'B7', 'B9'];
const ADJUSTMENT_CATEGORIES: readonly AdjustmentCategory[] = ['profit', 'equity', 'liability', 'asset_deduction', 'other'];
const COMPONENT_CATEGORIES: Record<Component, readonly StatementCategory[]> = {
  equity_component: ['equity', 'current_liability', 'non_current_liability'],
  current_liability_candidate: ['current_liability'],
  non_current_liability_candidate: ['current_liability', 'non_current_liability'],
  liability_candidate: ['current_liability', 'non_current_liability'],
  deductible_asset_candidate: ['current_asset', 'non_current_asset'],
  non_deductible_asset: ['current_asset', 'non_current_asset'],
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isCategory = (value: unknown): value is StatementCategory => STATEMENT_CATEGORIES.includes(value as StatementCategory);
const isClassification = (value: unknown): value is ZakatClassification => typeof value === 'string' && Object.prototype.hasOwnProperty.call(ZAKAT_TYPES, value);
const isEvidenceKind = (value: unknown): value is EvidenceReference['kind'] => value === 'document' || value === 'accounting_record' || value === 'decision';
const isBalanceSign = (value: unknown): value is BalanceSign => value === 'positive' || value === 'negative' || value === 'zero';
const isDecisionId = (value: unknown, ids: ReadonlySet<string>): value is string => typeof value === 'string' && ids.has(value);

function push(issues: InputIssue[], code: string, path: string, message: string, disposition: InputIssue['disposition'] = 'invalid'): void {
  issues.push({ code, path, message, disposition });
}

function validateSourceReference(value: unknown, path: string, issues: InputIssue[]): value is SourceReference {
  if (!isObject(value) || !nonEmpty(value.source) || !nonEmpty(value.recordId)) {
    push(issues, 'SOURCE_REFERENCE_REQUIRED', path, 'A source name and record ID are required.');
    return false;
  }
  return true;
}

function validateEvidence(value: unknown, path: string, issues: InputIssue[]): value is EvidenceReference[] {
  if (!Array.isArray(value)) {
    push(issues, 'EVIDENCE_LIST_REQUIRED', path, 'Evidence must be supplied as a list.');
    return false;
  }
  let valid = true;
  value.forEach((entry, index) => {
    if (!isObject(entry) || !nonEmpty(entry.referenceId) || !isEvidenceKind(entry.kind)) {
      push(issues, 'INVALID_EVIDENCE_REFERENCE', `${path}[${index}]`, 'Evidence requires a reference ID and supported kind.');
      valid = false;
    }
  });
  return valid;
}

function validateReviewAttestation(value: unknown, path: string, issues: InputIssue[]): value is ReviewAttestation {
  if (!isObject(value)) {
    push(issues, 'REVIEW_ATTESTATION_REQUIRED', path, 'A reviewer reference, review timestamp, and review evidence are required.');
    return false;
  }
  let valid = validateSourceReference(value.reviewerReference, `${path}.reviewerReference`, issues);
  if (typeof value.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value.reviewedAt) || !Number.isFinite(Date.parse(value.reviewedAt))) {
    push(issues, 'INVALID_REVIEW_TIMESTAMP', `${path}.reviewedAt`, 'Review timestamp must be an ISO date-time.');
    valid = false;
  }
  const attestationEvidence = value.evidence;
  const evidenceValid = validateEvidence(attestationEvidence, `${path}.evidence`, issues);
  if (evidenceValid && Array.isArray(attestationEvidence) && attestationEvidence.length === 0) {
    push(issues, 'REVIEW_EVIDENCE_REQUIRED', `${path}.evidence`, 'At least one review evidence reference is required.');
    valid = false;
  }
  return valid && evidenceValid;
}

function money(value: unknown, path: string, issues: InputIssue[], nonnegative = false): bigint | null {
  try {
    const amount = parseSarToHalalas(value, path);
    if (nonnegative && amount < 0n) {
      push(issues, 'NEGATIVE_AMOUNT_NOT_ALLOWED', path, 'This amount must be zero or positive.');
      return null;
    }
    return amount;
  } catch (error) {
    push(issues, error instanceof ZakatInputError ? error.code : 'INVALID_SAR_AMOUNT', path,
      error instanceof Error ? error.message : 'A valid decimal SAR amount is required.');
    return null;
  }
}

function utcDay(value: unknown, path: string, issues: InputIssue[]): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    push(issues, 'INVALID_FISCAL_DATE', path, 'Date must use YYYY-MM-DD.');
    return null;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    push(issues, 'INVALID_FISCAL_DATE', path, 'Date must be a valid calendar date.');
    return null;
  }
  return timestamp / 86_400_000;
}

function validateRegulatoryReferences(value: unknown, issues: InputIssue[]): Set<string> {
  const ids = new Set<string>();
  const gates = new Set<RegulatoryGate>();
  if (!Array.isArray(value)) {
    push(issues, 'REGULATORY_REFERENCES_REQUIRED', 'regulatoryDecisionReferences', 'Regulatory decision references must be supplied.');
    return ids;
  }
  value.forEach((entry, index) => {
    const path = `regulatoryDecisionReferences[${index}]`;
    if (!isObject(entry) || !GATES.includes(entry.gate as RegulatoryGate) || !nonEmpty(entry.referenceId) ||
        (entry.disposition !== 'decision_recorded' && entry.disposition !== 'pending')) {
      push(issues, 'INVALID_REGULATORY_REFERENCE', path, 'A supported gate, reference ID, and disposition are required.');
      return;
    }
    if (gates.has(entry.gate as RegulatoryGate) || ids.has(entry.referenceId)) {
      push(issues, 'DUPLICATE_REGULATORY_REFERENCE', path, 'Each gate and decision reference may appear only once.');
      return;
    }
    gates.add(entry.gate as RegulatoryGate);
    ids.add(entry.referenceId as string);
    if (!validateSourceReference(entry.sourceReference, `${path}.sourceReference`, issues)) return;
    validateReviewAttestation(entry.reviewAttestation, `${path}.reviewAttestation`, issues);
    if (entry.disposition === 'pending') {
      push(issues, 'REGULATORY_DECISION_PENDING', path, `${entry.gate} decision is unresolved; calculation input remains blocked.`, 'blocked');
    }
  });
  for (const gate of GATES) {
    if (!gates.has(gate)) push(issues, 'REGULATORY_DECISION_REFERENCE_REQUIRED', 'regulatoryDecisionReferences', `A decision reference for ${gate} is required.`, 'blocked');
  }
  return ids;
}

/** Runtime validation and mapping only; no base or payable amount is calculated. */
export function validateCalculationInput(input: unknown): CalculationInputValidation {
  const issues: InputIssue[] = [];
  if (!isObject(input)) {
    push(issues, 'INPUT_OBJECT_REQUIRED', 'input', 'A versioned calculation input object is required.');
    return { valid: false, version: null, mappedAccounts: [], issues };
  }
  const version = input.version === ZAKAT_CALCULATION_INPUT_VERSION ? ZAKAT_CALCULATION_INPUT_VERSION : null;
  if (version === null) push(issues, 'UNSUPPORTED_INPUT_VERSION', 'version', `Expected ${ZAKAT_CALCULATION_INPUT_VERSION}.`);

  if (!isObject(input.fiscalPeriod)) {
    push(issues, 'FISCAL_PERIOD_REQUIRED', 'fiscalPeriod', 'Fiscal period dates and actual day count are required.');
  } else {
    const start = utcDay(input.fiscalPeriod.startDate, 'fiscalPeriod.startDate', issues);
    const end = utcDay(input.fiscalPeriod.endDate, 'fiscalPeriod.endDate', issues);
    if (!['regular', 'commencement', 'cessation', 'unresolved'].includes(input.fiscalPeriod.activityPeriod as string)) {
      push(issues, 'ARTICLE15_ACTIVITY_PERIOD_REQUIRED', 'fiscalPeriod.activityPeriod', 'Fiscal period must identify regular, commencement, cessation, or unresolved activity-period context.');
    }
    if (start !== null && end !== null && end < start) push(issues, 'INVALID_FISCAL_PERIOD', 'fiscalPeriod', 'Fiscal period end must be on or after its start.');
    if (!Number.isSafeInteger(input.fiscalPeriod.actualDays) || (input.fiscalPeriod.actualDays as number) <= 0) {
      push(issues, 'INVALID_FISCAL_DAY_COUNT', 'fiscalPeriod.actualDays', 'Actual fiscal period days must be a positive safe integer.');
    } else if (start !== null && end !== null && end >= start && input.fiscalPeriod.actualDays !== end - start + 1) {
      push(issues, 'FISCAL_DAY_COUNT_MISMATCH', 'fiscalPeriod.actualDays', 'Actual day count must match the inclusive supplied dates.');
    }
    if (Number.isSafeInteger(input.fiscalPeriod.actualDays) && (input.fiscalPeriod.actualDays as number) < 354 &&
        input.fiscalPeriod.activityPeriod !== 'commencement' && input.fiscalPeriod.activityPeriod !== 'cessation') {
      push(issues, 'ARTICLE15_SHORT_PERIOD_CONTEXT_UNRESOLVED', 'fiscalPeriod.activityPeriod', 'A period shorter than 354 days requires confirmation that it is the commencement or cessation period.', 'blocked');
    }
  }

  const decisionIds = validateRegulatoryReferences(input.regulatoryDecisionReferences, issues);
  const lossRows = new Map<string, { id: string; closing: bigint }>();
  const reconciliations = input.carriedForwardLossReconciliations;
  if (!Array.isArray(reconciliations)) {
    push(issues, 'CARRIED_LOSS_RECONCILIATIONS_REQUIRED', 'carriedForwardLossReconciliations', 'Supply a reconciliation list; use an empty list when no carried-forward loss is claimed.');
  } else {
    const reconciliationIds = new Set<string>();
    const lossAccounts = new Set<string>();
    reconciliations.forEach((row, index) => {
      const path = `carriedForwardLossReconciliations[${index}]`;
      if (!isObject(row)) {
        push(issues, 'INVALID_CARRIED_LOSS_RECONCILIATION', path, 'A carried-forward loss reconciliation object is required.');
        return;
      }
      if (!nonEmpty(row.reconciliationId) || reconciliationIds.has(row.reconciliationId)) {
        push(issues, 'DUPLICATE_OR_MISSING_LOSS_RECONCILIATION_ID', `${path}.reconciliationId`, 'Loss reconciliation IDs must be present and unique.');
      } else reconciliationIds.add(row.reconciliationId);
      const accountId = nonEmpty(row.accountId) ? row.accountId : null;
      if (accountId === null) push(issues, 'LOSS_ACCOUNT_REQUIRED', `${path}.accountId`, 'Loss reconciliation requires a source account ID.');
      else if (lossAccounts.has(accountId)) push(issues, 'DUPLICATE_LOSS_ACCOUNT_RECONCILIATION', `${path}.accountId`, 'Each loss account may be reconciled once.');
      else lossAccounts.add(accountId);
      const opening = money(row.openingLossSar, `${path}.openingLossSar`, issues, true);
      const current = money(row.currentPeriodLossSar, `${path}.currentPeriodLossSar`, issues, true);
      const movements = money(row.otherMovementsSar, `${path}.otherMovementsSar`, issues);
      const closing = money(row.closingLossSar, `${path}.closingLossSar`, issues, true);
      if (opening !== null && current !== null && movements !== null && closing !== null && opening + current + movements !== closing) {
        push(issues, 'CARRIED_LOSS_ROLLFORWARD_MISMATCH', path, 'Opening losses plus current-period loss and other movements must equal the closing loss balance.');
      }
      validateSourceReference(row.sourceReference, `${path}.sourceReference`, issues);
      const evidenceOk = validateEvidence(row.evidence, `${path}.evidence`, issues);
      if (evidenceOk && Array.isArray(row.evidence) && row.evidence.length === 0) push(issues, 'CARRIED_LOSS_EVIDENCE_REQUIRED', `${path}.evidence`, 'Article 39 loss reconciliation requires closing accounting evidence.');
      if (!isDecisionId(row.regulatoryDecisionReferenceId, decisionIds)) {
        push(issues, 'LOSS_DECISION_REFERENCE_REQUIRED', `${path}.regulatoryDecisionReferenceId`, 'Loss reconciliation must reference a declared regulatory decision.');
      }
      if (accountId !== null && closing !== null && nonEmpty(row.reconciliationId)) lossRows.set(accountId, { id: row.reconciliationId, closing });
    });
  }
  const mappedAccounts: MappedAccount[] = [];
  const accountRows = new Map<string, { category: StatementCategory; total: bigint }>();
  if (!Array.isArray(input.sourceBalances) || input.sourceBalances.length === 0) {
    push(issues, 'SOURCE_BALANCES_REQUIRED', 'sourceBalances', 'At least one source balance is required.');
  } else {
    input.sourceBalances.forEach((row, index) => {
      const path = `sourceBalances[${index}]`;
      if (!isObject(row)) {
        push(issues, 'INVALID_SOURCE_BALANCE', path, 'A source balance object is required.');
        return;
      }
      const accountId = nonEmpty(row.accountId) ? row.accountId : null;
      if (accountId === null) push(issues, 'ACCOUNT_ID_REQUIRED', `${path}.accountId`, 'Account ID is required.');
      else if (accountRows.has(accountId)) push(issues, 'DUPLICATE_ACCOUNT_MAPPING', `${path}.accountId`, 'Each account may be mapped exactly once.');

      const categoryOk = isCategory(row.statementCategory);
      if (!categoryOk) push(issues, 'UNSUPPORTED_STATEMENT_CATEGORY', `${path}.statementCategory`, 'Statement category is unsupported.');
      const classificationOk = isClassification(row.classification);
      if (!classificationOk) {
        push(issues, 'UNSUPPORTED_CLASSIFICATION', `${path}.classification`, 'Classification is not in the supported worksheet classification set.');
      } else if (categoryOk) {
        const allowedCategories = ZAKAT_TYPES[row.classification as string]?.categories ?? [];
        if (!(allowedCategories as readonly string[]).includes(row.statementCategory as string)) {
          push(issues, 'CLASSIFICATION_CATEGORY_MISMATCH', path, 'Classification does not support the supplied statement category.');
        }
        const baseMapping = CLASSIFICATION_COMPONENTS[row.classification as ZakatClassification];
        const partnerLoanLiability = row.classification === 'partner_loan_credit_equity' &&
          (row.statementCategory === 'current_liability' || row.statementCategory === 'non_current_liability');
        const statutoryNonCurrentProvision = row.classification === 'provision_eosb_leave';
        const mapping = statutoryNonCurrentProvision
          ? 'non_current_liability_candidate'
          : (baseMapping === 'liability_candidate' || partnerLoanLiability) && categoryOk
            ? row.statementCategory === 'current_liability' ? 'current_liability_candidate' : 'non_current_liability_candidate'
          : baseMapping;
        if (accountId !== null && !mapping) {
          push(issues, 'UNRESOLVED_CLASSIFICATION_COMPONENT', `${path}.classification`, `No supported component mapping exists for ${row.classification}.`, 'blocked');
        } else if (accountId !== null && mapping && !COMPONENT_CATEGORIES[mapping].includes(row.statementCategory as StatementCategory)) {
          push(issues, 'CLASSIFICATION_CATEGORY_MISMATCH', path, 'Classification does not support the supplied statement category.');
        }
      }

      const amount = money(row.amountSar, `${path}.amountSar`, issues);
      if (amount !== null) {
        const expectedSign: BalanceSign = amount > 0n ? 'positive' : amount < 0n ? 'negative' : 'zero';
        if (!isBalanceSign(row.sign) || row.sign !== expectedSign) {
          push(issues, 'BALANCE_SIGN_MISMATCH', `${path}.sign`, 'Explicit sign must match the signed source amount.');
        }
        if ((row.classification === 'retained_earnings' && amount < 0n) || (row.classification === 'carried_forward_loss' && amount !== 0n)) {
          const reconciliation = accountId === null ? undefined : lossRows.get(accountId);
          if (!reconciliation || row.carriedForwardLossReconciliationId !== reconciliation.id || amount >= 0n || -amount !== reconciliation.closing) {
            push(issues, 'CARRIED_FORWARD_LOSS_NOT_RECONCILED', `${path}.carriedForwardLossReconciliationId`, 'A negative equity loss is supported only by a matching, evidenced Article 39 closing-balance reconciliation.', 'blocked');
          }
        }
        if (accountId !== null && categoryOk && !accountRows.has(accountId)) accountRows.set(accountId, { category: row.statementCategory as StatementCategory, total: amount });
      }

      const sourceOk = validateSourceReference(row.sourceReference, `${path}.sourceReference`, issues);
      const evidenceOk = validateEvidence(row.evidence, `${path}.evidence`, issues);
      if (classificationOk && ZAKAT_TYPES[row.classification as string]?.evidence && Array.isArray(row.evidence) && row.evidence.length === 0) {
        push(issues, 'CLASSIFICATION_EVIDENCE_REQUIRED', `${path}.evidence`, 'This classification requires supporting evidence.');
      }
      if (!Array.isArray(row.regulatoryDecisionReferenceIds) || row.regulatoryDecisionReferenceIds.some((id) => !isDecisionId(id, decisionIds))) {
        push(issues, 'INVALID_ACCOUNT_DECISION_REFERENCE', `${path}.regulatoryDecisionReferenceIds`, 'Account decision references must point to declared regulatory decisions.');
      } else if (row.regulatoryDecisionReferenceIds.length === 0) {
        push(issues, 'ACCOUNT_DECISION_REFERENCE_REQUIRED', `${path}.regulatoryDecisionReferenceIds`, 'At least one regulatory decision reference is required for each account mapping.', 'blocked');
      }
      if (accountId !== null && classificationOk && sourceOk && evidenceOk && amount !== null) {
        const baseComponent = CLASSIFICATION_COMPONENTS[row.classification as ZakatClassification];
        const partnerLoanLiability = row.classification === 'partner_loan_credit_equity' &&
          (row.statementCategory === 'current_liability' || row.statementCategory === 'non_current_liability');
        const component = row.classification === 'provision_eosb_leave'
          ? 'non_current_liability_candidate'
          : baseComponent === 'liability_candidate' || partnerLoanLiability
            ? row.statementCategory === 'current_liability' ? 'current_liability_candidate' : 'non_current_liability_candidate'
            : baseComponent;
        if (component && categoryOk && COMPONENT_CATEGORIES[component].includes(row.statementCategory as StatementCategory)) {
          mappedAccounts.push({
            accountId,
            classification: row.classification as ZakatClassification,
            component,
            amountHalalas: amount.toString(),
            sourceReference: row.sourceReference as SourceReference,
            evidence: row.evidence as EvidenceReference[],
            regulatoryDecisionReferenceIds: row.regulatoryDecisionReferenceIds as string[],
          });
        }
      }
    });
  }

  if (!isObject(input.declaredStatementTotals)) {
    push(issues, 'DECLARED_STATEMENT_TOTALS_REQUIRED', 'declaredStatementTotals', 'Declared signed totals are required for all statement categories.');
  } else {
    for (const category of STATEMENT_CATEGORIES) {
      const declared = money(input.declaredStatementTotals[category], `declaredStatementTotals.${category}`, issues);
      const actual = [...accountRows.values()].filter((row) => row.category === category).reduce((sum, row) => sum + row.total, 0n);
      if (declared !== null && declared !== actual) push(issues, 'STATEMENT_TOTAL_MISMATCH', `declaredStatementTotals.${category}`, `Declared ${category} total does not equal the signed source-balance total.`);
    }
  }

  if (!Array.isArray(input.liabilityReclassifications)) {
    push(issues, 'LIABILITY_RECLASSIFICATIONS_REQUIRED', 'liabilityReclassifications', 'Supply a reclassification list; use an empty list when none are supported.');
  } else {
    const ids = new Set<string>();
    for (const [index, row] of input.liabilityReclassifications.entries()) {
      const path = `liabilityReclassifications[${index}]`;
      if (!isObject(row)) {
        push(issues, 'INVALID_LIABILITY_RECLASSIFICATION', path, 'A liability reclassification record is required.');
        continue;
      }
      if (!nonEmpty(row.reclassificationId) || ids.has(row.reclassificationId)) push(issues, 'DUPLICATE_OR_MISSING_LIABILITY_RECLASSIFICATION_ID', `${path}.reclassificationId`, 'Reclassification IDs must be present and unique.');
      else ids.add(row.reclassificationId);
      const amount = money(row.amountSar, `${path}.amountSar`, issues, true);
      const accountId = nonEmpty(row.accountId) ? row.accountId : null;
      const sourceBalances = Array.isArray(input.sourceBalances) ? input.sourceBalances : [];
      const sourceRow = accountId === null ? undefined : sourceBalances.find((candidate) => isObject(candidate) && candidate.accountId === accountId);
      if (!sourceRow || !isObject(sourceRow)) push(issues, 'LIABILITY_RECLASSIFICATION_SOURCE_REQUIRED', `${path}.accountId`, 'Reclassification must reference a source balance.');
      else {
        if (sourceRow.statementCategory !== 'current_liability' && sourceRow.statementCategory !== 'non_current_liability') push(issues, 'LIABILITY_RECLASSIFICATION_NOT_LIABILITY', `${path}.accountId`, 'Reclassification source must be a liability.');
        const sourceAmount = money(sourceRow.amountSar, `${path}.sourceBalance`, issues);
        if (amount !== null && sourceAmount !== null && amount > (sourceAmount < 0n ? -sourceAmount : sourceAmount)) push(issues, 'LIABILITY_RECLASSIFICATION_EXCEEDS_SOURCE', `${path}.amountSar`, 'Reclassified amount exceeds the absolute source liability.');
        if (row.treatment === 'current_to_non_current' && (sourceRow.statementCategory !== 'current_liability' || sourceRow.classification === 'provision_eosb_leave')) push(issues, 'INVALID_CURRENT_LIABILITY_RECLASSIFICATION', `${path}.treatment`, 'Only a current liability not already treated as non-current under Article 24 can be reclassified under Article 29(2)(c).');
        if (row.treatment === 'partner_loan_to_equity' && sourceRow.classification !== 'partner_loan_credit_liability' && sourceRow.classification !== 'partner_loan_credit_equity') push(issues, 'INVALID_PARTNER_LOAN_RECLASSIFICATION', `${path}.treatment`, 'Equity reclassification is supported only for an explicitly classified partner loan liability.');
      }
      if (row.treatment !== 'current_to_non_current' && row.treatment !== 'partner_loan_to_equity') push(issues, 'INVALID_LIABILITY_RECLASSIFICATION_TREATMENT', `${path}.treatment`, 'Treatment must be current-to-noncurrent or partner-loan-to-equity.');
      if (row.treatment === 'current_to_non_current') {
        if (!isObject(row.currentDebtFacts) || typeof row.currentDebtFacts.sameCreditor !== 'boolean' ||
            typeof row.currentDebtFacts.samePurpose !== 'boolean' || typeof row.currentDebtFacts.renewedOrRescheduled !== 'boolean') {
          push(issues, 'CURRENT_DEBT_RECLASSIFICATION_FACTS_REQUIRED', `${path}.currentDebtFacts`, 'Creditor identity, financing purpose, and renewal/rescheduling must be documented for Article 29(2)(c).', 'blocked');
        } else if (!row.currentDebtFacts.sameCreditor || !row.currentDebtFacts.samePurpose || !row.currentDebtFacts.renewedOrRescheduled) {
          push(issues, 'CURRENT_DEBT_RECLASSIFICATION_NOT_ELIGIBLE', `${path}.currentDebtFacts`, 'Article 29(2)(c) reclassification requires renewal or rescheduling with the same creditor for the same purpose.', 'blocked');
        }
      }
      if (row.treatment === 'partner_loan_to_equity') {
        const facts = row.partnerLoanFacts;
        const entityTypes = ['listed_company', 'non_listed_capital_company', 'partnership', 'sole_person_company', 'individual_establishment'];
        if (!isObject(facts) || !entityTypes.includes(facts.entityType as string) ||
            typeof facts.auditedFinancialStatements !== 'boolean' || typeof facts.classifiedAsLiability !== 'boolean' ||
            typeof facts.repaymentTermDefined !== 'boolean' || typeof facts.returnAtMarketRate !== 'boolean' || typeof facts.singleOwnerControl !== 'boolean') {
          push(issues, 'PARTNER_LOAN_ARTICLE30_FACTS_REQUIRED', `${path}.partnerLoanFacts`, 'Entity type and Article 30 loan conditions must be documented before equity treatment.', 'blocked');
        } else if (facts.entityType === 'listed_company') {
          push(issues, 'LISTED_PARTNER_LOAN_CLASSIFICATION_FOLLOWS_STATEMENTS', `${path}.partnerLoanFacts`, 'Listed-company partner loans follow their financial-statement classification under Article 30(1).', 'blocked');
        } else if (facts.entityType === 'sole_person_company' || facts.entityType === 'individual_establishment') {
          if (!facts.singleOwnerControl) push(issues, 'SOLE_OWNER_LOAN_FACTS_INCONSISTENT', `${path}.partnerLoanFacts.singleOwnerControl`, 'Article 30(3) equity treatment requires a sole-owner company or individual establishment.');
        } else if (facts.auditedFinancialStatements && facts.classifiedAsLiability && facts.repaymentTermDefined && facts.returnAtMarketRate && !facts.singleOwnerControl) {
          push(issues, 'PARTNER_LOAN_QUALIFIES_AS_LIABILITY', `${path}.partnerLoanFacts`, 'All Article 30(2) liability conditions are met; do not reclassify this loan to equity.', 'blocked');
        }
      }
      if (row.confirmed !== true) push(issues, 'LIABILITY_RECLASSIFICATION_UNCONFIRMED', `${path}.confirmed`, 'Reclassification must be explicitly confirmed and documented.', 'blocked');
      validateSourceReference(row.sourceReference, `${path}.sourceReference`, issues);
      const evidenceOk = validateEvidence(row.evidence, `${path}.evidence`, issues);
      if (evidenceOk && Array.isArray(row.evidence) && row.evidence.length === 0) push(issues, 'LIABILITY_RECLASSIFICATION_EVIDENCE_REQUIRED', `${path}.evidence`, 'Reclassification requires supporting accounting evidence.');
      if (!isDecisionId(row.regulatoryDecisionReferenceId, decisionIds)) push(issues, 'LIABILITY_RECLASSIFICATION_DECISION_REQUIRED', `${path}.regulatoryDecisionReferenceId`, 'Reclassification must reference a declared regulatory decision.');
    }
  }

  if (Array.isArray(input.sourceBalances) && Array.isArray(input.liabilityReclassifications)) {
    for (const [index, sourceRow] of input.sourceBalances.entries()) {
      if (!isObject(sourceRow) || sourceRow.classification !== 'partner_loan_credit_equity' ||
          (sourceRow.statementCategory !== 'current_liability' && sourceRow.statementCategory !== 'non_current_liability')) continue;
      const balance = money(sourceRow.amountSar, `sourceBalances[${index}].amountSar`, issues);
      const reclassified = input.liabilityReclassifications
        .filter((row) => isObject(row) && row.accountId === sourceRow.accountId && row.treatment === 'partner_loan_to_equity')
        .reduce((sum, row, reclassIndex) => sum + (money(row.amountSar, `liabilityReclassifications[${reclassIndex}].amountSar`, issues, true) ?? 0n), 0n);
      if (balance !== null && reclassified !== (balance < 0n ? -balance : balance)) {
        push(issues, 'PARTNER_LOAN_EQUITY_RECLASSIFICATION_REQUIRED', `sourceBalances[${index}]`, 'A partner loan classified as equity while presented as a liability requires evidenced reclassification of its full closing balance.', 'blocked');
      }
    }
  }

  const adjustments = input.adjustments;
  const adjustmentIds = new Set<string>();
  if (!Array.isArray(adjustments)) {
    push(issues, 'ADJUSTMENTS_REQUIRED', 'adjustments', 'Categorized adjustments must be supplied as a list; use an empty list when none exist.');
  } else {
    adjustments.forEach((row, index) => {
      const path = `adjustments[${index}]`;
      if (!isObject(row)) {
        push(issues, 'INVALID_ADJUSTMENT', path, 'An adjustment object is required.');
        return;
      }
      if (!nonEmpty(row.adjustmentId)) push(issues, 'ADJUSTMENT_ID_REQUIRED', `${path}.adjustmentId`, 'Adjustment ID is required.');
      else if (adjustmentIds.has(row.adjustmentId)) push(issues, 'DUPLICATE_ADJUSTMENT', `${path}.adjustmentId`, 'Adjustment IDs must be unique.');
      else adjustmentIds.add(row.adjustmentId);
      if (!ADJUSTMENT_CATEGORIES.includes(row.category as AdjustmentCategory)) {
        push(issues, 'UNSUPPORTED_ADJUSTMENT_CATEGORY', `${path}.category`, 'Adjustment category is unsupported.');
      } else if (row.category === 'other') {
        push(issues, 'UNRESOLVED_ADJUSTMENT_CATEGORY', `${path}.category`, 'Other adjustments require a resolved component mapping.', 'blocked');
      }
      if (row.category === 'equity' && typeof row.includedInArticle28ClosingEquity !== 'boolean') {
        push(issues, 'ARTICLE28_EQUITY_ADJUSTMENT_SCOPE_REQUIRED', `${path}.includedInArticle28ClosingEquity`, 'Equity adjustment must state whether it is already included in closing equity for the Article 28 ceiling.');
      }
      if (row.direction !== 'add' && row.direction !== 'deduct') push(issues, 'INVALID_ADJUSTMENT_DIRECTION', `${path}.direction`, 'Direction must be add or deduct.');
      const adjustmentAmount = money(row.amountSar, `${path}.amountSar`, issues, true);
      if (row.category === 'profit' && adjustmentAmount !== null && adjustmentAmount !== 0n) {
        if (!ARTICLE63_EXPENSE_CATEGORIES.includes(row.article63ExpenseCategory as Article63ExpenseCategory)) {
          push(issues, 'ARTICLE63_BASIS_REQUIRED', `${path}.article63ExpenseCategory`, 'A nonzero profit adjustment must identify an enumerated Article 63 expense basis.');
        }
        validateReviewAttestation(row.reviewAttestation, `${path}.reviewAttestation`, issues);
      }
      validateSourceReference(row.sourceReference, `${path}.sourceReference`, issues);
      validateEvidence(row.evidence, `${path}.evidence`, issues);
      if (Array.isArray(row.evidence) && row.evidence.length === 0) push(issues, 'ADJUSTMENT_EVIDENCE_REQUIRED', `${path}.evidence`, 'Categorized adjustment requires supporting evidence.');
      if (!isDecisionId(row.regulatoryDecisionReferenceId, decisionIds)) {
        push(issues, 'INVALID_ADJUSTMENT_DECISION_REFERENCE', `${path}.regulatoryDecisionReferenceId`, 'Adjustment must reference a declared regulatory decision.');
      }
    });
  }

  if (!isObject(input.finalizedBookResult)) {
    push(issues, 'FINALIZED_BOOK_RESULT_REQUIRED', 'finalizedBookResult', 'Finalized book result and source evidence are required.');
  } else {
    money(input.finalizedBookResult.amountSar, 'finalizedBookResult.amountSar', issues);
    if (input.finalizedBookResult.status !== 'finalized') push(issues, 'BOOK_RESULT_NOT_FINALIZED', 'finalizedBookResult.status', 'A finalized accounting result is required.', 'blocked');
    if (input.finalizedBookResult.includesActuallyRecordedZakatAndTax !== true) push(issues, 'ACTUAL_RECORDED_CHARGES_REQUIRED', 'finalizedBookResult.includesActuallyRecordedZakatAndTax', 'The supplied finalized result must identify actually recorded Zakat and tax charges; none are inferred.', 'blocked');
    validateSourceReference(input.finalizedBookResult.sourceReference, 'finalizedBookResult.sourceReference', issues);
    validateEvidence(input.finalizedBookResult.evidence, 'finalizedBookResult.evidence', issues);
    if (Array.isArray(input.finalizedBookResult.evidence) && input.finalizedBookResult.evidence.length === 0) push(issues, 'BOOK_RESULT_EVIDENCE_REQUIRED', 'finalizedBookResult.evidence', 'Finalized book result requires source evidence.');
    if (!Array.isArray(input.finalizedBookResult.actuallyRecordedCharges)) {
      push(issues, 'RECORDED_CHARGES_REQUIRED', 'finalizedBookResult.actuallyRecordedCharges', 'Supply actually recorded Zakat/tax charges; use an empty list when none were recorded.');
    } else {
      const chargeIds = new Set<string>();
      input.finalizedBookResult.actuallyRecordedCharges.forEach((charge, index) => {
        const path = `finalizedBookResult.actuallyRecordedCharges[${index}]`;
        if (!isObject(charge)) {
          push(issues, 'INVALID_RECORDED_CHARGE', path, 'A recorded charge object is required.');
          return;
        }
        if (!nonEmpty(charge.chargeId) || chargeIds.has(charge.chargeId)) push(issues, 'DUPLICATE_OR_MISSING_RECORDED_CHARGE_ID', `${path}.chargeId`, 'Recorded charge IDs must be present and unique.');
        else chargeIds.add(charge.chargeId);
        if (!['zakat_provision', 'tax_provision', 'zakat_paid', 'tax_paid'].includes(charge.kind as string)) push(issues, 'INVALID_RECORDED_CHARGE_KIND', `${path}.kind`, 'Only actual Zakat or tax provisions/payments are supported.');
        money(charge.amountSar, `${path}.amountSar`, issues, true);
        if (charge.includedInFinalizedBookResult !== true) push(issues, 'RECORDED_CHARGE_NOT_IN_BOOK_RESULT', `${path}.includedInFinalizedBookResult`, 'Only charges actually included in the finalized book result are accepted.');
        validateSourceReference(charge.sourceReference, `${path}.sourceReference`, issues);
        const evidenceOk = validateEvidence(charge.evidence, `${path}.evidence`, issues);
        if (evidenceOk && Array.isArray(charge.evidence) && charge.evidence.length === 0) push(issues, 'RECORDED_CHARGE_EVIDENCE_REQUIRED', `${path}.evidence`, 'Recorded charge requires ledger or payment evidence.');
      });
    }
  }

  if (!isObject(input.adjustedProfit)) {
    push(issues, 'ADJUSTED_PROFIT_REQUIRED', 'adjustedProfit', 'Adjusted profit/loss, provenance, and decision reference are required.');
  } else {
    money(input.adjustedProfit.amountSar, 'adjustedProfit.amountSar', issues);
    if (!Array.isArray(input.adjustedProfit.sourceReferences) || input.adjustedProfit.sourceReferences.length === 0) {
      push(issues, 'ADJUSTED_PROFIT_SOURCE_REQUIRED', 'adjustedProfit.sourceReferences', 'At least one source reference is required.');
    } else input.adjustedProfit.sourceReferences.forEach((ref, index) => validateSourceReference(ref, `adjustedProfit.sourceReferences[${index}]`, issues));
    validateEvidence(input.adjustedProfit.evidence, 'adjustedProfit.evidence', issues);
    if (Array.isArray(input.adjustedProfit.evidence) && input.adjustedProfit.evidence.length === 0) push(issues, 'ADJUSTED_PROFIT_EVIDENCE_REQUIRED', 'adjustedProfit.evidence', 'Adjusted profit/loss requires source evidence.');
    if (!isDecisionId(input.adjustedProfit.regulatoryDecisionReferenceId, decisionIds)) {
      push(issues, 'ADJUSTED_PROFIT_DECISION_REFERENCE_REQUIRED', 'adjustedProfit.regulatoryDecisionReferenceId', 'Adjusted profit/loss must reference a declared regulatory decision.');
    }
  }
  if (isObject(input.adjustedProfit) && isObject(input.finalizedBookResult) && Array.isArray(input.adjustments)) {
    const bookResult = money(input.finalizedBookResult.amountSar, 'finalizedBookResult.amountSar', issues);
    const adjustedResult = money(input.adjustedProfit.amountSar, 'adjustedProfit.amountSar', issues);
    const profitAdjustments = input.adjustments.reduce((sum, adjustment, index) => {
      if (!isObject(adjustment) || adjustment.category !== 'profit') return sum;
      const amount = money(adjustment.amountSar, `adjustments[${index}].amountSar`, issues, true);
      if (amount === null) return sum;
      return sum + (adjustment.direction === 'add' ? amount : adjustment.direction === 'deduct' ? -amount : 0n);
    }, 0n);
    if (bookResult !== null && adjustedResult !== null && bookResult + profitAdjustments !== adjustedResult) {
      push(issues, 'ADJUSTED_PROFIT_RECONCILIATION_MISMATCH', 'adjustedProfit.amountSar', 'Finalized book result plus signed, evidenced profit adjustments must equal adjusted profit/loss.');
    }
  }

  const allocationAccounts = { deductible: new Set<string>(), undeducted: new Set<string>() };
  const allocationByAccount = new Map<string, { deductible: bigint; undeducted: bigint }>();
  const allocatedHalalas = { deductible: 0n, undeducted: 0n };
  const validateAllocations = (rows: unknown, path: string, kind: 'deductible' | 'undeducted') => {
    if (!Array.isArray(rows)) {
      push(issues, 'ASSET_ALLOCATIONS_REQUIRED', path, 'Asset allocation list is required; use an empty list when none exist.');
      return;
    }
    rows.forEach((row, index) => {
      const rowPath = `${path}[${index}]`;
      if (!isObject(row)) {
        push(issues, 'INVALID_ASSET_ALLOCATION', rowPath, 'An asset allocation object is required.');
        return;
      }
      const accountId = nonEmpty(row.accountId) ? row.accountId : null;
      if (accountId === null) push(issues, 'ASSET_ACCOUNT_REQUIRED', `${rowPath}.accountId`, 'Asset allocation account ID is required.');
      else if (allocationAccounts[kind].has(accountId)) push(issues, 'DUPLICATE_ASSET_ALLOCATION', `${rowPath}.accountId`, `An account may appear only once in ${kind} allocations.`);
      else allocationAccounts[kind].add(accountId);
      const amount = money(row.amountSar, `${rowPath}.amountSar`, issues, true);
      if (amount !== null) {
        allocatedHalalas[kind] += amount;
        if (accountId !== null) {
          const allocated = allocationByAccount.get(accountId) ?? { deductible: 0n, undeducted: 0n };
          allocated[kind] += amount;
          allocationByAccount.set(accountId, allocated);
        }
      }
      if (row.eligibilityStatus !== 'verified' && row.eligibilityStatus !== 'pending') {
        push(issues, 'ASSET_ELIGIBILITY_STATUS_REQUIRED', `${rowPath}.eligibilityStatus`, 'Asset treatment must be explicitly verified or pending.');
      } else if (row.eligibilityStatus === 'pending') {
        push(issues, 'ASSET_ELIGIBILITY_UNVERIFIED', `${rowPath}.eligibilityStatus`, 'Pending asset eligibility blocks base composition.', 'blocked');
      }
      validateReviewAttestation(row.reviewAttestation, `${rowPath}.reviewAttestation`, issues);
      const source = accountId === null ? undefined : accountRows.get(accountId);
      if (!source) push(issues, 'ASSET_ACCOUNT_NOT_IN_SOURCE', `${rowPath}.accountId`, 'Asset allocation must refer to a source balance account.');
      else if (source.category !== 'current_asset' && source.category !== 'non_current_asset') push(issues, 'ASSET_ALLOCATION_NOT_ASSET', `${rowPath}.accountId`, 'Asset allocation must refer to an asset statement category.');
      else if (amount !== null && source.total < 0n) push(issues, 'NEGATIVE_ASSET_BALANCE_UNRESOLVED', `${rowPath}.accountId`, 'A negative asset balance requires accounting resolution and cannot be allocated as an asset.', 'blocked');
      else if (amount !== null && amount > source.total) push(issues, 'ASSET_ALLOCATION_EXCEEDS_SOURCE', `${rowPath}.amountSar`, 'Asset allocation exceeds the source balance.');
      const rowBalance = Array.isArray(input.sourceBalances) && accountId !== null ? input.sourceBalances.find((candidate) => isObject(candidate) && candidate.accountId === accountId) : undefined;
      if (isObject(rowBalance) && isClassification(rowBalance.classification)) {
        const component = CLASSIFICATION_COMPONENTS[rowBalance.classification];
        if (kind === 'deductible' && component !== 'deductible_asset_candidate') {
          push(issues, 'ASSET_CLASSIFICATION_MISMATCH', `${rowPath}.accountId`, 'Deductible candidates must reference an account explicitly classified as a deductible asset candidate.');
        }
        if (kind === 'undeducted' && component !== 'deductible_asset_candidate' && component !== 'non_deductible_asset') {
          push(issues, 'ASSET_CLASSIFICATION_MISMATCH', `${rowPath}.accountId`, 'Undeducted assets must reference an explicitly classified asset account.');
        }
      }
      validateSourceReference(row.sourceReference, `${rowPath}.sourceReference`, issues);
      validateEvidence(row.evidence, `${rowPath}.evidence`, issues);
      if (Array.isArray(row.evidence) && row.evidence.length === 0) push(issues, 'ASSET_EVIDENCE_REQUIRED', `${rowPath}.evidence`, 'Asset allocation requires supporting evidence.');
      if (!isDecisionId(row.regulatoryDecisionReferenceId, decisionIds)) push(issues, 'ASSET_DECISION_REFERENCE_REQUIRED', `${rowPath}.regulatoryDecisionReferenceId`, 'Asset allocation must reference a declared regulatory decision.');
    });
  };
  validateAllocations(input.deductibleAssetCandidates, 'deductibleAssetCandidates', 'deductible');
  validateAllocations(input.undeductedAssets, 'undeductedAssets', 'undeducted');

  if (Array.isArray(input.sourceBalances)) {
    for (const [index, row] of input.sourceBalances.entries()) {
      if (!isObject(row) || (row.statementCategory !== 'current_asset' && row.statementCategory !== 'non_current_asset')) continue;
      const balance = money(row.amountSar, `sourceBalances[${index}].amountSar`, issues);
      if (balance === null) continue;
      const allocated = allocationByAccount.get(String(row.accountId)) ?? { deductible: 0n, undeducted: 0n };
      if (balance < 0n) {
        push(issues, 'NEGATIVE_ASSET_BALANCE_UNRESOLVED', `sourceBalances[${index}].amountSar`, 'Negative asset balances cannot be treated as deductible or undeducted assets without accounting resolution.', 'blocked');
      } else if (allocated.deductible + allocated.undeducted !== balance) {
        push(issues, 'ASSET_SOURCE_ALLOCATION_MISMATCH', `sourceBalances[${index}].accountId`, 'Each source asset balance must be allocated completely between eligible deductible and undeducted portions.');
      }
    }
  }

  const article73 = input.article73Assessment;
  if (!isObject(article73)) {
    push(issues, 'ARTICLE_73_ASSESSMENT_REQUIRED', 'article73Assessment', 'A documented Article 73 review is required; use an empty project list when there is no relevant activity.');
  } else {
    if (article73.reviewed !== true) push(issues, 'ARTICLE_73_REVIEW_REQUIRED', 'article73Assessment.reviewed', 'Article 73 activity must be assessed before asset treatment.', 'blocked');
    validateSourceReference(article73.sourceReference, 'article73Assessment.sourceReference', issues);
    const assessmentEvidenceOk = validateEvidence(article73.evidence, 'article73Assessment.evidence', issues);
    if (assessmentEvidenceOk && Array.isArray(article73.evidence) && article73.evidence.length === 0) push(issues, 'ARTICLE_73_EVIDENCE_REQUIRED', 'article73Assessment.evidence', 'The project inventory review requires evidence.');
    validateReviewAttestation(article73.reviewAttestation, 'article73Assessment.reviewAttestation', issues);
    if (!isDecisionId(article73.regulatoryDecisionReferenceId, decisionIds)) push(issues, 'ARTICLE_73_DECISION_REFERENCE_REQUIRED', 'article73Assessment.regulatoryDecisionReferenceId', 'Article 73 review must reference a declared regulatory decision.');
    if (!Array.isArray(article73.projects)) push(issues, 'ARTICLE_73_PROJECT_LIST_REQUIRED', 'article73Assessment.projects', 'Supply project facts; use an empty list when no Article 73 projects exist.');
    else {
      const projectAccounts = new Set<string>();
      article73.projects.forEach((project, index) => {
        const path = `article73Assessment.projects[${index}]`;
        if (!isObject(project)) {
          push(issues, 'INVALID_ARTICLE_73_PROJECT', path, 'An Article 73 project facts object is required.');
          return;
        }
        if (!nonEmpty(project.projectId)) push(issues, 'ARTICLE_73_PROJECT_ID_REQUIRED', `${path}.projectId`, 'Project ID is required to apply project-level Article 73 calculations.');
        const accountId = nonEmpty(project.accountId) ? project.accountId : null;
        if (accountId === null) push(issues, 'ARTICLE_73_ACCOUNT_REQUIRED', `${path}.accountId`, 'Project must map to a source account.');
        else if (projectAccounts.has(accountId)) push(issues, 'DUPLICATE_ARTICLE_73_PROJECT', `${path}.accountId`, 'Each project account may be assessed once.');
        else projectAccounts.add(accountId);
        if (project.treatment !== 'construction_sale_after_completion' && project.treatment !== 'licensed_off_plan_sale') push(issues, 'ARTICLE_73_PROJECT_TREATMENT_REQUIRED', `${path}.treatment`, 'Project must be classified as construction sale-after-completion or licensed off-plan sale.');
        if (typeof project.licensedForOffPlanSale !== 'boolean' || typeof project.isUnderConstruction !== 'boolean' || typeof project.intendedForSaleAfterCompletion !== 'boolean' || typeof project.offeredForSaleAsIs !== 'boolean') {
          push(issues, 'ARTICLE_73_PROJECT_FACTS_REQUIRED', path, 'Construction, sale-intent, and as-is offer facts must be explicit.', 'blocked');
        }
        if (project.treatment === 'licensed_off_plan_sale') {
          if (project.licensedForOffPlanSale !== true) push(issues, 'ARTICLE_73_OFFPLAN_LICENSE_REQUIRED', `${path}.licensedForOffPlanSale`, 'Article 73(2) treatment requires a license from the competent authority.', 'blocked');
        }
        if (project.statementCategory !== 'current_asset' && project.statementCategory !== 'non_current_asset') push(issues, 'INVALID_ARTICLE_73_ASSET_CATEGORY', `${path}.statementCategory`, 'Article 73 project must map to an asset category.');
        const opening = money(project.openingBalanceSar, `${path}.openingBalanceSar`, issues, true);
        const additions = money(project.additionsSar, `${path}.additionsSar`, issues, true);
        const costOfSales = money(project.costOfSalesSar, `${path}.costOfSalesSar`, issues, true);
        const otherMovements = money(project.otherMovementsSar, `${path}.otherMovementsSar`, issues);
        const closing = money(project.closingBalanceSar, `${path}.closingBalanceSar`, issues, true);
        const denominator = opening === null || additions === null ? null : opening + additions;
        if (project.treatment !== 'licensed_off_plan_sale' && denominator === 0n) push(issues, 'ARTICLE_73_ZERO_COST_BASE', path, 'Project cost-of-sales ratio cannot be assessed against a zero opening balance plus additions.', 'blocked');
        else if (project.treatment !== 'licensed_off_plan_sale' && denominator !== null && costOfSales !== null && costOfSales > denominator) push(issues, 'ARTICLE_73_COST_SALES_EXCEEDS_COST_BASE', path, 'Project cost of sales exceeds its opening balance plus additions.');
        if (project.treatment !== 'licensed_off_plan_sale' && opening !== null && additions !== null && costOfSales !== null && otherMovements !== null && closing !== null && opening + additions - costOfSales + otherMovements !== closing) {
          push(issues, 'ARTICLE_73_PROJECT_ROLLFORWARD_MISMATCH', path, 'Opening project cost plus additions less cost of sales and plus other movements must equal the closing balance.');
        }
        validateSourceReference(project.sourceReference, `${path}.sourceReference`, issues);
        const projectEvidenceOk = validateEvidence(project.evidence, `${path}.evidence`, issues);
        if (projectEvidenceOk && Array.isArray(project.evidence) && project.evidence.length === 0) push(issues, 'ARTICLE_73_PROJECT_EVIDENCE_REQUIRED', `${path}.evidence`, 'Project-specific accounting and sale-status evidence is required.');
        if (accountId !== null) {
          const sourceRow = Array.isArray(input.sourceBalances) ? input.sourceBalances.find((row) => isObject(row) && row.accountId === accountId) : undefined;
          if (!isObject(sourceRow) || sourceRow.statementCategory !== project.statementCategory) push(issues, 'ARTICLE_73_PROJECT_SOURCE_MISMATCH', `${path}.accountId`, 'Project facts must match a source asset account and category.');
          else {
            const sourceAmount = money(sourceRow.amountSar, `${path}.sourceBalance`, issues);
            if (sourceAmount !== null && closing !== null && sourceAmount !== closing) push(issues, 'ARTICLE_73_CLOSING_BALANCE_MISMATCH', `${path}.closingBalanceSar`, 'Project closing rollforward must match the source trial-balance account amount.');
          }
        }
      });
    }
  }
  const article73Projects = isObject(article73) && Array.isArray(article73.projects) ? article73.projects : null;
  if (article73Projects !== null) {
    const groups = new Map<string, Record<string, unknown>[]>();
    article73Projects.forEach((project) => {
      if (!isObject(project) || !nonEmpty(project.projectId)) return;
      groups.set(project.projectId, [...(groups.get(project.projectId) ?? []), project]);
    });
    const deductibleByAccount = new Map<string, bigint>();
    if (Array.isArray(input.deductibleAssetCandidates)) {
      input.deductibleAssetCandidates.forEach((row) => {
        if (!isObject(row) || !nonEmpty(row.accountId)) return;
        const amount = money(row.amountSar, `deductibleAssetCandidates.${row.accountId}.amountSar`, issues, true);
        if (amount !== null) deductibleByAccount.set(row.accountId, amount);
      });
    }
    for (const [projectId, rows] of groups) {
      const path = `article73Assessment.projects[projectId=${projectId}]`;
      const treatments = new Set(rows.map((row) => row.treatment));
      if (treatments.size !== 1) {
        push(issues, 'ARTICLE_73_MIXED_PROJECT_TREATMENT', path, 'A project cannot mix under-construction and licensed off-plan treatments.', 'blocked');
        continue;
      }
      const treatment = rows[0].treatment;
      const currentBalance = rows.filter((row) => row.statementCategory === 'current_asset').reduce((sum, row) => sum + (money(row.closingBalanceSar, `${path}.closingBalanceSar`, issues, true) ?? 0n), 0n);
      const nonCurrentBalance = rows.filter((row) => row.statementCategory === 'non_current_asset').reduce((sum, row) => sum + (money(row.closingBalanceSar, `${path}.closingBalanceSar`, issues, true) ?? 0n), 0n);
      let expectedCurrentDeduction = 0n;
      let expectedNonCurrentDeduction = 0n;
      if (treatment === 'construction_sale_after_completion') {
        const opening = rows.reduce((sum, row) => sum + (money(row.openingBalanceSar, `${path}.openingBalanceSar`, issues, true) ?? 0n), 0n);
        const additions = rows.reduce((sum, row) => sum + (money(row.additionsSar, `${path}.additionsSar`, issues, true) ?? 0n), 0n);
        const costOfSales = rows.reduce((sum, row) => sum + (money(row.costOfSalesSar, `${path}.costOfSalesSar`, issues, true) ?? 0n), 0n);
        const meetsRatio = opening + additions > 0n && costOfSales * 4n <= opening + additions;
        const qualifies = meetsRatio && rows.every((row) => row.isUnderConstruction === true && row.intendedForSaleAfterCompletion === true && row.offeredForSaleAsIs === false);
        if (qualifies) {
          expectedCurrentDeduction = currentBalance;
          expectedNonCurrentDeduction = nonCurrentBalance;
        }
      } else {
        if (!rows.every((row) => row.licensedForOffPlanSale === true)) push(issues, 'ARTICLE_73_OFFPLAN_LICENSE_REQUIRED', path, 'Every off-plan project must have evidence of competent-authority licensing.', 'blocked');
        const closing = currentBalance + nonCurrentBalance;
        const additions = rows.reduce((sum, row) => sum + (money(row.additionsSar, `${path}.additionsSar`, issues, true) ?? 0n), 0n);
        const deduction = closing > additions ? closing - additions : 0n;
        expectedNonCurrentDeduction = deduction < nonCurrentBalance ? deduction : nonCurrentBalance;
        const remaining = deduction - expectedNonCurrentDeduction;
        expectedCurrentDeduction = remaining < currentBalance ? remaining : currentBalance;
      }
      const observedCurrent = rows.filter((row) => row.statementCategory === 'current_asset').reduce((sum, row) => sum + (nonEmpty(row.accountId) ? deductibleByAccount.get(row.accountId) ?? 0n : 0n), 0n);
      const observedNonCurrent = rows.filter((row) => row.statementCategory === 'non_current_asset').reduce((sum, row) => sum + (nonEmpty(row.accountId) ? deductibleByAccount.get(row.accountId) ?? 0n : 0n), 0n);
      if (observedCurrent !== expectedCurrentDeduction || observedNonCurrent !== expectedNonCurrentDeduction) {
        push(issues, 'ARTICLE_73_DEDUCTION_ALLOCATION_MISMATCH', path, 'Project deductible allocations must match Article 73: qualifying construction projects use eligible closing balances; licensed off-plan projects deduct closing balance less annual additions, starting with noncurrent assets.', 'blocked');
      }
    }
  }

  if (!isObject(input.declaredAssetTotals)) {
    push(issues, 'DECLARED_ASSET_TOTALS_REQUIRED', 'declaredAssetTotals', 'Deductible-candidate and undeducted asset totals are required.');
  } else {
    const deductible = money(input.declaredAssetTotals.deductibleCandidateSar, 'declaredAssetTotals.deductibleCandidateSar', issues, true);
    const undeducted = money(input.declaredAssetTotals.undeductedSar, 'declaredAssetTotals.undeductedSar', issues, true);
    if (deductible !== null && deductible !== allocatedHalalas.deductible) push(issues, 'ASSET_TOTAL_MISMATCH', 'declaredAssetTotals.deductibleCandidateSar', 'Declared deductible-candidate total does not match allocations.');
    if (undeducted !== null && undeducted !== allocatedHalalas.undeducted) push(issues, 'ASSET_TOTAL_MISMATCH', 'declaredAssetTotals.undeductedSar', 'Declared undeducted total does not match allocations.');
  }

  if (issues.length > 0) return { valid: false, version, mappedAccounts: [], issues };
  return { valid: true, version: ZAKAT_CALCULATION_INPUT_VERSION, mappedAccounts, issues: [] };
}
