import { Pool, PoolClient } from 'pg';

/**
 * S1 (mid-year cut-over, full-year statements): what a report must disclose about the dates up to D that EQFAL does not hold natively.
 * Read-only. Returns null when the fiscal year has no active cut-over range, so January-1 companies get no new field and no new query.
 *
 * Two separate ideas, never merged:
 *  - availability: whether EQFAL can compute the statement from its own ledger (the cut-over journal + native activity);
 *  - full-year completeness: whether the pre-cut-over history behind it is verified. S1 has no historical supplements, so it is NEVER
 *    verified here; an active cut-over range alone certifies nothing.
 * Legacy activations (before S1) carry no `pre_closing_trial_balance` acknowledgement or source system: they are disclosed as missing
 * evidence and their stored activation snapshot is only read, never rewritten.
 */
export type StatementKey = 'income_statement' | 'financial_position' | 'changes_in_equity' | 'cash_flow';
export type Completeness = {
  availability: 'ledger_calculated' | 'post_cutover_only';
  full_year_complete: false;
  status: 'unverified';
  reasons: string[];
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
};

type Row = {
  from_date: string; to_date: string; cutover_journal_id: string | null; tb_reference: string | null; tb_prepared_by: string | null;
  acknowledgements: Record<string, unknown> | null; activation_snapshot: Record<string, unknown> | null;
};

export const LIMITATIONS = ['PRE_CUTOVER_ACCOUNT_LEVEL_ONLY', 'PRE_CUTOVER_PNL_AGGREGATED_AT_CUTOVER_DATE', 'HISTORICAL_DATA_NOT_VERIFIED_BY_EQFAL'] as const;

/** Pure: builds the disclosure from the stored range (exported for unit tests). */
export function buildCutoverDisclosure(row: Row): CutoverDisclosure {
  const acknowledged = row.acknowledgements?.['pre_closing_trial_balance'] === true;
  const sourceRaw = row.activation_snapshot?.['tb_source_system'];
  const source = typeof sourceRaw === 'string' && sourceRaw.trim() ? sourceRaw.trim() : null;
  const evidence: string[] = [];
  if (!acknowledged) evidence.push('TB_BASIS_NOT_RECORDED');
  if (!source) evidence.push('TB_SOURCE_SYSTEM_NOT_RECORDED');
  const base = ['HISTORICAL_SUPPLEMENTS_NOT_AVAILABLE', ...evidence];
  const ledger = (extra: string[] = []): Completeness => ({ availability: 'ledger_calculated', full_year_complete: false, status: 'unverified', reasons: [...base, ...extra] });
  return {
    cutover_from: row.from_date, cutover_date: row.to_date, cutover_journal_id: row.cutover_journal_id,
    tb_reference: row.tb_reference, tb_prepared_by: row.tb_prepared_by, tb_source_system: source,
    tb_basis: acknowledged ? 'pre_closing_acknowledged' : 'not_recorded',
    evidence_missing: evidence, limitations: [...LIMITATIONS],
    completeness: {
      income_statement: ledger(),
      financial_position: ledger(),
      changes_in_equity: ledger(['PRE_CUTOVER_EQUITY_MOVEMENTS_NOT_RECORDED']),
      cash_flow: { availability: 'post_cutover_only', full_year_complete: false, status: 'unverified', reasons: [...base, 'PRE_CUTOVER_CASH_FLOWS_NOT_RECORDED'] },
    },
  };
}

/** Adds `pre_cutover` (the disclosure plus this statement's own completeness) only when the year has an active cut-over range. */
export function preCutover(disclosure: CutoverDisclosure | null, key: StatementKey) {
  if (!disclosure) return {};
  const { completeness, ...rest } = disclosure;
  return { pre_cutover: { ...rest, completeness: completeness[key] } };
}

/** The active range overlapping the fiscal year (same selection as CUTOVER_BOUNDS_SQL). */
export async function loadCutoverDisclosure(db: Pick<Pool | PoolClient, 'query'>, companyId: string, fiscalYearId: string): Promise<CutoverDisclosure | null> {
  const row = (await db.query<Row>(
    `SELECT a.from_date::text,a.to_date::text,a.cutover_journal_id,a.tb_reference,a.tb_prepared_by,a.acknowledgements,a.activation_snapshot
     FROM ledger_source_authority a JOIN fiscal_years f ON f.company_id=a.company_id AND f.id=$2
     WHERE a.company_id=$1 AND a.status='active' AND a.from_date<=f.end_date AND a.to_date>=f.start_date
     ORDER BY a.from_date LIMIT 1`, [companyId, fiscalYearId],
  )).rows[0];
  return row ? buildCutoverDisclosure(row) : null;
}
