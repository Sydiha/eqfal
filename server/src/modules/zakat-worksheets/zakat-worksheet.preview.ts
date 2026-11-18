import { composeZakatBaseComponents, type CompositionLine, type CompositionTotals } from '../zakat-calculation/zakat-base-composition';
import { ZAKAT_CALCULATION_INPUT_VERSION } from '../zakat-calculation/calculation-input';
import type { BalanceAccount } from './zakat-worksheet.rules';

type WorksheetClassification = {
  account_id: string;
  zakat_type: string;
  evidence_document_id: string | null;
};
type WorksheetAdjustment = {
  id: string;
  description: string;
  direction: 'add' | 'deduct';
  amount: string;
  evidence_document_id: string | null;
};
type PreviewInput = {
  worksheet: { id: string; balances_snapshot: { accounts: BalanceAccount[] } | null } | null;
  fiscalYear: { start_date: string; end_date: string };
  functionalCurrency: string | null;
  classifications: WorksheetClassification[];
  adjustments: WorksheetAdjustment[];
  gates: { code: string; status: string }[];
  ownershipQualified: boolean;
  ownershipBlockers: string[];
  readinessBlockers: string[];
};

export type ZakatWorksheetPreview = {
  status: 'BLOCKED' | 'COMPONENTS_ONLY';
  calculation_performed: false;
  final_zakat_base_halalas: null;
  payable_amount_halalas: null;
  totals: CompositionTotals | null;
  lines: CompositionLine[];
  blockers: { code: string; path: string }[];
  missing_requirements: string[];
  worksheet_blockers: string[];
};

const CATEGORIES = ['current_asset', 'non_current_asset', 'current_liability', 'non_current_liability', 'equity'] as const;
const toSar = (cents: string) => {
  const amount = BigInt(cents);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
};
const actualDays = (start: string, end: string) => {
  const first = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  return Number.isFinite(first) && Number.isFinite(last) && last >= first ? Math.floor((last - first) / 86_400_000) + 1 : undefined;
};

/**
 * Maps only worksheet facts into the isolated input contract. Unrepresented accounting facts stay
 * absent so the engine validator reports BLOCKED; none are inferred from free-text references.
 */
export function previewZakatWorksheet(input: PreviewInput): ZakatWorksheetPreview {
  const worksheet = input.worksheet;
  const snapshot = worksheet?.balances_snapshot;
  const classifications = new Map(input.classifications.map((row) => [row.account_id, row]));
  const sourceBalances = (snapshot?.accounts ?? []).flatMap((account) => {
    const classification = classifications.get(account.account_id);
    if (!classification) return [];
    const amount = BigInt(account.amount_cents);
    return [{
      accountId: account.account_id,
      statementCategory: account.statement_category,
      classification: classification.zakat_type,
      amountSar: toSar(account.amount_cents),
      sign: amount > 0n ? 'positive' : amount < 0n ? 'negative' : 'zero',
      sourceReference: { source: 'zakat_worksheet_balance_snapshot', recordId: worksheet!.id },
      evidence: classification.evidence_document_id ? [{ referenceId: classification.evidence_document_id, kind: 'document' }] : [],
      // A worksheet's article text is not an authenticated regulatory decision reference.
      regulatoryDecisionReferenceIds: [],
    }];
  });
  const totals = Object.fromEntries(CATEGORIES.map((category) => [category,
    toSar((snapshot?.accounts ?? []).filter((account) => account.statement_category === category)
      .reduce((sum, account) => sum + BigInt(account.amount_cents), 0n).toString()),
  ]));
  const dayCount = actualDays(input.fiscalYear.start_date, input.fiscalYear.end_date);
  const validationInput: Record<string, unknown> = {
    version: ZAKAT_CALCULATION_INPUT_VERSION,
    fiscalPeriod: {
      startDate: input.fiscalYear.start_date,
      endDate: input.fiscalYear.end_date,
      ...(dayCount === undefined ? {} : { actualDays: dayCount }),
      // The worksheet has no activity-period evidence; keep the state explicitly unresolved.
      activityPeriod: 'unresolved',
    },
    sourceBalances,
    declaredStatementTotals: totals,
    adjustments: input.adjustments.map((adjustment) => ({
      adjustmentId: adjustment.id,
      // Current worksheet adjustments do not record the engine's categorized basis or decision reference.
      direction: adjustment.direction,
      amountSar: adjustment.amount,
      sourceReference: { source: 'zakat_worksheet_adjustments', recordId: adjustment.id },
      evidence: adjustment.evidence_document_id ? [{ referenceId: adjustment.evidence_document_id, kind: 'document' }] : [],
    })),
    // Other fields remain absent until their accounting facts exist in the worksheet.
  };
  const result = composeZakatBaseComponents(validationInput);
  const missing = new Set<string>();
  if (!worksheet) missing.add('worksheet');
  if (input.functionalCurrency !== 'SAR') missing.add('functional_currency_sar');
  missing.add('activity_period');
  if (input.gates.some((gate) => gate.status !== 'verified')) missing.add('regulatory_gates');
  if (!input.ownershipQualified) missing.add('ownership_eligibility');
  if ((snapshot?.accounts ?? []).some((account) => !classifications.has(account.account_id) && BigInt(account.amount_cents) !== 0n)) missing.add('account_classifications');
  if (input.adjustments.length > 0) missing.add('categorized_adjustments');
  for (const blocker of result.blockers) {
    if (blocker.code === 'ACCOUNT_DECISION_REFERENCE_REQUIRED' || blocker.code === 'INVALID_ACCOUNT_DECISION_REFERENCE' || blocker.code === 'REGULATORY_DECISION_REFERENCE_REQUIRED') missing.add('regulatory_decision_evidence');
    if (blocker.code.includes('EVIDENCE_REQUIRED')) missing.add('supporting_evidence');
    if (blocker.code === 'ARTICLE15_ACTIVITY_PERIOD_REQUIRED') missing.add('activity_period');
    if (blocker.code === 'UNSUPPORTED_CLASSIFICATION_COMPONENT' || blocker.code === 'UNRESOLVED_CLASSIFICATION_COMPONENT') missing.add('classification_mapping');
  }
  // More source inputs are not represented in this worksheet's current contract.
  for (const requirement of ['finalized_book_result', 'adjusted_profit', 'liability_reclassifications', 'asset_allocations', 'article73_assessment', 'regulatory_decision_evidence']) missing.add(requirement);
  const worksheetBlockers = [...new Set([...input.ownershipBlockers, ...input.readinessBlockers])].sort();
  const componentsReady = result.status === 'COMPONENTS_ONLY' && input.functionalCurrency === 'SAR' && missing.size === 0 && worksheetBlockers.length === 0;
  const status = componentsReady ? 'COMPONENTS_ONLY' : 'BLOCKED';
  return {
    status,
    calculation_performed: false,
    final_zakat_base_halalas: null,
    payable_amount_halalas: null,
    totals: componentsReady ? result.totals : null,
    lines: componentsReady ? result.lines : [],
    blockers: result.blockers.map(({ code, path }) => ({ code, path })),
    missing_requirements: [...missing].sort(),
    worksheet_blockers: worksheetBlockers,
  };
}
