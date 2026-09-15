import { describe, expect, it } from 'vitest';
import { AnnualClosingNotFoundError, AnnualClosingService, assembleAnnualClosing, domain, expectedMonthlyPeriods, taxReadiness } from '../src/modules/annual-closing/annual-closing.service';
import { Pool } from 'pg';

const fiscalYear = { id: 'fy', start_date: '2025-04-15', end_date: '2026-04-14', status: 'open' };
const clearDomains = () => ({
  monthly_close: domain(0, {}), ledger: domain(0, {}), vat: domain(0, {}), banking: domain(0, {}),
  documents: domain(0, {}), receivables_payables: domain(0, {}), partners: domain(0, {}), assets: domain(0, {}),
  adjustments: domain(0, {}), opening_balances: domain(0, {}), zakat: domain(0, { calculation_performed: false }, true),
});

describe('Phase 7A annual readiness computation', () => {
  it.each([['zakat','zakat'],['income_tax','income_tax'],['mixed','mixed']])('preserves the %s profile path',(_label,path)=>{expect(taxReadiness(path,'p',null,0).summary.tax_path).toBe(path);});
  it('fails closed for missing profiles/workpapers and incomplete statements',()=>{expect(taxReadiness('needs_review',null,null,0).status).toBe('needs_review');expect(taxReadiness('zakat','p',null,0).status).toBe('not_started');expect(taxReadiness('zakat','p',{accounting_profile_id:'p',tax_path:'zakat',workflow_status:'approved',professional_review_required:false,unresolved:0},1).status).toBe('blocked');});
  it('only becomes ready for a matching approved workpaper without unresolved review items',()=>{const paper={accounting_profile_id:'p',tax_path:'zakat',workflow_status:'approved',professional_review_required:false,unresolved:0};expect(taxReadiness('zakat','p',paper,0).status).toBe('ready');expect(taxReadiness('zakat','p',{...paper,unresolved:1},0).status).toBe('needs_review');expect(taxReadiness('zakat','p',{...paper,workflow_status:'reviewed'},0).status).toBe('needs_review');});
  it('clips first and last monthly periods for a non-calendar fiscal year', () => {
    const periods = expectedMonthlyPeriods(fiscalYear.start_date, fiscalYear.end_date);
    expect(periods).toHaveLength(13);
    expect(periods[0]).toEqual({ period_start: '2025-04-15', period_end: '2025-04-30' });
    expect(periods.at(-1)).toEqual({ period_start: '2026-04-01', period_end: '2026-04-14' });
  });

  it('treats missing/open periods as blockers and all closed periods as clear', () => {
    expect(domain(1, { missing_periods: 1 }).ready).toBe(false);
    expect(domain(1, { open_periods: 1 }).status).toBe('blocked');
    expect(domain(0, { closed_periods: 12 }).ready).toBe(true);
  });

  it('rejects another company fiscal year before reading any aggregate source', async () => {
    const query = async (_sql: string, values: unknown[]) => { expect(values).toEqual(['other-fy', 'company-a']); return { rows: [] }; };
    const service = new AnnualClosingService({ query } as unknown as Pool);
    await expect(service.readiness('company-a', 'other-fy')).rejects.toBeInstanceOf(AnnualClosingNotFoundError);
  });

  it.each(['ledger', 'vat', 'banking', 'documents', 'receivables_payables', 'assets', 'adjustments', 'opening_balances'])(
    'makes a %s hard blocker fail overall readiness', key => {
      const domains = clearDomains(); domains[key] = domain(1, {});
      const result = assembleAnnualClosing(fiscalYear, domains);
      expect(result.ready).toBe(false); expect(result.blocker_count).toBe(1);
      if (['monthly_close', 'ledger', 'documents', 'assets', 'adjustments', 'opening_balances'].includes(key)) {
        expect(result.package_manifest.find(item => item.section === 'financial_statements_readiness')?.status).toBe('blocked');
      }
    },
  );

  it('does not turn informational partner, VAT, or zakat review into a hard blocker', () => {
    const domains = clearDomains(); domains.partners = domain(0, {}, true); domains.vat = domain(0, {}, true);
    const result = assembleAnnualClosing(fiscalYear, domains);
    expect(result.ready).toBe(true); expect(result.zakat_readiness.status).toBe('needs_review');
    expect(domains.zakat.summary.calculation_performed).toBe(false);
  });

  it('returns only readiness metadata for all required manifest sections', () => {
    const result = assembleAnnualClosing(fiscalYear, clearDomains());
    expect(result.package_manifest.map(item => item.section)).toEqual([
      'fiscal_year', 'trial_balance', 'general_ledger', 'financial_statements_readiness', 'vat', 'bank_reconciliation',
      'receivables_payables', 'document_exceptions', 'partners_ownership', 'fixed_assets_depreciation',
      'periodic_adjustments', 'opening_balances', 'zakat_readiness',
    ]);
    expect(result.package_manifest.every(item => Object.keys(item).every(key => ['section', 'status', 'blocker_count', 'source'].includes(key)))).toBe(true);
  });
});
