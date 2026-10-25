import { PoolClient } from 'pg';
import type { CompanyReconciliation } from '../banking/bank-reconciliation-core';
import { AnnualClosingService } from '../annual-closing/annual-closing.service';
import { lockAccountingRange } from '../monthly-close/accounting-period.guard';
import { lockVatPeriodScope } from '../vat/vat.router';
import { accountNets, carryforwardMismatches, expectedCarryforward } from './fiscal-year-carryforward';

export interface CloseFinding {
  code: string;
  count: number;
  detail?: string;
}

export interface FiscalYearCloseReadiness {
  ready: boolean;
  blockers: CloseFinding[];
  warnings: CloseFinding[];
}

export class FiscalYearCloseBlockedError extends Error {
  constructor(
    public readonly blockers: CloseFinding[],
    public readonly warnings: CloseFinding[],
  ) {
    super('Fiscal year close is blocked');
  }
}

type CloseYear = { id: string; start_date: string; end_date: string };
const num = (value: unknown): number => Number(value ?? 0) || 0;

/** Dates as plain YYYY-MM-DD text (the repository returns pg Date objects). Call after the row lock. */
export async function loadFiscalYearBounds(client: PoolClient, companyId: string, id: string): Promise<CloseYear> {
  const row = (await client.query<CloseYear>(
    'SELECT id,start_date::text,end_date::text FROM fiscal_years WHERE id=$1 AND company_id=$2', [id, companyId],
  )).rows[0];
  if (!row) throw new Error('Fiscal year not found or access denied');
  return row;
}

/**
 * Serialise the close decision against every writer that can create a REQUIRED
 * blocker. Order (must stay stable; it matches the writers' own order):
 *   1. VAT period/range keys (VAT writers take their VAT key, then the accounting key)
 *   2. accounting-period month keys for the whole fiscal year
 * The fiscal-year row lock (FOR UPDATE) is taken by the caller before this.
 */
export async function lockFiscalYearCloseScope(client: PoolClient, companyId: string, year: CloseYear): Promise<void> {
  await lockVatPeriodScope(companyId, year.start_date, year.end_date, client);
  await lockAccountingRange(companyId, year.start_date, year.end_date, client);
}

export interface ApplicabilityProfile {
  effective_from: string;
  effective_to: string | null;
  version_no: number;
  vat_status: 'not_registered' | 'registered' | 'deregistered' | 'needs_review';
  vat_registered_from: string | null;
  vat_deregistered_from: string | null;
  first_live_accounting_date: string;
}

const dayBefore = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Interval-aware applicability over ALL approved profile versions that
 * intersect the fiscal year (a single version rarely spans the whole year).
 *  · VAT is applicable when any version has a registered window that overlaps
 *    the year; `needs_review` versions (or no profile at all) only raise a
 *    warning and never suppress a known applicable VAT blocker.
 *  · Opening balances are applicable when the authoritative (latest
 *    effective) version's first_live_accounting_date falls inside the year;
 *    with no profile the Monthly Close default (applicable) is kept.
 * Pure function: profiles must be ordered effective_from DESC, version_no DESC.
 */
export function evaluateProfileApplicability(profiles: ApplicabilityProfile[], start: string, end: string) {
  const vatApplicable = profiles.some((p) => {
    if (p.vat_status !== 'registered' && p.vat_status !== 'deregistered') return false;
    const lo = [p.effective_from, start, p.vat_registered_from ?? '0000-01-01'].reduce((a, b) => (a > b ? a : b));
    const hiCandidates = [p.effective_to ?? '9999-12-31', end];
    if (p.vat_status === 'deregistered' && p.vat_deregistered_from) hiCandidates.push(dayBefore(p.vat_deregistered_from));
    const hi = hiCandidates.reduce((a, b) => (a < b ? a : b));
    return lo <= hi;
  });
  const vatNeedsResolution = profiles.length === 0 || profiles.some((p) => p.vat_status === 'needs_review');
  const authoritative = profiles[0];
  const openingApplicable = authoritative
    ? authoritative.first_live_accounting_date >= start && authoritative.first_live_accounting_date <= end
    : true;
  return { vatApplicable, vatRequiresResolution: vatNeedsResolution, openingApplicable };
}

async function loadApplicability(client: PoolClient, companyId: string, year: CloseYear) {
  const { start_date: start, end_date: end, id } = year;
  const profiles = (await client.query<ApplicabilityProfile>(
    `SELECT effective_from::text,effective_to::text,version_no,vat_status,vat_registered_from::text,vat_deregistered_from::text,first_live_accounting_date::text
     FROM company_accounting_profiles
     WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$3::date AND (effective_to IS NULL OR effective_to>=$2::date)
     ORDER BY effective_from DESC,version_no DESC`,
    [companyId, start, end],
  )).rows;
  const approved = (await client.query<{ approved: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM opening_balance_reviews WHERE company_id=$1 AND fiscal_year_id=$2 AND status='approved') approved",
    [companyId, id],
  )).rows[0]!.approved;
  return { ...evaluateProfileApplicability(profiles, start, end), openingApproved: approved, hasProfile: profiles.length > 0 };
}

/**
 * B2 (Owner policy F1): a subsequent fiscal year closes only when the immediately preceding year of the same company is closed and its
 * closing position has been carried into this year's posted opening balance EXACTLY (recomputed from the preceding year's posted ledger,
 * integer halalas). Not applicable to the first year on record; the caller keeps the existing first-live-year and cut-over exceptions.
 * Runs on the close transaction: this year is already FOR UPDATE (so no opening journal can be posted into it concurrently) and the
 * preceding year is read FOR SHARE.
 */
export async function carryforwardPrerequisite(client: PoolClient, companyId: string, year: CloseYear): Promise<CloseFinding | null> {
  const prev = (await client.query<{ id: string; name: string; end_date: string; status: string }>(
    `SELECT id,name,end_date::text,status FROM fiscal_years WHERE company_id=$1 AND end_date<$2::date ORDER BY end_date DESC LIMIT 1 FOR SHARE`,
    [companyId, year.start_date])).rows[0];
  if (!prev) return null;
  const finding = (code: string, detail: string, count = 1): CloseFinding => ({ code, count, detail });
  if (prev.end_date !== dayBefore(year.start_date)) return finding('previous_fiscal_year_not_contiguous', prev.name);
  if (prev.status !== 'closed') return finding('previous_fiscal_year_not_closed', prev.name);

  const record = (await client.query<{ opening_balance_review_id: string; retained_earnings_account_id: string }>(
    'SELECT opening_balance_review_id,retained_earnings_account_id FROM fiscal_year_carryforwards WHERE company_id=$1 AND from_fiscal_year_id=$2 AND to_fiscal_year_id=$3',
    [companyId, prev.id, year.id])).rows[0];
  const opening = (await client.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE company_id=$1 AND fiscal_year_id=$2 AND entry_type='opening_balance' AND status='posted'", [companyId, year.id])).rows;
  const expected = await expectedCarryforward(client, companyId, prev.id, record?.retained_earnings_account_id ?? null);
  if (expected.unbalanced) return finding('carryforward_reconciliation_mismatch', `${prev.name}: trial balance unbalanced`);
  if (!record) {
    // Nothing to carry (no balance-sheet balance, zero result): valid only while this year has no opening balance either.
    if (expected.empty && opening.length === 0) return null;
    return finding('carryforward_missing', prev.name);
  }
  const review = (await client.query<{ status: string; journal_entry_id: string | null }>(
    'SELECT status,journal_entry_id FROM opening_balance_reviews WHERE id=$1 AND company_id=$2', [record.opening_balance_review_id, companyId])).rows[0];
  const journalId = review?.status === 'approved' ? review.journal_entry_id : null;
  if (!journalId || opening.length !== 1 || opening[0]!.id !== journalId) return finding('carryforward_opening_not_posted', prev.name);
  const posted = await accountNets(client,
    `SELECT l.account_id,a.code,SUM(l.debit-l.credit)::text net
     FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
     WHERE l.company_id=$1 AND l.journal_entry_id=$2 GROUP BY l.account_id,a.code`, [companyId, journalId]);
  const mismatches = carryforwardMismatches(expected.nets, posted);
  return mismatches.length ? finding('carryforward_reconciliation_mismatch', mismatches.map((m) => m.code).join(','), mismatches.length) : null;
}

/**
 * Single readiness decision for closing a fiscal year. Runs on the caller's
 * transaction client (after the locks above) so the result cannot go stale
 * before the status UPDATE. Every dated blocker is bounded to the fiscal year.
 */
export async function getFiscalYearCloseReadiness(
  client: PoolClient, companyId: string, year: CloseYear, capture?: { reconciliation?: CompanyReconciliation },
): Promise<FiscalYearCloseReadiness> {
  const captureReconciliation: { value?: CompanyReconciliation } = {};
  const annual = await new AnnualClosingService(client).readiness(companyId, year.id, { fiscalYearBounded: true, captureReconciliation });
  if (capture) capture.reconciliation = captureReconciliation.value;
  const d = annual.domains;
  const apply = await loadApplicability(client, companyId, year);
  // C1B-3b: an active cut-over range replaces the opening-balance path for this year (first_live_accounting_date keeps its meaning).
  const cutoverDate = d.monthly_close!.summary.cutover_date;
  const cutover = typeof cutoverDate === 'string' ? { to_date: cutoverDate } : null;

  const openingRows = num(d.opening_balances!.summary.unresolved_reviews);
  const blockerSpec: Array<[string, number]> = [
    ['monthly_period_missing', num(d.monthly_close!.summary.missing_periods)],
    ['monthly_period_open', num(d.monthly_close!.summary.open_periods)],
    ['draft_journals', num(d.ledger!.summary.draft_journals)],
    ['unposted_operational_sources', num(d.ledger!.summary.unposted_operational_sources)],
    ['trial_balance_unbalanced', d.ledger!.summary.trial_balance_unbalanced ? 1 : 0],
    ['unresolved_documents', num(d.documents!.summary.unresolved_documents)],
    ['unconfirmed_obligations', num(d.receivables_payables!.summary.unconfirmed_obligations)],
    ['unreconciled_bank_transactions', num(d.banking!.summary.unresolved_transactions)],
    ['bank_reconciliation_unresolved', num(d.banking!.summary.reconciliation_blockers)],
    ['pending_periodic_adjustments', num(d.adjustments!.summary.unresolved_adjustments)],
    ['pending_depreciation', num(d.assets!.summary.pending_depreciation)],
    ['draft_fixed_assets', num(d.assets!.summary.draft_assets)],
    ['vat_incomplete', apply.vatApplicable ? num(d.vat!.summary.incomplete_periods) : 0],
    ['opening_balances_incomplete', apply.openingApplicable && !apply.openingApproved && !cutover ? Math.max(1, openingRows) : 0],
    ['partner_ownership_overlap', num(d.partners!.summary.overlapping_ownership_periods)],
    ['partner_transactions_draft', num(d.partners!.summary.draft_partner_transactions)],
  ];
  const blockers: CloseFinding[] = blockerSpec.filter(([, count]) => count > 0).map(([code, count]) => ({ code, count }));
  // B2: existing exceptions only. A year that contains the authoritative first live accounting date follows the opening-balance rule
  // above (any approved opening balance); a year on the cut-over path is opened by its cut-over journal.
  const firstLiveYear = apply.hasProfile && apply.openingApplicable;
  if (!firstLiveYear && !cutover) {
    const carry = await carryforwardPrerequisite(client, companyId, year);
    if (carry) blockers.push(carry);
  }

  const warnings: CloseFinding[] = [];
  const warn = (code: string, count: number, detail?: string) => warnings.push(detail === undefined ? { code, count } : { code, count, detail });
  const openReceivables = Number(d.receivables_payables!.summary.open_receivable_balance ?? 0);
  const openPayables = Number(d.receivables_payables!.summary.open_payable_balance ?? 0);
  if (openReceivables > 0) warn('open_receivable_balance', 1, String(d.receivables_payables!.summary.open_receivable_balance));
  if (openPayables > 0) warn('open_payable_balance', 1, String(d.receivables_payables!.summary.open_payable_balance));
  if (!['ready', 'not_applicable'].includes(d.zakat!.status)) warn('zakat_tax_workpaper_not_ready', 1, d.zakat!.status);
  if (!['ready', 'not_applicable'].includes(d.wht!.status)) warn('wht_review_not_ready', 1, d.wht!.status);
  if (num(d.banking!.summary.reconciliation_warnings) > 0) warn('bank_reconciliation_attention', num(d.banking!.summary.reconciliation_warnings));
  const unconfirmedPartners = num(d.partners!.summary.unconfirmed_ownership_periods) + num(d.partners!.summary.ownership_gaps_needing_review);
  if (unconfirmedPartners > 0) warn('partner_ownership_unconfirmed', unconfirmedPartners);
  if (apply.vatApplicable && num(d.vat!.summary.boundary_review_periods) > 0) warn('vat_boundary_review', num(d.vat!.summary.boundary_review_periods));
  if (apply.vatRequiresResolution) warn('vat_profile_needs_review', 1);
  if (cutover) {
    warn('cutover_account_level_only', 1, cutover.to_date);
    const external: Array<[string, unknown]> = [
      ['external_unposted_operational_sources', d.ledger!.summary.external_unposted_sources],
      ['external_unresolved_documents', d.documents!.summary.external_unresolved_documents],
      ['external_unconfirmed_obligations', d.receivables_payables!.summary.external_unconfirmed_obligations],
      ['external_unreconciled_bank_transactions', d.banking!.summary.external_unresolved_transactions],
      ['external_pending_periodic_adjustments', d.adjustments!.summary.external_unresolved_adjustments],
      ['external_pending_depreciation', d.assets!.summary.external_pending_depreciation],
      ['external_draft_fixed_assets', d.assets!.summary.external_draft_assets],
    ];
    for (const [code, count] of external) if (num(count) > 0) warn(code, num(count), cutover.to_date);
    // S1: missing pre-cut-over history and trial-balance evidence are disclosed, never blockers of the ledger close (Owner decision 2026-10-21).
    const history = d.pre_cutover_history?.summary;
    if (history && history.historical_supplements !== 'complete') warn('cutover_historical_supplements_missing', 1, cutover.to_date);
    // S2 (spec v2 G): one warning per supplement kind that is not approved and reconciled. Warnings only: the ledger close is never blocked.
    if (history && history.cash_flow_supplement !== 'complete') warn('cutover_cash_flow_supplement_missing', 1, String(history.cash_flow_supplement ?? 'missing'));
    if (history && history.equity_supplement !== 'complete') warn('cutover_equity_supplement_missing', 1, String(history.equity_supplement ?? 'missing'));
    const evidence = String(history?.evidence_missing ?? '').split(',').filter(Boolean);
    if (evidence.length) warn('cutover_tb_evidence_missing', evidence.length, evidence.join(','));
  }
  const pkg = (await client.query<{ status: string }>(
    'SELECT status FROM annual_closing_packages WHERE company_id=$1 AND fiscal_year_id=$2', [companyId, year.id],
  )).rows[0];
  if (!pkg || pkg.status !== 'approved') warn('annual_closing_package_not_approved', 1, pkg?.status ?? 'missing');

  return { ready: blockers.length === 0, blockers, warnings };
}
