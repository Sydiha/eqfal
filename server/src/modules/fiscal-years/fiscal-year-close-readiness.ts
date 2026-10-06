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

/** Same applicability rules as Monthly Close (profile-driven VAT / opening balances). */
async function loadApplicability(client: PoolClient, companyId: string, year: CloseYear) {
  const { start_date: start, end_date: end, id } = year;
  const row = (await client.query<{ vat_applicable: string; vat_requires_resolution: string; opening_applicable: string; opening_approved: string }>(
    `SELECT
      COALESCE((SELECT CASE
        WHEN p.vat_status='not_registered' THEN FALSE
        WHEN p.vat_status='registered' THEN p.vat_registered_from IS NULL OR $3::date>=p.vat_registered_from
        WHEN p.vat_status='deregistered' THEN p.vat_deregistered_from IS NULL OR $2::date<p.vat_deregistered_from
        ELSE TRUE END
        FROM company_accounting_profiles p WHERE p.company_id=$1 AND p.workflow_status='approved' AND p.effective_from<=$2::date AND (p.effective_to IS NULL OR p.effective_to>=$3::date)
        ORDER BY p.effective_from DESC,p.version_no DESC LIMIT 1),TRUE)::text vat_applicable,
      COALESCE((SELECT p.vat_status='needs_review'
        FROM company_accounting_profiles p WHERE p.company_id=$1 AND p.workflow_status='approved' AND p.effective_from<=$2::date AND (p.effective_to IS NULL OR p.effective_to>=$3::date)
        ORDER BY p.effective_from DESC,p.version_no DESC LIMIT 1),TRUE)::text vat_requires_resolution,
      COALESCE((SELECT p.first_live_accounting_date BETWEEN fy.start_date AND fy.end_date
        FROM company_accounting_profiles p JOIN fiscal_years fy ON fy.id=$4 AND fy.company_id=p.company_id
        WHERE p.company_id=$1 AND p.workflow_status='approved' AND p.effective_from<=$2::date AND (p.effective_to IS NULL OR p.effective_to>=$3::date)
        ORDER BY p.effective_from DESC,p.version_no DESC LIMIT 1),TRUE)::text opening_applicable,
      EXISTS(SELECT 1 FROM opening_balance_reviews WHERE company_id=$1 AND fiscal_year_id=$4 AND status='approved')::text opening_approved`,
    [companyId, start, end, id],
  )).rows[0]!;
  return {
    vatApplicable: row.vat_applicable === 'true',
    vatRequiresResolution: row.vat_requires_resolution === 'true',
    openingApplicable: row.opening_applicable === 'true',
    openingApproved: row.opening_approved === 'true',
  };
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
    ['vat_incomplete', apply.vatApplicable && !apply.vatRequiresResolution ? num(d.vat!.summary.incomplete_periods) : 0],
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
  if (apply.vatApplicable && apply.vatRequiresResolution) warn('vat_profile_needs_review', 1);
  const pkg = (await client.query<{ status: string }>(
    'SELECT status FROM annual_closing_packages WHERE company_id=$1 AND fiscal_year_id=$2', [companyId, year.id],
  )).rows[0];
  if (!pkg || pkg.status !== 'approved') warn('annual_closing_package_not_approved', 1, pkg?.status ?? 'missing');

  return { ready: blockers.length === 0, blockers, warnings };
}
