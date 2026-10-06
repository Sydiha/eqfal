import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { TaxWorkpaper } from './TaxWorkpaper';
import { WhtReviews } from './WhtReviews';
import { useDateContext } from '../context/DateContext';
import './AnnualClosing.css';

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
type Package={id:string;status:'draft'|'finalized'|'handed_off'|'reviewed'|'approved';version:number;final_snapshot_id:string|null;finalized_at:string|null;handed_off_at:string|null;handoff_note:string|null;handoff_reference:string|null;reviewed_by_user_id:string|null;reviewed_at:string|null;review_note:string|null;approved_by_user_id:string|null;approved_at:string|null;approval_note:string|null;snapshots:Snapshot[]};
type PackageResult={package:Package|null;live:{manifest:ManifestSection[];source_fingerprint:string}|null;drift:boolean};

const financialStatementDomainKeys = ['monthly_close', 'ledger', 'documents', 'assets', 'adjustments', 'opening_balances'] as const;

export function AnnualClosing({ canView, canViewPackage=false, canCreatePackage=false, canCreatePackageSnapshot=false, canFinalizePackage=false, canHandoffPackage=false, canReviewPackage=false, canApprovePackage=false, canViewWorkpaper=false, canCreateWorkpaper=false, canEditWorkpaper=false, canCreateWorkpaperAdjustment=false, canEditWorkpaperAdjustment=false, canDeleteWorkpaperAdjustment=false, canSubmitWorkpaper=false, canReview=false, canApprove=false, canViewWht=false, canCreateWht=false, canEditWht=false, canSubmitWht=false, canReviewWht=false, onUnauthorized }: { canView: boolean; canViewPackage?:boolean; canCreatePackage?:boolean; canCreatePackageSnapshot?:boolean; canFinalizePackage?:boolean;canHandoffPackage?:boolean; canReviewPackage?:boolean; canApprovePackage?:boolean; canViewWorkpaper?: boolean; canCreateWorkpaper?:boolean; canEditWorkpaper?:boolean; canCreateWorkpaperAdjustment?:boolean; canEditWorkpaperAdjustment?:boolean; canDeleteWorkpaperAdjustment?:boolean; canSubmitWorkpaper?:boolean; canReview?: boolean; canApprove?: boolean; canViewWht?:boolean; canCreateWht?:boolean; canEditWht?:boolean; canSubmitWht?:boolean; canReviewWht?:boolean; onUnauthorized: () => void }) {
  const { t, i18n } = useTranslation();
  const { selectedFiscalYearId } = useDateContext();
  const [years, setYears] = useState<FiscalYear[]>([]);
  const [yearId, setYearId] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [packageResult,setPackageResult]=useState<PackageResult|null>(null);
  const [packageError,setPackageError]=useState('');
  const [finalizationBlockers,setFinalizationBlockers]=useState<string[]>([]);
  const [professionalAction,setProfessionalAction]=useState<'review'|'approve'|null>(null);
  const [professionalNote,setProfessionalNote]=useState('');
  const [packageBusy,setPackageBusy]=useState(false);
  const mutatingRef=useRef(false);
  const [tab,setTab]=useState<'readiness'|'package'|'wht'>('readiness');
  useEffect(() => {
    if (!canView) return;
    void fetch('/api/fiscal-years').then(async response => {
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error();
      const data = await response.json() as { fiscalYears: FiscalYear[] };
      setYears(data.fiscalYears);
      // Use selected fiscal year from DateContext if available, otherwise use first
      setYearId(current => current || selectedFiscalYearId || data.fiscalYears[0]?.id || '');
    }).catch(() => setError(true));
  }, [canView, onUnauthorized, selectedFiscalYearId]);
  useEffect(() => {
    if (!canView || !yearId) { setResult(null); return; }
    let cancelled = false;
    setLoading(true); setError(false);
    void fetch(`/api/annual-closing/${encodeURIComponent(yearId)}`).then(async response => {
      if (response.status === 401) { onUnauthorized(); return null; }
      if (!response.ok) throw new Error();
      return response.json() as Promise<Result>;
    }).then(data => { if (data && !cancelled) setResult(data); }).catch(() => { if (!cancelled) setError(true); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [canView, onUnauthorized, yearId, refresh]);
  useEffect(()=>{if(!canViewPackage||!yearId){setPackageResult(null);return;}let cancelled=false;setPackageError('');void fetch(`/api/annual-closing/${encodeURIComponent(yearId)}/package`).then(async response=>{if(response.status===401){onUnauthorized();return null;}if(!response.ok)throw new Error();return response.json() as Promise<PackageResult>;}).then(data=>{if(data&&!cancelled)setPackageResult(data);}).catch(()=>{if(!cancelled){setPackageResult(null);setPackageError(t('annualClosing.packageLoadError'));}});return()=>{cancelled=true;};},[canViewPackage,onUnauthorized,refresh,t,yearId]);
  const isArabic=i18n.language.startsWith('ar');
  const sourceLabel=(source:string)=>isArabic?t(`annualClosing.package.sources.${source}`,{defaultValue:t('annualClosing.package.unknownSource')}):source;
  const blockerCode=(blocker:string)=>blocker.split(':').at(-1)??blocker;
  const blockerLabel=(blocker:string)=>t(`annualClosing.package.blockerMessages.${blockerCode(blocker)}`,{defaultValue:t('annualClosing.package.unknownBlocker')});
  const genericBlockerCodes=new Set(['blocked','needs_review','not_started','not_applicable']);
  const displayFinalizationBlockers=finalizationBlockers.filter(blocker=>!genericBlockerCodes.has(blockerCode(blocker))).map(blockerLabel);
  const snapshotTypeLabel=(type:Snapshot['snapshot_type'])=>t(`annualClosing.package.snapshotTypes.${type}`);
  const formatDateTime=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(i18n.language,{dateStyle:'medium',timeStyle:'short'}).format(date);};
  const blockedFinancialDomainCount=result?financialStatementDomainKeys.filter(key=>(result.domains[key]?.blocker_count??0)>0).length:0;
  const mutate=async(path:string,body:Record<string,unknown>)=>{if(mutatingRef.current)return;mutatingRef.current=true;setPackageBusy(true);try{await runMutate(path,body);}finally{mutatingRef.current=false;setPackageBusy(false);}};
  const runMutate=async(path:string,body:Record<string,unknown>)=>{setPackageError('');setFinalizationBlockers([]);const response=await fetch(`/api/annual-closing/${encodeURIComponent(yearId)}/package${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(()=>null);if(!response){setPackageError(t('annualClosing.packageActionError'));return;}if(response.status===401){onUnauthorized();return;}if(!response.ok){const data=await response.json().catch(()=>({})) as {error?:string;blockers?:string[]};if(path==='/finalize'&&data.blockers?.length){setFinalizationBlockers(data.blockers);}else{setPackageError(data.error||t('annualClosing.packageActionError'));if(response.status===409)setRefresh(value=>value+1);}return;}setRefresh(value=>value+1);};
  const openProfessionalDialog=(action:'review'|'approve')=>{setProfessionalNote('');setProfessionalAction(action);};
  const confirmProfessionalAction=()=>{if(!professionalAction||!packageResult?.package)return;const action=professionalAction;setProfessionalAction(null);void mutate(`/${action}`,{version:packageResult.package.version,note:professionalNote.trim()||null});};
  if (!canView) return <section className="panel"><p>{t('annualClosing.noAccess')}</p></section>;
  const status = (value: string) => t(`annualClosing.status.${value}`);
  const selectedYear=years.find(year=>year.id===yearId);
  const badgeClass=(value:string)=>`ac-badge ac-badge--${value==='ready'||value==='approved'?'ok':value==='blocked'?'bad':value==='needs_review'||value==='draft'?'warn':'neutral'}`;
  const tabs=[['readiness','annualClosing.tabs.readiness'],['package','annualClosing.tabs.package'],['wht','annualClosing.tabs.wht']] as const;
  return <section className="panel annual-closing-view" aria-labelledby="annual-closing-title">
    <header className="ac-header"><h1 id="annual-closing-title">{t('annualClosing.title')}</h1><p>{t('annualClosing.description')}</p></header>
    <div className="ac-card ac-context"><label className="ac-context__year"><span className="ac-muted">{t('annualClosing.fiscalYear')}</span><select value={yearId} disabled={packageBusy} onChange={event => { setPackageResult(null); setPackageError(''); setFinalizationBlockers([]); setResult(null); setYearId(event.target.value); }}><option value="">{t('annualClosing.selectYear')}</option>{years.map(year => <option key={year.id} value={year.id}>{year.name}</option>)}</select></label>{selectedYear&&<span className="ac-muted ac-context__range"><bdi dir="ltr">{selectedYear.start_date} – {selectedYear.end_date}</bdi></span>}</div>
    {loading && <p role="status">{t('annualClosing.loading')}</p>}{error && <p role="alert">{t('annualClosing.error')}</p>}
    {result && <>
      <div className="ac-tabs" role="tablist" aria-label={t('annualClosing.title')}>{tabs.map(([key,label])=><button key={key} type="button" role="tab" id={`ac-tab-${key}`} aria-selected={tab===key} aria-controls={`ac-panel-${key}`} className={tab===key?'ac-tab ac-tab--active':'ac-tab'} onClick={()=>setTab(key)}>{t(label)}</button>)}</div>
      <div role="tabpanel" id="ac-panel-readiness" aria-labelledby="ac-tab-readiness" hidden={tab!=='readiness'} className="ac-panel">
      <div className="ac-card ac-summary"><article><span className="ac-muted">{t('annualClosing.overallStatus')}</span><span className={`ac-badge ${result.ready?'ac-badge--ok':'ac-badge--bad'}`}>{result.ready ? t('annualClosing.ready') : t('annualClosing.notReady')}</span></article><article><strong className="ac-count">{result.blocker_count}</strong><span className="ac-muted">{t('annualClosing.blockers', { count: result.blocker_count })}</span></article><article><span className="ac-muted">{i18n.language === 'ar' ? result.financial_statements_readiness.label_ar : result.financial_statements_readiness.label}</span><span className={badgeClass(result.financial_statements_readiness.status)}>{status(result.financial_statements_readiness.status)}</span></article><article><span className="ac-muted">{t('annualClosing.zakat')}</span><span className={badgeClass(result.zakat_readiness.status)}>{status(result.zakat_readiness.status)}</span></article></div>
      <div className="ac-card"><h2>{t('annualClosing.domains')}</h2><div className="table-wrap"><table className="ac-table"><thead><tr><th>{t('annualClosing.domain')}</th><th>{t('annualClosing.state')}</th><th>{t('annualClosing.blockerCount')}</th><th>{t('annualClosing.nextAction.title')}</th></tr></thead><tbody>{Object.entries(result.domains).map(([key, value]) => <tr key={key}><td>{t(`annualClosing.domainNames.${key}`)}</td><td><span className={badgeClass(value.status)}>{status(value.status)}</span></td><td>{value.blocker_count}</td><td className="ac-next">{t(`annualClosing.nextAction.${key}`,{defaultValue:'—'})}</td></tr>)}</tbody></table></div></div>
      <div className="ac-card"><h2>{t('annualClosing.manifest')}</h2><div className="table-wrap"><table className="ac-table"><thead><tr><th>{t('annualClosing.section')}</th><th>{t('annualClosing.state')}</th><th>{t('annualClosing.blockerCount')}</th></tr></thead><tbody>{result.package_manifest.map(item => <tr key={item.section}><td>{t(`annualClosing.manifestNames.${item.section}`)}</td><td><span className={badgeClass(item.status)}>{status(item.status)}</span></td><td>{item.section==='financial_statements_readiness'?t('annualClosing.blockedDomains',{count:blockedFinancialDomainCount}):item.blocker_count ?? '—'}</td></tr>)}</tbody></table></div></div>
      </div>
      <div role="tabpanel" id="ac-panel-package" aria-labelledby="ac-tab-package" hidden={tab!=='package'} className="ac-panel">
      {canViewPackage&&<section className="ac-card ac-package" aria-labelledby="annual-package-title">
        <div className="ac-package-head">
          <div className="ac-package-title"><h2 id="annual-package-title">{t('annualClosing.package.title')}</h2>{packageResult?.package&&<span className="ac-package-state"><span className="ac-muted">{t('annualClosing.package.state')}:</span> <span className={badgeClass(packageResult.package.status)}>{status(packageResult.package.status)}</span></span>}</div>
          <div className="ac-actions">
            {packageResult&&!packageResult.package&&canCreatePackage&&<button type="button" className="ac-btn ac-btn--primary" disabled={packageBusy} onClick={()=>void mutate('',{})}>{t('annualClosing.package.create')}</button>}
            {packageResult?.package?.status==='draft'&&canCreatePackageSnapshot&&<button type="button" className="ac-btn ac-btn--primary" disabled={packageBusy} onClick={()=>void mutate('/snapshots',{version:packageResult.package!.version})}>{t('annualClosing.package.preview')}</button>}
            {packageResult?.package?.status==='draft'&&canFinalizePackage&&<button type="button" className="ac-btn" disabled={packageBusy} onClick={()=>void mutate('/finalize',{version:packageResult.package!.version})}>{t('annualClosing.package.finalize')}</button>}
            {packageResult?.package?.status==='finalized'&&canHandoffPackage&&<button type="button" className="ac-btn ac-btn--primary" disabled={packageBusy} onClick={()=>void mutate('/handoff',{version:packageResult.package!.version,note:null,reference:null})}>{t('annualClosing.package.handoff')}</button>}
            {packageResult?.package?.status==='handed_off'&&canReviewPackage&&<button type="button" className="ac-btn ac-btn--primary" disabled={packageResult.drift||packageBusy} onClick={()=>openProfessionalDialog('review')}>{t('annualClosing.package.review')}</button>}
            {packageResult?.package?.status==='reviewed'&&canApprovePackage&&<button type="button" className="ac-btn ac-btn--primary" disabled={packageResult.drift||packageBusy} onClick={()=>openProfessionalDialog('approve')}>{t('annualClosing.package.approve')}</button>}
          </div>
        </div>
        {packageError&&<p role="alert">{packageError}</p>}
        {finalizationBlockers.length>0&&<div className="warning-alert" role="alert"><strong>{t('annualClosing.package.finalizationWarningTitle')}</strong>{displayFinalizationBlockers.length>0&&<ul>{displayFinalizationBlockers.map((blocker,index)=><li key={`${blocker}-${index}`}>{blocker}</li>)}</ul>}</div>}
        {packageResult&&!packageResult.package&&<p>{t('annualClosing.package.notCreated')}</p>}
        {packageResult?.package&&<>
          {packageResult.drift&&<p role="status" className="ac-drift">{t('annualClosing.package.drift')}</p>}
          <p className="ac-note">{t('annualClosing.package.notFiling')}</p>
          <div className="table-wrap"><table className="ac-table"><thead><tr><th>{t('annualClosing.section')}</th><th>{t('annualClosing.state')}</th><th>{t('annualClosing.package.source')}</th><th>{t('annualClosing.package.blockers')}</th></tr></thead><tbody>{(packageResult.package.snapshots.at(-1)?.manifest??packageResult.live?.manifest??[]).map(item=><tr key={item.section}><td>{t(`annualClosing.package.sections.${item.section}`)}</td><td><span className={badgeClass(item.status)}>{status(item.status)}</span></td><td>{sourceLabel(item.source)}</td><td>{item.blockers.map(blockerLabel).join(isArabic?'، ':', ')||'—'}</td></tr>)}</tbody></table></div>
          <div className="ac-meta">{packageResult.package.snapshots.map(snapshot=><p key={snapshot.id}>{t('annualClosing.package.snapshot',{number:snapshot.snapshot_no,type:snapshotTypeLabel(snapshot.snapshot_type),date:formatDateTime(snapshot.created_at)})}</p>)}{packageResult.package.finalized_at&&<p>{t('annualClosing.package.finalizedAt',{date:formatDateTime(packageResult.package.finalized_at)})}</p>}{packageResult.package.handed_off_at&&<p>{t('annualClosing.package.handedOffAt',{date:formatDateTime(packageResult.package.handed_off_at)})}</p>}{packageResult.package.reviewed_at&&<p>{t('annualClosing.package.reviewedAt',{date:formatDateTime(packageResult.package.reviewed_at),actor:packageResult.package.reviewed_by_user_id||'—',note:packageResult.package.review_note||'—'})}</p>}{packageResult.package.approved_at&&<p>{t('annualClosing.package.approvedAt',{date:formatDateTime(packageResult.package.approved_at),actor:packageResult.package.approved_by_user_id||'—',note:packageResult.package.approval_note||'—'})}</p>}</div>
        </>}
      </section>}
      {professionalAction&&<Dialog title={t(`annualClosing.package.${professionalAction}DialogTitle`)} onClose={()=>setProfessionalAction(null)}><div className="form-grid"><label>{t('annualClosing.package.professionalNote')}<textarea value={professionalNote} onChange={event=>setProfessionalNote(event.currentTarget.value)} maxLength={2000}/></label><div className="modal-actions"><button type="button" onClick={()=>setProfessionalAction(null)}>{t('common.cancel')}</button><button type="button" className="primary" onClick={confirmProfessionalAction}>{t(`annualClosing.package.${professionalAction}Confirm`)}</button></div></div></Dialog>}
      <div className="ac-card"><TaxWorkpaper yearId={yearId} canView={canViewWorkpaper} canCreate={canCreateWorkpaper} canEdit={canEditWorkpaper} canCreateAdjustment={canCreateWorkpaperAdjustment} canEditAdjustment={canEditWorkpaperAdjustment} canDeleteAdjustment={canDeleteWorkpaperAdjustment} canSubmit={canSubmitWorkpaper} canReview={canReview} canApprove={canApprove} onUnauthorized={onUnauthorized} onChanged={() => setRefresh(value => value + 1)}/></div>
      </div>
      <div role="tabpanel" id="ac-panel-wht" aria-labelledby="ac-tab-wht" hidden={tab!=='wht'} className="ac-panel">
      <div className="ac-card"><WhtReviews fiscalYearId={yearId} canView={canViewWht} canCreate={canCreateWht} canEdit={canEditWht} canSubmit={canSubmitWht} canReview={canReviewWht} onUnauthorized={onUnauthorized} onChanged={() => setRefresh(value => value + 1)}/></div>
      </div>
    </>}
  </section>;
}
