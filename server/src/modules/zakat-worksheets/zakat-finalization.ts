import { calculateApprovedZakatBase, calculateZakatBase } from '../zakat-calculation/zakat-base-engine';
import {
  STATEMENT_CATEGORIES, ZAKAT_CALCULATION_INPUT_VERSION, type RegulatoryGate, type ZakatCalculationInputV1,
} from '../zakat-calculation/calculation-input';
import { parseSarToHalalas } from '../zakat-calculation/zakat-calculation';
import { actualDays, toSar } from './zakat-worksheet.preview';
import type { BalancesSnapshot } from './zakat-worksheet.rules';

export const regulatoryGates = ['B0', 'B3', 'B4', 'B7', 'B9'] as const;
export type GateDecision = {
  id: string;
  gate: RegulatoryGate;
  source_fingerprint: string;
  evidence_document_id: string;
  evidence_sha256: string;
  evidence_uploader: string;
  authority_reference: string;
  facts: Record<string, unknown>;
  submitted_by: string;
  submitted_at: string;
  reviewed_by: string | null;
  approved_at: string | null;
  reviewer_appointment: string | null;
  reviewer_appointment_id: string | null;
  ended_at: string | null;
  ended_by: string | null;
  end_reason: string | null;
  evidence_current: boolean;
  reviewer_active: boolean;
};

export const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const fields = {
  projects: ['projectId', 'accountId', 'treatment', 'licensedForOffPlanSale', 'isUnderConstruction', 'intendedForSaleAfterCompletion',
    'offeredForSaleAsIs', 'statementCategory', 'openingBalanceSar', 'additionsSar', 'costOfSalesSar', 'otherMovementsSar', 'closingBalanceSar'],
  deductibleAssets: ['accountId', 'amountSar'],
  undeductedAssets: ['accountId', 'amountSar'],
  liabilityReclassifications: ['reclassificationId', 'accountId', 'amountSar', 'treatment', 'currentDebtFacts', 'partnerLoanFacts'],
  lossReconciliations: ['reconciliationId', 'accountId', 'openingLossSar', 'currentPeriodLossSar', 'otherMovementsSar', 'closingLossSar'],
  charges: ['accountId', 'kind', 'amountSar'],
  adjustments: ['adjustmentId', 'category', 'article63ExpenseCategory', 'includedInArticle28ClosingEquity'],
};
const listFields = {
  B0: ['projects', 'deductibleAssets', 'undeductedAssets'],
  B4: ['liabilityReclassifications', 'lossReconciliations'],
  B7: ['charges', 'adjustments'],
  B9: [],
} satisfies Record<Exclude<RegulatoryGate, 'B3'>, (keyof typeof fields)[]>;
const only = (row: Record<string, unknown>, keys: readonly string[]) => Object.keys(row).every((key) => keys.includes(key));

export function validGateFacts(gate: RegulatoryGate, facts: unknown): facts is Record<string, unknown> {
  if (!record(facts)) return false;
  if (gate === 'B3') {
    return only(facts, ['activityPeriod', 'activityDate', 'rounding'])
      && typeof facts.rounding === 'string' && ['HALF_UP', 'HALF_EVEN', 'DOWN'].includes(facts.rounding)
      && (facts.activityPeriod === 'regular' ? facts.activityDate === undefined
        : (facts.activityPeriod === 'cessation' || facts.activityPeriod === 'commencement')
          && typeof facts.activityDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(facts.activityDate));
  }
  const keys = listFields[gate];
  const validKeys = gate === 'B7'
    ? only(facts, [...keys, 'currentEarningsTreatment']) &&
      (facts.currentEarningsTreatment === undefined || facts.currentEarningsTreatment === 'include_in_equity')
    : only(facts, keys);
  return validKeys && keys.every((key) =>
    Array.isArray(facts[key]) && facts[key].every((row) => record(row) && only(row, fields[key])));
}

type Accounting = {
  year: string;
  worksheet: string;
  start: string;
  end: string;
  snapshot: BalancesSnapshot;
  ledgerAccounts: { account_id: string; account_type: string; amount: string }[];
  classifications: { account_id: string; zakat_type: string; evidence_document_id: string | null }[];
  adjustments: { id: string; amount: string; direction: string; evidence_document_id: string | null }[];
};

const rows = (facts: Record<string, unknown>, key: string) => facts[key] as Record<string, unknown>[];

const current = (d: GateDecision, fingerprint: string) =>
  !d.ended_at && d.evidence_current && d.source_fingerprint === fingerprint;

export function decisionStatus(d: GateDecision, fingerprint: string) {
  if (d.ended_at) return 'ended';
  if (!current(d, fingerprint) || (d.reviewed_by && (!d.reviewer_active || !d.reviewer_appointment_id))) return 'stale';
  return d.reviewed_by && d.approved_at ? 'verified' : 'pending';
}

export async function calculateWorksheetFinalization(accounting: Accounting, decisions: GateDecision[], fingerprint: string, approved: { client: import('pg').PoolClient; company: string; actor: string | null } | null, buildOnly = false) {
  const chosen = new Map(decisions.filter((d) => decisionStatus(d, fingerprint) === 'verified' && validGateFacts(d.gate, d.facts)).map((d) => [d.gate, d]));
  const missing = regulatoryGates.filter((gate) => !chosen.has(gate));
  if (missing.length) return { result: null, blockers: missing };
  const evidence = (id: string) => [{ kind: 'document' as const, referenceId: id }];
  const decisionFields = (gate: RegulatoryGate) => {
    const d = chosen.get(gate)!;
    return {
      sourceReference: { source: 'zakat_regulatory_decisions', recordId: d.id },
      evidence: evidence(d.evidence_document_id),
      regulatoryDecisionReferenceId: d.id,
      reviewAttestation: {
        reviewerReference: { source: 'users', recordId: d.reviewed_by! },
        reviewedAt: d.approved_at!, evidence: evidence(d.evidence_document_id),
      },
    };
  };
  const { snapshot, year, start, end } = accounting;
  const p = chosen.get('B3')!.facts;
  const days = actualDays(start, end);
  if (!days || p.activityPeriod === 'cessation' && (days >= 354 || p.activityDate !== end)
    || p.activityPeriod === 'commencement' && (days >= 354 || p.activityDate !== start)
    || p.activityPeriod === 'regular' && days < 354) {
    return { result: null, blockers: ['ARTICLE15_PERIOD_EVIDENCE_MISMATCH'] };
  }

  const assetFacts = chosen.get('B0')!.facts;
  const liabilityFacts = chosen.get('B4')!.facts;
  const profitFacts = chosen.get('B7')!.facts;
  const bookSource = { source: 'posted_fiscal_year', recordId: year };
  const profitEvidence = decisionFields('B7');
  const charges = rows(profitFacts, 'charges');
  const ledger = new Map(accounting.ledgerAccounts.map((row) => [row.account_id, row]));
  if (charges.some((row) => typeof row.accountId !== 'string' || ledger.get(row.accountId)?.account_type !== 'expense'
    || ledger.get(row.accountId)?.amount !== row.amountSar)) {
    return { result: null, blockers: ['RECORDED_CHARGE_LEDGER_MISMATCH'] };
  }

  const adjustmentFacts = rows(profitFacts, 'adjustments');
  const adjustmentById = new Map(adjustmentFacts.map((row) => [row.adjustmentId, row]));
  if (adjustmentFacts.length !== accounting.adjustments.length || adjustmentById.size !== accounting.adjustments.length
    || accounting.adjustments.some((row) => !adjustmentById.has(row.id))) {
    return { result: null, blockers: ['CATEGORIZED_ADJUSTMENTS_MISMATCH'] };
  }
  const adjustments = accounting.adjustments.map((row) => ({
    ...adjustmentById.get(row.id), ...profitEvidence, category: adjustmentById.get(row.id)?.category, adjustmentId: row.id, amountSar: row.amount, direction: row.direction,
    sourceReference: { source: 'zakat_worksheet_adjustments', recordId: row.id },
    evidence: [...profitEvidence.evidence, ...(row.evidence_document_id ? evidence(row.evidence_document_id) : [])],
  }));
  const bookProfit = BigInt(snapshot.current_period_earnings_cents);
  // The report already includes current earnings in equity. Use the exact posted result
  // only when the B7 decision establishes how it enters both equity computations.
  if (bookProfit !== 0n && profitFacts.currentEarningsTreatment !== 'include_in_equity') {
    return { result: null, blockers: ['CURRENT_EARNINGS_TREATMENT_REQUIRED'] };
  }
  const adjustedProfit = adjustments.reduce((total, row) => row['category'] === 'profit'
    ? total + parseSarToHalalas(row.amountSar) * (row.direction === 'add' ? 1n : -1n) : total, bookProfit);

  const lossRows = rows(liabilityFacts, 'lossReconciliations');
  const losses = new Map(lossRows.map((row) => [row.accountId, row.reconciliationId]));
  const classifications = new Map(accounting.classifications.map((row) => [row.account_id, row]));
  if (snapshot.accounts.some((row) => BigInt(row.amount_cents) !== 0n && !classifications.has(row.account_id))) {
    return { result: null, blockers: ['UNCLASSIFIED_BALANCE'] };
  }
  const sourceBalances = snapshot.accounts.filter((row) => classifications.has(row.account_id)).map((row) => {
    const classification = classifications.get(row.account_id)!;
    const amount = BigInt(row.amount_cents);
    return {
      accountId: row.account_id, statementCategory: row.statement_category, classification: classification.zakat_type,
      amountSar: toSar(row.amount_cents), sign: amount === 0n ? 'zero' : amount > 0n ? 'positive' : 'negative',
      sourceReference: { source: 'posted_account', recordId: row.account_id },
      evidence: classification.evidence_document_id ? evidence(classification.evidence_document_id) : [],
      regulatoryDecisionReferenceIds: [decisionFields('B0').regulatoryDecisionReferenceId, decisionFields('B4').regulatoryDecisionReferenceId],
      carriedForwardLossReconciliationId: losses.get(row.account_id),
    };
  });
  const allocations = (key: string) => rows(assetFacts, key).map((row) => ({
    ...row, ...decisionFields('B0'), amountSar: row.amountSar, eligibilityStatus: 'verified',
  }));
  const deductible = allocations('deductibleAssets');
  const undeducted = allocations('undeductedAssets');
  const sumAllocations = (items: ReturnType<typeof allocations>) =>
    toSar(items.reduce((sum, row) => sum + parseSarToHalalas(row.amountSar), 0n).toString());
  const data = {
    version: ZAKAT_CALCULATION_INPUT_VERSION,
    fiscalPeriod: { startDate: start, endDate: end, actualDays: days, activityPeriod: p.activityPeriod },
    sourceBalances,
    declaredStatementTotals: Object.fromEntries(STATEMENT_CATEGORIES.map((category) => [category,
      toSar(snapshot.accounts.filter((row) => row.statement_category === category)
        .reduce((total, row) => total + BigInt(row.amount_cents), 0n).toString()),
    ])),
    adjustments,
    liabilityReclassifications: rows(liabilityFacts, 'liabilityReclassifications').map((row) => ({
      ...row, ...decisionFields('B4'), confirmed: true,
    })),
    carriedForwardLossReconciliations: lossRows.map((row) => ({ ...row, ...decisionFields('B4') })),
    finalizedBookResult: {
      ...profitEvidence, amountSar: toSar(bookProfit.toString()), status: 'finalized',
      includesActuallyRecordedZakatAndTax: true, sourceReference: bookSource,
      actuallyRecordedCharges: charges.map((row) => ({
        chargeId: row.accountId, kind: row.kind, amountSar: row.amountSar, includedInFinalizedBookResult: true,
        sourceReference: { source: 'posted_account', recordId: row.accountId }, evidence: profitEvidence.evidence,
      })),
    },
    adjustedProfit: { ...profitEvidence, amountSar: toSar(adjustedProfit.toString()), sourceReferences: [bookSource] },
    deductibleAssetCandidates: deductible,
    undeductedAssets: undeducted,
    declaredAssetTotals: { deductibleCandidateSar: sumAllocations(deductible), undeductedSar: sumAllocations(undeducted) },
    article73Assessment: {
      ...decisionFields('B0'), reviewed: true,
      projects: rows(assetFacts, 'projects').map((row) => ({ ...row, ...decisionFields('B0') })),
    },
    regulatoryDecisionReferences: regulatoryGates.map((gate) => ({
      ...decisionFields(gate), gate, referenceId: chosen.get(gate)!.id, disposition: 'decision_recorded',
    })),
  } as unknown as ZakatCalculationInputV1;
  const options = { finalRounding: p.rounding as 'HALF_UP' | 'HALF_EVEN' | 'DOWN' };
  if (buildOnly) return { input: data, options, currentEarningsHalalas: bookProfit, result: null, blockers: [] };
  const result = approved ? await calculateApprovedZakatBase(approved.client, approved.company, year, accounting.worksheet, approved.actor) : calculateZakatBase(data, options);
  return { result, blockers: result.blockers.map((blocker) => blocker.code) };
}
