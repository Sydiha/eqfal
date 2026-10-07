import { PoolClient } from 'pg';
import { AnnualClosingService } from '../annual-closing/annual-closing.service';
import { lockAccountingRange } from '../monthly-close/accounting-period.guard';
import { lockVatPeriodScope } from '../vat/vat.router';

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
  return { ...evaluateProfileApplicability(profiles, start, end), openingApproved: approved };
}

/**
 * Single readiness decision for closing a fiscal year. Runs on the caller's
 * transaction client (after the locks above) so the result cannot go stale
 * before the status UPDATE. Every dated blocker is bounded to the fiscal year.
 */
export async function getFiscalYearCloseReadiness(client: PoolClient, companyId: string, year: CloseYear): Promise<FiscalYearCloseReadiness> {
  const annual = await new AnnualClosingService(client).readiness(companyId, year.id, { fiscalYearBounded: true });
  const d = annual.domains;
  const apply = await loadApplicability(client, companyId, year);

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
    ['pending_periodic_adjustments', num(d.adjustments!.summary.unresolved_adjustments)],
    ['pending_depreciation', num(d.assets!.summary.pending_depreciation)],
    ['draft_fixed_assets', num(d.assets!.summary.draft_assets)],
    ['vat_incomplete', apply.vatApplicable ? num(d.vat!.summary.incomplete_periods) : 0],
    ['opening_balances_incomplete', apply.openingApplicable && !apply.openingApproved ? Math.max(1, openingRows) : 0],
    ['partner_ownership_overlap', num(d.partners!.summary.overlapping_ownership_periods)],
  ];
  const blockers = blockerSpec.filter(([, count]) => count > 0).map(([code, count]) => ({ code, count }));

  const warnings: CloseFinding[] = [];
  const warn = (code: string, count: number, detail?: string) => warnings.push(detail === undefined ? { code, count } : { code, count, detail });
  const openReceivables = Number(d.receivables_payables!.summary.open_receivable_balance ?? 0);
  const openPayables = Number(d.receivables_payables!.summary.open_payable_balance ?? 0);
  if (openReceivables > 0) warn('open_receivable_balance', 1, String(d.receivables_payables!.summary.open_receivable_balance));
  if (openPayables > 0) warn('open_payable_balance', 1, String(d.receivables_payables!.summary.open_payable_balance));
  if (!['ready', 'not_applicable'].includes(d.zakat!.status)) warn('zakat_tax_workpaper_not_ready', 1, d.zakat!.status);
  if (!['ready', 'not_applicable'].includes(d.wht!.status)) warn('wht_review_not_ready', 1, d.wht!.status);
  const unconfirmedPartners = num(d.partners!.summary.unconfirmed_ownership_periods) + num(d.partners!.summary.ownership_gaps_needing_review);
  if (unconfirmedPartners > 0) warn('partner_ownership_unconfirmed', unconfirmedPartners);
  if (apply.vatApplicable && num(d.vat!.summary.boundary_review_periods) > 0) warn('vat_boundary_review', num(d.vat!.summary.boundary_review_periods));
  if (apply.vatRequiresResolution) warn('vat_profile_needs_review', 1);
  const pkg = (await client.query<{ status: string }>(
    'SELECT status FROM annual_closing_packages WHERE company_id=$1 AND fiscal_year_id=$2', [companyId, year.id],
  )).rows[0];
  if (!pkg || pkg.status !== 'approved') warn('annual_closing_package_not_approved', 1, pkg?.status ?? 'missing');

  return { ready: blockers.length === 0, blockers, warnings };
}
