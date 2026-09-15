import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TaxWorkpaper } from './TaxWorkpaper';

type FiscalYear = { id: string; name: string; start_date: string; end_date: string };
type Domain = { ready: boolean; blocker_count: number; status: string; summary: Record<string, string | number | boolean> };
type Result = {
  fiscal_year: FiscalYear; ready: boolean; blocker_count: number; domains: Record<string, Domain>;
  financial_statements_readiness: { status: string; label: string; label_ar: string };
  zakat_readiness: { status: string };
  package_manifest: Array<{ section: string; status: string; blocker_count?: number }>;
};

export function AnnualClosing({ canView, canViewWorkpaper=false, canManage=false, canReview=false, canApprove=false, onUnauthorized }: { canView: boolean; canViewWorkpaper?: boolean; canManage?: boolean; canReview?: boolean; canApprove?: boolean; onUnauthorized: () => void }) {
  const { t, i18n } = useTranslation();
  const [years, setYears] = useState<FiscalYear[]>([]);
  const [yearId, setYearId] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!canView) return;
    void fetch('/api/fiscal-years').then(async response => {
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error();
      const data = await response.json() as { fiscalYears: FiscalYear[] };
      setYears(data.fiscalYears); setYearId(current => current || data.fiscalYears[0]?.id || '');
    }).catch(() => setError(true));
  }, [canView, onUnauthorized]);
  useEffect(() => {
    if (!canView || !yearId) { setResult(null); return; }
    setLoading(true); setError(false);
    void fetch(`/api/annual-closing/${encodeURIComponent(yearId)}`).then(async response => {
      if (response.status === 401) { onUnauthorized(); return null; }
      if (!response.ok) throw new Error();
      return response.json() as Promise<Result>;
    }).then(data => { if (data) setResult(data); }).catch(() => setError(true)).finally(() => setLoading(false));
  }, [canView, onUnauthorized, yearId, refresh]);
  if (!canView) return <section className="panel"><p>{t('annualClosing.noAccess')}</p></section>;
  const status = (value: string) => t(`annualClosing.status.${value}`);
  return <section className="panel" aria-labelledby="annual-closing-title">
    <div className="section-heading"><div><h1 id="annual-closing-title">{t('annualClosing.title')}</h1><p>{t('annualClosing.description')}</p></div></div>
    <label>{t('annualClosing.fiscalYear')}<select value={yearId} onChange={event => setYearId(event.target.value)}><option value="">{t('annualClosing.selectYear')}</option>{years.map(year => <option key={year.id} value={year.id}>{year.name} ({year.start_date} – {year.end_date})</option>)}</select></label>
    {loading && <p role="status">{t('annualClosing.loading')}</p>}{error && <p role="alert">{t('annualClosing.error')}</p>}
    {result && <>
      <div className="summary-grid"><article className="summary-card"><strong>{result.ready ? t('annualClosing.ready') : t('annualClosing.notReady')}</strong><span>{t('annualClosing.blockers', { count: result.blocker_count })}</span></article><article className="summary-card"><strong>{i18n.language === 'ar' ? result.financial_statements_readiness.label_ar : result.financial_statements_readiness.label}</strong><span>{status(result.financial_statements_readiness.status)}</span></article><article className="summary-card"><strong>{t('annualClosing.zakat')}</strong><span>{status(result.zakat_readiness.status)}</span></article></div>
      <h2>{t('annualClosing.domains')}</h2><div className="table-wrap"><table><thead><tr><th>{t('annualClosing.domain')}</th><th>{t('annualClosing.state')}</th><th>{t('annualClosing.blockerCount')}</th></tr></thead><tbody>{Object.entries(result.domains).map(([key, value]) => <tr key={key}><td>{t(`annualClosing.domainNames.${key}`)}</td><td>{status(value.status)}</td><td>{value.blocker_count}</td></tr>)}</tbody></table></div>
      <h2>{t('annualClosing.manifest')}</h2><div className="table-wrap"><table><thead><tr><th>{t('annualClosing.section')}</th><th>{t('annualClosing.state')}</th><th>{t('annualClosing.blockerCount')}</th></tr></thead><tbody>{result.package_manifest.map(item => <tr key={item.section}><td>{t(`annualClosing.manifestNames.${item.section}`)}</td><td>{status(item.status)}</td><td>{item.blocker_count ?? '—'}</td></tr>)}</tbody></table></div>
      <TaxWorkpaper yearId={yearId} canView={canViewWorkpaper} canManage={canManage} canReview={canReview} canApprove={canApprove} onUnauthorized={onUnauthorized} onChanged={() => setRefresh(value => value + 1)}/>
    </>}
  </section>;
}
