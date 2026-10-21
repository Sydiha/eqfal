import { Pool, PoolClient } from 'pg';
import { loadSupplementStatus, SupplementKind, SupplementStatus } from './cutover-supplements';

/**
 * S1 (mid-year cut-over, full-year statements): what a report must disclose about the dates up to D that EQFAL does not hold natively.
 * Read-only. Returns null when the fiscal year has no active cut-over range, so January-1 companies get no new field and no new query.
 *
 * Two separate ideas, never merged:
 *  - availability: whether EQFAL can compute the statement from its own ledger (the cut-over journal + native activity);
 *  - full-year completeness: whether the pre-cut-over history behind it is supported. S2 (spec v2, section F): computed on every request,
 *    never stored. Income statement / financial position: the ledger holds them (cut-over journal + native) once the range is active and the
 *    trial-balance evidence is recorded. Cash flow / changes in equity: only with an APPROVED supplement of that kind whose invariants still hold
 *    against the current cut-over journal. `status: 'reconciled'` means the recorded evidence reconciles; EQFAL never verifies external history.
 * Legacy activations (before S1) carry no `pre_closing_trial_balance` acknowledgement or source system: they are disclosed as missing
 * evidence and their stored activation snapshot is only read, never rewritten.
 */
export type StatementKey = 'income_statement' | 'financial_position' | 'changes_in_equity' | 'cash_flow';
export type Completeness = {
  availability: 'ledger_calculated' | 'post_cutover_only';
  full_year_complete: boolean;
  status: 'unverified' | 'reconciled';
  reasons: string[];
  /** S2: the supplement behind cash flow / changes in equity (absent for the ledger-only statements). */
  supplement?: { version_no: number | null; state: SupplementStatus['state']; revision_pending: boolean };
};
export type CutoverDisclosure = {
  cutover_from: string;
  cutover_date: string;
  cutover_journal_id: string | null;
  tb_reference: string | null;
  tb_prepared_by: string | null;
  tb_source_system: string | null;
  tb_basis: 'pre_closing_acknowledged' | 'not_recorded';
  evidence_missing: string[];
  limitations: string[];
  completeness: Record<StatementKey, Completeness>;
  /** S2: approved supplement status per kind (null when the disclosure was built without them, e.g. unit tests of S1 behaviour). */
  supplements: Record<SupplementKind, SupplementStatus> | null;
};

type Row = {
  fy_start?: string; from_date: string; to_date: string; cutover_journal_id: string | null; tb_reference: string | null; tb_prepared_by: string | null;
  acknowledgements: Record<string, unknown> | null; activation_snapshot: Record<string, unknown> | null;
};

export const LIMITATIONS = ['PRE_CUTOVER_ACCOUNT_LEVEL_ONLY', 'PRE_CUTOVER_PNL_AGGREGATED_AT_CUTOVER_DATE', 'HISTORICAL_DATA_NOT_VERIFIED_BY_EQFAL'] as const;

/** Pure: builds the disclosure from the stored range and (S2) the computed supplement status (exported for unit tests). */
export function buildCutoverDisclosure(row: Row, supplements: Record<SupplementKind, SupplementStatus> | null = null): CutoverDisclosure {
  const acknowledged = row.acknowledgements?.['pre_closing_trial_balance'] === true;
  const sourceRaw = row.activation_snapshot?.['tb_source_system'];
  const source = typeof sourceRaw === 'string' && sourceRaw.trim() ? sourceRaw.trim() : null;
  const evidence: string[] = [];
  if (!acknowledged) evidence.push('TB_BASIS_NOT_RECORDED');
  if (!source) evidence.push('TB_SOURCE_SYSTEM_NOT_RECORDED');
  const yearStart = row.fy_start === undefined || row.from_date === row.fy_start;
  const ledgerOk = supplements !== null && evidence.length === 0 && yearStart;
  const ledger = (): Completeness => ledgerOk
    ? { availability: 'ledger_calculated', full_year_complete: true, status: 'reconciled', reasons: [] }
    : { availability: 'ledger_calculated', full_year_complete: false, status: 'unverified', reasons: [...(supplements ? [] : ['HISTORICAL_SUPPLEMENTS_NOT_AVAILABLE']), ...evidence, ...(yearStart ? [] : ['CUTOVER_RANGE_NOT_FROM_YEAR_START'])] };
  const supplemented = (kind: SupplementKind, availability: Completeness['availability'], missingReason: string): Completeness => {
    const s = supplements?.[kind];
    if (!s) return { availability, full_year_complete: false, status: 'unverified', reasons: ['HISTORICAL_SUPPLEMENTS_NOT_AVAILABLE', ...evidence, missingReason] };
    const reasons = [...evidence, ...(s.state === 'missing' ? [missingReason] : s.reasons)];
    const complete = s.state === 'complete' && ledgerOk && reasons.length === 0;
    return { availability: complete ? 'ledger_calculated' : availability, full_year_complete: complete, status: complete ? 'reconciled' : 'unverified', reasons, supplement: { version_no: s.version_no, state: s.state, revision_pending: s.revision_pending } };
  };
  return {
    cutover_from: row.from_date, cutover_date: row.to_date, cutover_journal_id: row.cutover_journal_id,
    tb_reference: row.tb_reference, tb_prepared_by: row.tb_prepared_by, tb_source_system: source,
    tb_basis: acknowledged ? 'pre_closing_acknowledged' : 'not_recorded',
    evidence_missing: evidence, limitations: [...LIMITATIONS],
    completeness: {
      income_statement: ledger(),
      financial_position: ledger(),
      changes_in_equity: supplemented('equity', 'ledger_calculated', 'PRE_CUTOVER_EQUITY_MOVEMENTS_NOT_RECORDED'),
      cash_flow: supplemented('cash_flow', 'post_cutover_only', 'PRE_CUTOVER_CASH_FLOWS_NOT_RECORDED'),
    },
    supplements,
  };
}

/**
 * Adds `pre_cutover` (the disclosure plus this statement's own completeness) only when the year has an active cut-over range.
 * Spec F condition 5: completeness applies only to a report that starts on the fiscal year's first day (`fullYearRange`).
 */
export function preCutover(disclosure: CutoverDisclosure | null, key: StatementKey, fullYearRange = true) {
  if (!disclosure) return {};
  const { completeness, supplements: _s, ...rest } = disclosure;
  const own = completeness[key];
  const scoped: Completeness = fullYearRange || !own.full_year_complete ? own : { ...own, full_year_complete: false, status: 'unverified', reasons: ['REPORT_RANGE_NOT_FULL_YEAR'] };
  return { pre_cutover: { ...rest, completeness: scoped, full_year_complete: Object.fromEntries((Object.keys(completeness) as StatementKey[]).map((k) => [k, k === key ? scoped.full_year_complete : completeness[k].full_year_complete])) as Record<StatementKey, boolean> } };
}

/** The active range overlapping the fiscal year (same selection as CUTOVER_BOUNDS_SQL). */
export async function loadCutoverDisclosure(db: Pick<Pool | PoolClient, 'query'>, companyId: string, fiscalYearId: string): Promise<CutoverDisclosure | null> {
  const row = (await db.query<Row>(
    `SELECT f.start_date::text fy_start,a.from_date::text,a.to_date::text,a.cutover_journal_id,a.tb_reference,a.tb_prepared_by,a.acknowledgements,a.activation_snapshot
     FROM ledger_source_authority a JOIN fiscal_years f ON f.company_id=a.company_id AND f.id=$2
     WHERE a.company_id=$1 AND a.status='active' AND a.from_date<=f.end_date AND a.to_date>=f.start_date
     ORDER BY a.from_date LIMIT 1`, [companyId, fiscalYearId],
  )).rows[0];
  return row ? buildCutoverDisclosure(row, await loadSupplementStatus(db, companyId, fiscalYearId)) : null;
}
