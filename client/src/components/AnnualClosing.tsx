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
type ManifestSection={section:string;status:string;blocker_count:number;blockers:string[];source:string;summary:Record<string,string|number|boolean>};
type Snapshot={id:string;snapshot_no:number;snapshot_type:'preview'|'final';manifest:ManifestSection[];source_fingerprint:string;created_at:string};
type Package={id:string;status:'draft'|'finalized'|'handed_off';version:number;final_snapshot_id:string|null;finalized_at:string|null;handed_off_at:string|null;handoff_note:string|null;handoff_reference:string|null;snapshots:Snapshot[]};
type PackageResult={package:Package|null;live:{manifest:ManifestSection[];source_fingerprint:string}|null;drift:boolean};

const financialStatementDomainKeys = ['monthly_close', 'ledger', 'documents', 'assets', 'adjustments', 'opening_balances'] as const;

export function AnnualClosing({ canView, canViewPackage=false, canManagePackage=false, canFinalizePackage=false, canHandoffPackage=false, canViewWorkpaper=false, canManage=false, canReview=false, canApprove=false, onUnauthorized }: { canView: boolean; canViewPackage?:boolean;canManagePackage?:boolean;canFinalizePackage?:boolean;canHandoffPackage?:boolean; canViewWorkpaper?: boolean; canManage?: boolean; canReview?: boolean; canApprove?: boolean; onUnauthorized: () => void }) {
  const { t, i18n } = useTranslation();
  const [years, setYears] = useState<FiscalYear[]>([]);
  const [yearId, setYearId] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [packageResult,setPackageResult]=useState<PackageResult|null>(null);
  const [packageError,setPackageError]=useState('');
  const [finalizationBlockers,setFinalizationBlockers]=useState<string[]>([]);
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
  useEffect(()=>{if(!canViewPackage||!yearId){setPackageResult(null);return;}void fetch(`/api/annual-closing/${encodeURIComponent(yearId)}/package`).then(async response=>{if(response.status===401){onUnauthorized();return null;}if(!response.ok)throw new Error();return response.json() as Promise<PackageResult>;}).then(data=>data&&setPackageResult(data)).catch(()=>setPackageError(t('annualClosing.packageLoadError')));},[canViewPackage,onUnauthorized,refresh,t,yearId]);
  const isArabic=i18n.language.startsWith('ar');
  const sourceLabel=(source:string)=>isArabic?t(`annualClosing.package.sources.${source}`,{defaultValue:t('annualClosing.package.unknownSource')}):source;
  const blockerCode=(blocker:string)=>blocker.split(':').at(-1)??blocker;
  const blockerLabel=(blocker:string)=>t(`annualClosing.package.blockerMessages.${blockerCode(blocker)}`,{defaultValue:t('annualClosing.package.unknownBlocker')});
  const genericBlockerCodes=new Set(['blocked','needs_review','not_started','not_applicable']);
  const displayFinalizationBlockers=finalizationBlockers.filter(blocker=>!genericBlockerCodes.has(blockerCode(blocker))).map(blockerLabel);
  const snapshotTypeLabel=(type:Snapshot['snapshot_type'])=>t(`annualClosing.package.snapshotTypes.${type}`);
  const formatDateTime=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(i18n.language,{dateStyle:'medium',timeStyle:'short'}).format(date);};
  const blockedFinancialDomainCount=result?financialStatementDomainKeys.filter(key=>(result.domains[key]?.blocker_count??0)>0).length:0;
  const mutate=async(path:string,body:Record<string,unknown>)=>{setPackageError('');setFinalizationBlockers([]);const response=await fetch(`/api/annual-closing/${encodeURIComponent(yearId)}/package${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(response.status===401){onUnauthorized();return;}if(!response.ok){const data=await response.json().catch(()=>({})) as {error?:string;blockers?:string[]};if(path==='/finalize'&&data.blockers?.length){setFinalizationBlockers(data.blockers);}else{setPackageError(data.error||t('annualClosing.packageActionError'));}return;}setRefresh(value=>value+1);};
  if (!canView) return <section className="panel"><p>{t('annualClosing.noAccess')}</p></section>;
  const status = (value: string) => t(`annualClosing.status.${value}`);
  return <section className="panel" aria-labelledby="annual-closing-title">
    <div className="section-heading"><div><h1 id="annual-closing-title">{t('annualClosing.title')}</h1><p>{t('annualClosing.description')}</p></div></div>
    <label>{t('annualClosing.fiscalYear')}<select value={yearId} onChange={event => setYearId(event.target.value)}><option value="">{t('annualClosing.selectYear')}</option>{years.map(year => <option key={year.id} value={year.id}>{year.name} ({year.start_date} – {year.end_date})</option>)}</select></label>
    {loading && <p role="status">{t('annualClosing.loading')}</p>}{error && <p role="alert">{t('annualClosing.error')}</p>}
    {result && <>
      <div className="summary-grid"><article className="summary-card"><strong>{result.ready ? t('annualClosing.ready') : t('annualClosing.notReady')}</strong><span>{t('annualClosing.blockers', { count: result.blocker_count })}</span></article><article className="summary-card"><strong>{i18n.language === 'ar' ? result.financial_statements_readiness.label_ar : result.financial_statements_readiness.label}</strong><span>{status(result.financial_statements_readiness.status)}</span></article><article className="summary-card"><strong>{t('annualClosing.zakat')}</strong><span>{status(result.zakat_readiness.status)}</span></article></div>
      <h2>{t('annualClosing.domains')}</h2><div className="table-wrap"><table><thead><tr><th>{t('annualClosing.domain')}</th><th>{t('annualClosing.state')}</th><th>{t('annualClosing.blockerCount')}</th></tr></thead><tbody>{Object.entries(result.domains).map(([key, value]) => <tr key={key}><td>{t(`annualClosing.domainNames.${key}`)}</td><td>{status(value.status)}</td><td>{value.blocker_count}</td></tr>)}</tbody></table></div>
      <h2>{t('annualClosing.manifest')}</h2><div className="table-wrap"><table><thead><tr><th>{t('annualClosing.section')}</th><th>{t('annualClosing.state')}</th><th>{t('annualClosing.blockerCount')}</th></tr></thead><tbody>{result.package_manifest.map(item => <tr key={item.section}><td>{t(`annualClosing.manifestNames.${item.section}`)}</td><td>{status(item.status)}</td><td>{item.section==='financial_statements_readiness'?t('annualClosing.blockedDomains',{count:blockedFinancialDomainCount}):item.blocker_count ?? '—'}</td></tr>)}</tbody></table></div>
      {canViewPackage&&<section className="panel" aria-labelledby="annual-package-title"><h2 id="annual-package-title">{t('annualClosing.package.title')}</h2>{packageError&&<p role="alert">{packageError}</p>}{finalizationBlockers.length>0&&<div className="warning-alert" role="alert"><strong>{t('annualClosing.package.finalizationWarningTitle')}</strong>{displayFinalizationBlockers.length>0&&<ul>{displayFinalizationBlockers.map((blocker,index)=><li key={`${blocker}-${index}`}>{blocker}</li>)}</ul>}</div>}{packageResult&&!packageResult.package&&<>{<p>{t('annualClosing.package.notCreated')}</p>}{canManagePackage&&<button type="button" onClick={()=>void mutate('',{})}>{t('annualClosing.package.create')}</button>}</>}{packageResult?.package&&<><p><strong>{t('annualClosing.package.state')}:</strong> {status(packageResult.package.status)}</p>{packageResult.drift&&<p role="status">{t('annualClosing.package.drift')}</p>}{packageResult.package.status==='draft'&&<div className="button-row">{canManagePackage&&<button type="button" onClick={()=>void mutate('/snapshots',{version:packageResult.package!.version})}>{t('annualClosing.package.preview')}</button>}{canFinalizePackage&&<button type="button" onClick={()=>void mutate('/finalize',{version:packageResult.package!.version})}>{t('annualClosing.package.finalize')}</button>}</div>}{packageResult.package.status==='finalized'&&canHandoffPackage&&<button type="button" onClick={()=>void mutate('/handoff',{version:packageResult.package!.version,note:null,reference:null})}>{t('annualClosing.package.handoff')}</button>}<p>{t('annualClosing.package.notFiling')}</p><div className="table-wrap"><table><thead><tr><th>{t('annualClosing.section')}</th><th>{t('annualClosing.state')}</th><th>{t('annualClosing.package.source')}</th><th>{t('annualClosing.package.blockers')}</th></tr></thead><tbody>{(packageResult.package.snapshots.at(-1)?.manifest??packageResult.live?.manifest??[]).map(item=><tr key={item.section}><td>{t(`annualClosing.package.sections.${item.section}`)}</td><td>{status(item.status)}</td><td>{sourceLabel(item.source)}</td><td>{item.blockers.map(blockerLabel).join(isArabic?'، ':', ')||'—'}</td></tr>)}</tbody></table></div>{packageResult.package.snapshots.map(snapshot=><p key={snapshot.id}>{t('annualClosing.package.snapshot',{number:snapshot.snapshot_no,type:snapshotTypeLabel(snapshot.snapshot_type),date:formatDateTime(snapshot.created_at)})}</p>)}{packageResult.package.finalized_at&&<p>{t('annualClosing.package.finalizedAt',{date:formatDateTime(packageResult.package.finalized_at)})}</p>}{packageResult.package.handed_off_at&&<p>{t('annualClosing.package.handedOffAt',{date:formatDateTime(packageResult.package.handed_off_at)})}</p>}</>}</section>}
      <TaxWorkpaper yearId={yearId} canView={canViewWorkpaper} canManage={canManage} canReview={canReview} canApprove={canApprove} onUnauthorized={onUnauthorized} onChanged={() => setRefresh(value => value + 1)}/>
    </>}
  </section>;
}
