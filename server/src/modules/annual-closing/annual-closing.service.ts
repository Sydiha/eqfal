import { Pool, PoolClient } from 'pg';
import { loadOperationalSources } from '../accounting/operational-sources';
import { CUTOVER_BOUNDS_SQL } from '../accounting/external-period-guard';
import { loadCutoverDisclosure } from '../accounting/cutover-disclosure';
import { AnnualClosingDomain, AnnualClosingResponse, ReadinessState } from './annual-closing.types';
import { expectedMonthlyPeriods } from '../../shared/expected-monthly-periods';
import { CompanyReconciliation, UNRESOLVED_BANK_TRANSACTION_SQL, evaluateCompanyBankReconciliation } from '../banking/bank-reconciliation-core';
import { TaxWorkpaperService } from '../tax-working-papers/tax-working-paper.service';

type FiscalYear = { id: string; start_date: string; end_date: string; status: string };
type CountRow = Record<string, string>;

export class AnnualClosingNotFoundError extends Error {}

// Canonical implementation lives in the shared module; re-exported for existing importers.
export { expectedMonthlyPeriods };

export function domain(blockerCount: number, summary: AnnualClosingDomain['summary'], review = false): AnnualClosingDomain {
  const status: ReadinessState = blockerCount ? 'blocked' : review ? 'needs_review' : 'ready';
  return { ready: blockerCount === 0, blocker_count: blockerCount, status, summary };
}

export function taxReadiness(taxPath:string, profileId:string|null, workpaper:{accounting_profile_id:string|null;tax_path:string;workflow_status:string;professional_review_required:boolean;unresolved:number;source_drift:boolean}|null, financialBlockers:number):AnnualClosingDomain {
  const blockers:string[]=[];let status:ReadinessState='needs_review';
  if(taxPath==='needs_review'||!profileId)blockers.push('approved_profile_required');
  else if(!workpaper){status='not_started';blockers.push('workpaper_not_started');}
  else if(workpaper.tax_path!==taxPath||workpaper.accounting_profile_id!==profileId)blockers.push('profile_mismatch');
  else if(financialBlockers){status='blocked';blockers.push('financial_statements_not_ready');}
  else if(workpaper.source_drift){status='blocked';blockers.push('tax_workpaper_source_drift');}
  else if(workpaper.workflow_status!=='approved')blockers.push('workpaper_not_approved');
  else if(workpaper.professional_review_required||workpaper.unresolved){blockers.push('professional_review_unresolved');}
  else status='ready';
  return {ready:status==='ready',blocker_count:status==='blocked'?1:0,status,summary:{calculation_performed:false,workpaper_data_available:Boolean(workpaper),tax_path:taxPath,workpaper_status:workpaper?.workflow_status??'not_started',unresolved_professional_items:workpaper?.unresolved??0,blockers:blockers.join(',')}};
}

type WhtProfile={effective_from:string;effective_to:string|null;wht_profile:string;has_non_resident_dealings:string};
export function whtReadiness(start:string,end:string,profiles:WhtProfile[],reviews:{workflow_status:string;professional_review_required:boolean}[]):AnnualClosingDomain{
  const risky=profiles.some(p=>['potentially_applicable','needs_review'].includes(p.wht_profile)||['yes','unknown'].includes(p.has_non_resident_dealings));
  const safe=profiles.filter(p=>p.wht_profile==='not_currently_applicable'&&p.has_non_resident_dealings==='no').sort((a,b)=>a.effective_from.localeCompare(b.effective_from));
  let coveredThrough=start;
  for(const profile of safe){if(profile.effective_from>coveredThrough)break;const after=new Date(`${profile.effective_to??end}T00:00:00Z`);after.setUTCDate(after.getUTCDate()+1);const next=after.toISOString().slice(0,10);if(next>coveredThrough)coveredThrough=next;}
  const endAfter=new Date(`${end}T00:00:00Z`);endAfter.setUTCDate(endAfter.getUTCDate()+1);
  const fullySafe=!risky&&coveredThrough>=endAfter.toISOString().slice(0,10);
  const unresolved=reviews.filter(r=>r.workflow_status!=='reviewed'||r.professional_review_required).length;
  const blockers:string[]=[];let status:ReadinessState;
  if(fullySafe&&!reviews.length)status='not_applicable';
  else if(!profiles.length){status='needs_review';blockers.push('approved_profile_required');}
  else if(unresolved){status='needs_review';blockers.push('wht_review_unresolved');}
  else if((risky||!fullySafe)&&!reviews.length){status='not_started';blockers.push('wht_review_not_started');}
  else status='ready';
  return {ready:status==='ready'||status==='not_applicable',blocker_count:blockers.length?1:0,status,summary:{calculation_performed:false,profile_versions_evaluated:profiles.length,review_count:reviews.length,unresolved_reviews:unresolved,blockers:blockers.join(',')}};
}

export function assembleAnnualClosing(fiscalYear: FiscalYear, domains: Record<string, AnnualClosingDomain>): AnnualClosingResponse {
  const blockerCount = Object.values(domains).reduce((total, item) => total + item.blocker_count, 0);
  // `pre_cutover_history` exists only for a year with an active cut-over range (S1): it blocks the financial statements package, never the ledger close.
  const financialBlockers = ['monthly_close', 'ledger', 'documents', 'assets', 'adjustments', 'opening_balances', 'pre_cutover_history']
    .reduce((total, key) => total + (domains[key]?.blocker_count ?? 0), 0);
  const manifestSource: Record<string, string> = {
    fiscal_year: 'fiscal-years', trial_balance: 'accounting', general_ledger: 'accounting', financial_statements_readiness: 'annual-closing',
    vat: 'vat', bank_reconciliation: 'banking', receivables_payables: 'obligations', document_exceptions: 'documents',
    partners_ownership: 'partners', fixed_assets_depreciation: 'fixed-assets', periodic_adjustments: 'periodic-adjustments',
    opening_balances: 'opening-balances', zakat_readiness: 'annual-closing', wht_readiness:'wht-reviews', pre_cutover_history: 'ledger-source-authority',
  };
  const manifestDomain: Record<string, string | undefined> = {
    trial_balance: 'ledger', general_ledger: 'ledger', financial_statements_readiness: 'ledger', vat: 'vat',
    bank_reconciliation: 'banking', receivables_payables: 'receivables_payables', document_exceptions: 'documents',
    partners_ownership: 'partners', fixed_assets_depreciation: 'assets', periodic_adjustments: 'adjustments',
    opening_balances: 'opening_balances', zakat_readiness: 'zakat', wht_readiness:'wht', pre_cutover_history: 'pre_cutover_history',
  };
  const package_manifest = Object.keys(manifestSource).filter(section=>(section!=='wht_readiness'||Boolean(domains.wht))&&(section!=='pre_cutover_history'||Boolean(domains.pre_cutover_history))).map(section => {
    const item = manifestDomain[section] ? domains[manifestDomain[section]!] : undefined;
    const status = section === 'fiscal_year' ? 'ready' as const : section === 'financial_statements_readiness' ? (financialBlockers ? 'blocked' as const : 'ready' as const) : item!.status;
    return { section, status, ...(item ? { blocker_count: section === 'financial_statements_readiness' ? financialBlockers : item.blocker_count } : {}), source: manifestSource[section]! };
  });
  // S2 (spec v2 G): one manifest section per supplement kind, carrying the approved version number (a new approval changes the manifest).
  const history = domains.pre_cutover_history?.summary;
  if (history) for (const kind of ['cash_flow', 'equity'] as const) {
    const complete = history[`${kind}_supplement`] === 'complete';
    package_manifest.push({ section: `pre_cutover_${kind}`, status: complete ? 'ready' : 'blocked', blocker_count: complete ? 0 : 1, source: 'ledger-source-authority', version_no: Number(history[`${kind}_supplement_version`]) || null } as typeof package_manifest[number]);
  }
  return {
    fiscal_year: fiscalYear, ready: blockerCount === 0, blocker_count: blockerCount, domains,
    financial_statements_readiness: { status: financialBlockers ? 'needs_review' : 'ready', label: 'Ready for financial statement preparation', label_ar: 'جاهز لإعداد القوائم المالية' },
    zakat_readiness: { status: domains.zakat!.status === 'not_applicable' ? 'needs_review' : domains.zakat!.status as 'not_started'|'needs_review'|'blocked'|'ready', tax_path: String(domains.zakat!.summary.tax_path), blockers: String(domains.zakat!.summary.blockers ?? '').split(',').filter(Boolean) }, package_manifest,
  };
}

export class AnnualClosingService {
  constructor(private db: Pool | PoolClient) {}

  /**
   * `fiscalYearBounded` is used by the fiscal-year close gate: dated blockers
   * are evaluated strictly inside [start_date, end_date] and the live tax
   * workpaper drift lookup (which needs a Pool, not a transaction client) is
   * skipped. Default behaviour is unchanged.
   */
  async readiness(companyId: string, fiscalYearId: string, options: { fiscalYearBounded?: boolean; captureReconciliation?: { value?: CompanyReconciliation } } = {}): Promise<AnnualClosingResponse> {
    const bounded = options.fiscalYearBounded === true;
    const nextDay = (date: string) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
    const partnerOverlapLowerBound = bounded
      ? " AND COALESCE(a.effective_to,'infinity'::date)>=$2 AND COALESCE(b.effective_to,'infinity'::date)>=$2"
      : '';
    const fiscalYear = (await this.db.query<FiscalYear & { cutover_to?: string | null }>(
      `SELECT id,start_date::text,end_date::text,status,${CUTOVER_BOUNDS_SQL} FROM fiscal_years WHERE id=$1 AND company_id=$2`, [fiscalYearId, companyId],
    )).rows[0];
    if (!fiscalYear) throw new AnnualClosingNotFoundError();
    const { start_date: start, end_date: end } = fiscalYear;
    // C1B-3b: with an active cut-over range [start, D] the months up to D are maintained outside EQFAL. They are not native close requirements and
    // their dated operational items cannot be posted, so they are reported as external (warnings) while integrity checks stay blockers.
    const cut = fiscalYear.cutover_to ? { to_date: fiscalYear.cutover_to } : null;
    const nativeStart = cut ? nextDay(cut.to_date) : start;
    const obligationDate = bounded || cut ? 'o.recognized_on BETWEEN $2 AND $3' : 'o.recognized_on<=$3';

    const allPeriods = expectedMonthlyPeriods(start, end);
    const periods = cut ? allPeriods.filter(item => item.period_start >= nativeStart) : allPeriods;
    const monthlyRows = (await this.db.query<{ period_start: string; period_end: string; status: string }>(
      'SELECT period_start::text,period_end::text,status FROM monthly_close_periods WHERE company_id=$1 AND fiscal_year_id=$2', [companyId, fiscalYearId],
    )).rows;
    const monthlyByBounds = new Map(monthlyRows.map(item => [`${item.period_start}:${item.period_end}`, item.status]));
    const missingPeriods = periods.filter(item => !monthlyByBounds.has(`${item.period_start}:${item.period_end}`)).length;
    const openPeriods = periods.filter(item => { const state = monthlyByBounds.get(`${item.period_start}:${item.period_end}`); return state !== undefined && state !== 'closed'; }).length;

    const allSources = (await loadOperationalSources(companyId, this.db)).filter(source => source.accounting_date >= start && source.accounting_date <= end);
    const externalSources = cut ? allSources.filter(source => source.accounting_date <= cut.to_date) : [];
    const sources = cut ? allSources.filter(source => source.accounting_date > cut.to_date) : allSources;
    const postedSources = (await this.db.query<{ source_type: string; source_id: string }>(
      "SELECT source_type,source_id::text FROM journal_entries WHERE company_id=$1 AND fiscal_year_id=$2 AND status='posted' AND source_type IS NOT NULL", [companyId, fiscalYearId],
    )).rows;
    const postedKeys = new Set(postedSources.map(item => `${item.source_type}:${item.source_id}`));
    const unpostedSources = sources.filter(source => !postedKeys.has(`${source.source_type}:${source.source_id}`)).length;
    const externalUnposted = externalSources.filter(source => !postedKeys.has(`${source.source_type}:${source.source_id}`)).length;
    const ledger = (await this.db.query<CountRow>(`SELECT
      COUNT(*) FILTER (WHERE j.status='draft')::text draft_journals,
      COALESCE(SUM(l.debit) FILTER (WHERE j.status='posted'),0)::text total_debits,
      COALESCE(SUM(l.credit) FILTER (WHERE j.status='posted'),0)::text total_credits
      FROM journal_entries j LEFT JOIN journal_lines l ON l.journal_entry_id=j.id AND l.company_id=j.company_id
      WHERE j.company_id=$1 AND j.fiscal_year_id=$2 AND j.accounting_date BETWEEN $3 AND $4`, [companyId, fiscalYearId, start, end])).rows[0]!;
    const unbalanced = ledger.total_debits === ledger.total_credits ? 0 : 1;

    const vat = (await this.db.query<CountRow>(`SELECT
      COUNT(*) FILTER (WHERE p.period_start >= $2 AND p.period_end <= $3 AND (p.status <> 'closed' OR r.status IS NULL OR r.status <> 'filed'))::text incomplete,
      COUNT(*) FILTER (WHERE p.period_start <= $3 AND p.period_end >= $2 AND NOT (p.period_start >= $2 AND p.period_end <= $3))::text boundary
      FROM vat_periods p LEFT JOIN vat_returns r ON r.vat_period_id=p.id AND r.company_id=p.company_id WHERE p.company_id=$1`, [companyId, start, end])).rows[0]!;
    const generalSql = `SELECT
      (SELECT COUNT(*) FROM bank_transactions t WHERE t.company_id=$1 AND t.transaction_date BETWEEN $2 AND $3 AND ${UNRESOLVED_BANK_TRANSACTION_SQL})::text banking,
      (SELECT COUNT(*) FROM documents d WHERE d.company_id=$1 AND d.document_date BETWEEN $2 AND $3 AND (
        d.status IN ('uploaded','needs_review','incomplete') OR (d.status='approved' AND d.document_type IN ('sale','purchase','expense') AND NOT (
          EXISTS (SELECT 1 FROM obligations o JOIN journal_entries j ON j.company_id=o.company_id AND j.source_type='obligation' AND j.source_id=o.id AND j.status='posted' WHERE o.company_id=d.company_id AND o.document_id=d.id AND NOT o.is_cancelled AND o.verification_status='confirmed')
          OR EXISTS (SELECT 1 FROM custody_document_allocations a JOIN journal_entries j ON j.company_id=a.company_id AND j.source_type='custody_allocation' AND j.source_id=a.id AND j.status='posted' WHERE a.company_id=d.company_id AND a.document_id=d.id)
          OR EXISTS (SELECT 1 FROM personal_payments pp JOIN journal_entries j ON j.company_id=pp.company_id AND j.source_type='personal_payment' AND j.source_id=pp.id AND j.status='posted' WHERE pp.company_id=d.company_id AND pp.document_id=d.id AND pp.status='approved')
        ))))::text documents,
      ((SELECT COUNT(*) FROM obligations o WHERE o.company_id=$1 AND ${obligationDate} AND NOT o.is_cancelled AND o.verification_status='unconfirmed')
        + (SELECT COUNT(*) FROM personal_payments pp WHERE pp.company_id=$1 AND pp.status IN ('draft','submitted') AND pp.accounting_date BETWEEN $2 AND $3))::text obligations,
      (SELECT COALESCE(SUM(GREATEST(o.original_amount+obligation_adjustment_net(o.id,o.company_id,$3)-COALESCE(s.settled,0),0)),0) FROM obligations o LEFT JOIN (SELECT obligation_id,company_id,SUM(amount) settled FROM obligation_settlements WHERE company_id=$1 AND created_at::date<=$3 GROUP BY obligation_id,company_id) s ON s.obligation_id=o.id AND s.company_id=o.company_id WHERE o.company_id=$1 AND o.direction='receivable' AND o.recognized_on<=$3 AND NOT o.is_cancelled)::text open_receivables,
      (SELECT COALESCE(SUM(GREATEST(o.original_amount+obligation_adjustment_net(o.id,o.company_id,$3)-COALESCE(s.settled,0),0)),0) FROM obligations o LEFT JOIN (SELECT obligation_id,company_id,SUM(amount) settled FROM obligation_settlements WHERE company_id=$1 AND created_at::date<=$3 GROUP BY obligation_id,company_id) s ON s.obligation_id=o.id AND s.company_id=o.company_id WHERE o.company_id=$1 AND o.direction='payable' AND o.recognized_on<=$3 AND NOT o.is_cancelled)::text open_payables,
      (SELECT COUNT(*) FROM partner_ownership_periods p WHERE p.company_id=$1 AND p.verification_status='unconfirmed' AND (p.effective_from IS NULL OR p.effective_from<=$3) AND (p.effective_to IS NULL OR p.effective_to>=$2))::text partner_unconfirmed,
      (SELECT COUNT(*) FROM partner_ownership_periods a JOIN partner_ownership_periods b ON b.company_id=a.company_id AND b.partner_id=a.partner_id AND b.id>a.id WHERE a.company_id=$1 AND a.verification_status='confirmed' AND b.verification_status='confirmed' AND COALESCE(a.effective_to,'infinity'::date)>=b.effective_from AND COALESCE(b.effective_to,'infinity'::date)>=a.effective_from AND a.effective_from<=$3 AND b.effective_from<=$3${partnerOverlapLowerBound})::text partner_overlaps,
      (SELECT COUNT(*) FROM partners p WHERE p.company_id=$1 AND p.is_active AND NOT EXISTS (SELECT 1 FROM partner_ownership_periods h WHERE h.company_id=p.company_id AND h.partner_id=p.id AND h.verification_status='confirmed' AND h.effective_from<=$3 AND (h.effective_to IS NULL OR h.effective_to>=$2)))::text partner_missing,
      (SELECT COUNT(*) FROM partner_transactions pt WHERE pt.company_id=$1 AND pt.status='draft' AND pt.transaction_date BETWEEN $2 AND $3)::text partner_draft_transactions,
      (SELECT COUNT(*) FROM asset_depreciation_entries e WHERE e.company_id=$1 AND e.status='pending' AND e.period_start<=$3 AND e.period_end>=$2)::text pending_depreciation,
      (SELECT COUNT(*) FROM fixed_assets a WHERE a.company_id=$1 AND a.status='draft' AND a.acquisition_date BETWEEN $2 AND $3)::text draft_assets,
      (SELECT COUNT(DISTINCT adjustment_id) FROM (
        SELECT a.id adjustment_id FROM periodic_adjustments a WHERE a.company_id=$1 AND a.workflow_status IN ('draft','in_review') AND a.recognition_start<=$3 AND a.recognition_end>=$2
        UNION SELECT s.adjustment_id FROM periodic_adjustment_schedule s JOIN periodic_adjustments a ON a.id=s.adjustment_id AND a.company_id=s.company_id WHERE s.company_id=$1 AND a.workflow_status='approved' AND s.status='pending' AND s.recognition_date BETWEEN $2 AND $3
      ) unresolved_adjustments)::text adjustments,
      (SELECT COUNT(*) FROM opening_balance_reviews o WHERE o.company_id=$1 AND o.fiscal_year_id=$4 AND o.status<>'approved')::text opening_balances`;
    const general = (await this.db.query<CountRow>(generalSql, [companyId, nativeStart, end, fiscalYearId])).rows[0]!;
    // T2: statement-balance reconciliation at the fiscal-year end. The close path (bounded, on a transaction client) locks each bank account first.
    const reconciliation = await evaluateCompanyBankReconciliation(this.db, companyId, start, end, { lock: bounded });
    if (options.captureReconciliation) options.captureReconciliation.value = reconciliation;
    const externalGeneral = cut ? (await this.db.query<CountRow>(generalSql, [companyId, start, cut.to_date, fiscalYearId])).rows[0]! : null;
    if (cut) general.opening_balances = '0'; // the fiscal year follows the cut-over path: no opening-balance review applies

    const profile=(await this.db.query<{id:string;tax_treatment:string}>(`SELECT id,tax_treatment FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$2 AND (effective_to IS NULL OR effective_to>=$3) AND (tax_effective_from IS NULL OR tax_effective_from<=$2) ORDER BY effective_from DESC,version_no DESC LIMIT 1`,[companyId,start,end])).rows[0];
    const whtProfiles=(await this.db.query<WhtProfile>(`SELECT effective_from::text,effective_to::text,wht_profile,has_non_resident_dealings FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$3 AND (effective_to IS NULL OR effective_to>=$2) ORDER BY effective_from,version_no`,[companyId,start,end])).rows;
    const whtReviews=(await this.db.query<{workflow_status:string;professional_review_required:boolean}>(`SELECT workflow_status,professional_review_required FROM wht_reviews WHERE company_id=$1 AND fiscal_year_id=$2`,[companyId,fiscalYearId])).rows;
    const workpaper=(await this.db.query<{accounting_profile_id:string|null;tax_path:string;workflow_status:string;professional_review_required:boolean;unresolved:string}>(`SELECT w.accounting_profile_id,w.tax_path,w.workflow_status,w.professional_review_required,COUNT(a.id) FILTER (WHERE a.professional_review_required)::text unresolved FROM tax_working_papers w LEFT JOIN tax_working_paper_adjustments a ON a.workpaper_id=w.id AND a.company_id=w.company_id WHERE w.company_id=$1 AND w.fiscal_year_id=$2 GROUP BY w.id`,[companyId,fiscalYearId])).rows[0];
    const liveTaxWorkpaper=workpaper&&!bounded?await new TaxWorkpaperService(this.db as Pool).get(companyId,fiscalYearId):null;
    const taxPath=profile?({zakat_applicable:'zakat',income_tax_applicable:'income_tax',mixed:'mixed',needs_review:'needs_review'}[profile.tax_treatment]??'needs_review'):'needs_review';
    const financialBlockers=missingPeriods+openPeriods+Number(ledger.draft_journals)+unpostedSources+unbalanced+Number(general.documents)+Number(general.pending_depreciation)+Number(general.draft_assets)+Number(general.adjustments)+Number(general.opening_balances);

    const domains: Record<string, AnnualClosingDomain> = {
      monthly_close: domain(missingPeriods + openPeriods, { expected_periods: periods.length, missing_periods: missingPeriods, open_periods: openPeriods, closed_periods: periods.length - missingPeriods - openPeriods, ...(cut ? { external_periods: allPeriods.length - periods.length, cutover_date: cut.to_date } : {}) }),
      ledger: domain(Number(ledger.draft_journals) + unpostedSources + unbalanced, { draft_journals: Number(ledger.draft_journals), unposted_operational_sources: unpostedSources, trial_balance_unbalanced: Boolean(unbalanced), ...(cut ? { external_unposted_sources: externalUnposted } : {}) }),
      vat: domain(Number(vat.incomplete), { incomplete_periods: Number(vat.incomplete), boundary_review_periods: Number(vat.boundary) }, Number(vat.boundary) > 0),
      banking: domain(Number(general.banking) + reconciliation.blockers, { unresolved_transactions: Number(general.banking), reconciliation_mode: reconciliation.effective_mode, reconciliation_blockers: reconciliation.blockers, reconciliation_warnings: reconciliation.warnings, ...(externalGeneral ? { external_unresolved_transactions: Number(externalGeneral.banking) } : {}) }),
      documents: domain(Number(general.documents), { unresolved_documents: Number(general.documents), ...(externalGeneral ? { external_unresolved_documents: Number(externalGeneral.documents) } : {}) }),
      receivables_payables: domain(Number(general.obligations), { unconfirmed_obligations: Number(general.obligations), ...(externalGeneral ? { external_unconfirmed_obligations: Number(externalGeneral.obligations) } : {}), open_receivable_balance: general.open_receivables, open_payable_balance: general.open_payables }),
      partners: domain(Number(general.partner_unconfirmed) + Number(general.partner_overlaps) + Number(general.partner_draft_transactions), { unconfirmed_ownership_periods: Number(general.partner_unconfirmed), overlapping_ownership_periods: Number(general.partner_overlaps), ownership_gaps_needing_review: Number(general.partner_missing), draft_partner_transactions: Number(general.partner_draft_transactions) }, Number(general.partner_missing) > 0),
      assets: domain(Number(general.pending_depreciation) + Number(general.draft_assets), { pending_depreciation: Number(general.pending_depreciation), draft_assets: Number(general.draft_assets), ...(externalGeneral ? { external_pending_depreciation: Number(externalGeneral.pending_depreciation), external_draft_assets: Number(externalGeneral.draft_assets) } : {}) }),
      adjustments: domain(Number(general.adjustments), { unresolved_adjustments: Number(general.adjustments), ...(externalGeneral ? { external_unresolved_adjustments: Number(externalGeneral.adjustments) } : {}) }),
      opening_balances: domain(Number(general.opening_balances), { unresolved_reviews: Number(general.opening_balances) }),
      zakat: taxReadiness(taxPath,profile?.id??null,workpaper?{...workpaper,unresolved:Number(workpaper.unresolved),source_drift:Boolean(liveTaxWorkpaper?.source_drift)}:null,financialBlockers),
      wht: whtReadiness(start,end,whtProfiles,whtReviews),
    };
    // S1: EQFAL holds no verified pre-cut-over history (cash flows, equity movements) yet, so a cut-over year's full-year statements package is
    // blocked. The fiscal-year ledger close reads only warnings from this domain (fiscal-year-close-readiness.ts).
    // S2: the package is unblocked only when both supplements are approved and still reconcile (computed now, never stored) and the
    // trial-balance evidence is recorded. Missing, invalid or unapproved history stays a visible blocker.
    if (cut) {
      const disclosure = await loadCutoverDisclosure(this.db, companyId, fiscalYearId);
      const sup = disclosure?.supplements ?? null;
      const state = (kind: 'cash_flow' | 'equity') => sup?.[kind]?.state ?? 'missing';
      const blockers = [
        ...(['cash_flow', 'equity'] as const).filter((kind) => state(kind) !== 'complete').map((kind) => `${kind}_supplement_${state(kind)}`),
        ...((disclosure?.evidence_missing ?? []).length ? ['tb_evidence_missing'] : []),
      ];
      const states = [state('cash_flow'), state('equity')];
      domains.pre_cutover_history = domain(blockers.length, {
        cutover_date: cut.to_date,
        historical_supplements: states.every((x) => x === 'complete') ? 'complete' : states.every((x) => x === 'missing') ? 'missing' : 'incomplete',
        cash_flow_supplement: state('cash_flow'), cash_flow_supplement_version: sup?.cash_flow.version_no ?? '', cash_flow_revision_pending: Boolean(sup?.cash_flow.revision_pending),
        equity_supplement: state('equity'), equity_supplement_version: sup?.equity.version_no ?? '', equity_revision_pending: Boolean(sup?.equity.revision_pending),
        tb_basis: disclosure?.tb_basis ?? 'not_recorded', evidence_missing: (disclosure?.evidence_missing ?? []).join(','), blockers: blockers.join(','),
      });
    }
    return assembleAnnualClosing(fiscalYear, domains);
  }
}
