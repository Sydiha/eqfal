import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDisplayDate } from '../date-format';
import { Dialog } from './Dialog';
import { WorkspacePage, WorkspaceState } from './SharedUI';
import { VatReportActions } from './VatReportActions';
import { readQueryParameter } from '../navigation/queryState';
import { useDateContext } from '../context/DateContext';
import './Vat.css';

type Blockers={unapproved_documents:number;missing_reviews:number;pending_reviews:number;total:number};
type Period={id:string;fiscal_year_id:string;period_start:string;period_end:string;status:'open'|'closed';ready:boolean;blockers:Blockers};
type FiscalYear={id:string;name:string;start_date:string;end_date:string};
type VatDocument={id:string;status:string;original_filename:string;document_type:'purchase'|'expense'|'sale';document_date:string|null;counterparty_name:string|null;total_amount:string|null;review_id:string|null;tax_date:string|null;treatment:'standard'|'zero_rated'|'exempt'|'out_of_scope'|null;taxable_amount:string|null;vat_amount:string|null;review_status:'pending'|'reviewed'|null;review_note:string|null;version:number|null};
interface Props{canView:boolean;canReview:boolean;canClose:boolean;canReopen:boolean;onUnauthorized:()=>void;selectedPeriodId?:string|null}
async function api(url:string,options:RequestInit,onUnauthorized:()=>void){const response=await fetch(url,{credentials:'same-origin',...options});if(response.status===401)onUnauthorized();if(!response.ok)throw new Error(String(response.status));return response;}

export function Vat({canView,canReview,canClose,canReopen,onUnauthorized,selectedPeriodId: _unused}:Props){
 const {t,i18n}=useTranslation();
 const { selectedPeriodId } = useDateContext();
 const [periods,setPeriods]=useState<Period[]>([]);const [years,setYears]=useState<FiscalYear[]>([]);const [selectedId,setSelectedId]=useState<string|null>(null);const [documents,setDocuments]=useState<VatDocument[]>([]);const [selectedDocument,setSelectedDocument]=useState<VatDocument|null>(null);const [search,setSearch]=useState('');const [reviewFilter,setReviewFilter]=useState('');const [typeFilter,setTypeFilter]=useState('');const [treatmentFilter,setTreatmentFilter]=useState('');const [loading,setLoading]=useState(canView);const [error,setError]=useState(false);const [creating,setCreating]=useState(false);const [editing,setEditing]=useState<VatDocument|null>(null);const [reopen,setReopen]=useState<Period|null>(null);const [saving,setSaving]=useState(false);
 const selected=periods.find(p=>p.id===selectedId)??null;
 const loadPeriods=async()=>{setLoading(true);setError(false);try{const [p,y]=await Promise.all([api('/api/vat-periods',{},onUnauthorized),api('/api/fiscal-years',{},onUnauthorized)]);const next=((await p.json()) as {periods:Period[]}).periods;const from=readQueryParameter('vatFrom'),to=readQueryParameter('vatTo');const requested=from&&to?next.find(period=>period.period_start===from&&period.period_end===to):null;setPeriods(next);setYears(((await y.json()) as {fiscalYears:FiscalYear[]}).fiscalYears);setSelectedId(current=>requested?.id??(current&&next.some(x=>x.id===current)?current:(next[0]?.id??null)));}catch{setError(true)}finally{setLoading(false)}};
 const loadDetail=async(id:string)=>{try{const response=await api(`/api/vat-periods/${id}`,{},onUnauthorized);const data=await response.json() as {period:Period;documents:VatDocument[]};setPeriods(current=>current.map(p=>p.id===id?data.period:p));setDocuments(data.documents);setSelectedDocument(current=>current?data.documents.find(document=>document.id===current.id)??null:null);}catch{setError(true)}};
 useEffect(()=>{if(canView)void loadPeriods();// eslint-disable-next-line react-hooks/exhaustive-deps
 },[canView]);
 useEffect(()=>{if(selectedId)void loadDetail(selectedId);else setDocuments([]);// eslint-disable-next-line react-hooks/exhaustive-deps
 },[selectedId]);
 useEffect(()=>{if(selectedPeriodId&&periods.length>0){const globalPeriod=periods.find(p=>p.id===selectedPeriodId);if(globalPeriod&&selectedId!==globalPeriod.id){setSelectedId(globalPeriod.id);}}},[selectedPeriodId,periods]);
 const totals=useMemo(()=>documents.reduce((acc,d)=>{if(d.review_status!=='reviewed'||!d.vat_amount)return acc;const amount=Number(d.vat_amount);if(d.document_type==='sale')acc.output+=amount;else acc.input+=amount;return acc},{input:0,output:0}),[documents]);
 const visibleDocuments=useMemo(()=>{const query=search.trim().toLocaleLowerCase();return documents.filter(d=>(!query||[d.original_filename,d.counterparty_name,d.review_note].some(value=>value?.toLocaleLowerCase().includes(query)))&&(!reviewFilter||(reviewFilter==='not_reviewed'?!d.review_status:d.review_status===reviewFilter))&&(!typeFilter||d.document_type===typeFilter)&&(!treatmentFilter||d.treatment===treatmentFilter))},[documents,search,reviewFilter,typeFilter,treatmentFilter]);
 const ar=i18n.language.startsWith('ar');
 if(!canView)return <WorkspacePage><WorkspaceState>{t('vat.noAccess')}</WorkspaceState></WorkspacePage>;
 const refresh=async()=>{await loadPeriods();if(selectedId)await loadDetail(selectedId)};
 const create=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const data=new FormData(event.currentTarget);setSaving(true);try{await api('/api/vat-periods',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fiscal_year_id:data.get('fiscal_year_id'),period_start:data.get('period_start'),period_end:data.get('period_end')})},onUnauthorized);setCreating(false);await loadPeriods()}catch{setError(true)}finally{setSaving(false)}};
 const close=async(period:Period)=>{setSaving(true);try{await api(`/api/vat-periods/${period.id}/close`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'},onUnauthorized);await refresh()}catch{setError(true)}finally{setSaving(false)}};
 const submitReopen=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!reopen)return;const reason=String(new FormData(event.currentTarget).get('reason')??'').trim();if(!reason)return;setSaving(true);try{await api(`/api/vat-periods/${reopen.id}/reopen`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason})},onUnauthorized);setReopen(null);await refresh()}catch{setError(true)}finally{setSaving(false)}};
 const saveReview=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!editing)return;const data=new FormData(event.currentTarget);const status=String(data.get('review_status'));const body=status==='pending'?{tax_date:data.get('tax_date'),treatment:null,taxable_amount:null,vat_amount:null,review_status:'pending',review_note:data.get('review_note')||null,...(editing.version?{version:editing.version}:{})}:{tax_date:data.get('tax_date'),treatment:data.get('treatment'),taxable_amount:String(data.get('taxable_amount')??''),vat_amount:String(data.get('vat_amount')??''),review_status:'reviewed',review_note:data.get('review_note')||null,...(editing.version?{version:editing.version}:{})};setSaving(true);try{await api(`/api/documents/${editing.id}/vat-review`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)},onUnauthorized);setEditing(null);if(selectedId)await loadDetail(selectedId);await loadPeriods()}catch{setError(true)}finally{setSaving(false)}};
 const rangeLabel=(period:Period)=><span className="vat-range" dir="ltr"><bdi dir="rtl">{formatDisplayDate(period.period_start,i18n.language)}</bdi> — <bdi dir="rtl">{formatDisplayDate(period.period_end,i18n.language)}</bdi></span>;
 const optionLabel=(period:Period)=>`\u2067${formatDisplayDate(period.period_start,i18n.language)}\u2069 — \u2067${formatDisplayDate(period.period_end,i18n.language)}\u2069`;
 const reviewLabel=(d:VatDocument)=>d.review_status?t(`vat.${d.review_status}`):d.status==='approved'?t('vat.notReviewed'):t('vat.documentNotApproved');
 const reviewTone=(d:VatDocument)=>d.review_status==='reviewed'?'ok':d.review_status==='pending'?'warn':'neutral';
 const canEdit=(d:VatDocument)=>canReview&&selected?.status==='open'&&d.status==='approved';
 const amount=(value:string|null)=><bdi dir="ltr">{value??'—'}</bdi>;
 const blockerRows:[string,number][]=selected?[[t('vat.unapprovedLabel'),selected.blockers.unapproved_documents],[t('vat.missingReviewsLabel'),selected.blockers.missing_reviews],[t('vat.pendingReviewsLabel'),selected.blockers.pending_reviews]]:[];
 const hasFilters=Boolean(search||reviewFilter||typeFilter||treatmentFilter);
 const currency=t('vat.currency');
 return <section className="panel vat-view" aria-labelledby="vat-title">
  <header className="vat-header"><h2 id="vat-title">{t('vat.title')}</h2><p>{t('vat.description')}</p></header>
  {error&&<WorkspaceState tone="error" action={<button onClick={()=>void refresh()}>{t('common.retry')}</button>}>{t('vat.error')}</WorkspaceState>}
  {loading?<WorkspaceState>{t('vat.loading')}</WorkspaceState>:periods.length===0?<>{canClose&&<div className="vat-card vat-periods"><button className="vat-primary" onClick={()=>setCreating(true)}>{t('vat.createPeriod')}<svg className="vat-icon" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg></button></div>}<WorkspaceState>{t('vat.empty')}</WorkspaceState></>:<>
   <section className="vat-card vat-periods" aria-label={t('vat.period')}>
    <label className="vat-periods__select"><span>{t('vat.period')}</span><select dir="ltr" value={selectedId??''} onChange={e=>{setSelectedId(e.target.value);setSelectedDocument(null)}}>{periods.map(p=><option key={p.id} value={p.id}>{optionLabel(p)}</option>)}</select></label>
    {selected&&<>{rangeLabel(selected)}<span className={`vat-badge vat-badge--${selected.status==='open'?'ok':'closed'}`}>{t(`vat.${selected.status}`)}</span></>}
    {canClose&&<button className="vat-primary vat-periods__create" onClick={()=>setCreating(true)}>{t('vat.createPeriod')}<svg className="vat-icon" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg></button>}
   </section>
   {selected&&<section className={`vat-card vat-readiness ${selected.status}`} aria-label={t('vat.readinessTitle')}>
    <div className="vat-readiness__summary">
     <div className="vat-readiness__titles"><h3>{t('vat.readinessTitle')}</h3><p><strong>{selected.ready?t('vat.ready'):t('vat.blocked',{count:selected.blockers.total})}</strong></p></div>
     <span className={`vat-badge vat-badge--${selected.ready?'ok':'warn'}`}>{selected.ready?t('vat.ready'):t('vat.notReady')}</span>
    </div>
    <ul className="vat-blockers">{blockerRows.map(([label,count])=><li key={label}><span>{label}</span><b>{count}</b><span className={`vat-badge vat-badge--${count===0?'ok':'warn'}`}>{count===0?t('vat.noBlockers'):t('vat.hasBlockers')}</span></li>)}</ul>
    <div className="vat-readiness__close">
     <div className="vat-readiness__actions">{canClose&&selected.status==='open'&&<button className={selected.ready?'vat-dark':'vat-disabled'} disabled={!selected.ready||saving} onClick={()=>void close(selected)}>{t('vat.closePeriod')}{!selected.ready&&<svg className="vat-icon" viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="6" width="9" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M4.5 6V4.5a2.5 2.5 0 015 0V6" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg>}</button>}{canReopen&&selected.status==='closed'&&<button className="vat-ghost" disabled={saving} onClick={()=>setReopen(selected)}>{t('vat.reopenPeriod')}</button>}{selected.status==='closed'&&<VatReportActions periodId={selected.id} language={i18n.language} onError={()=>setError(true)}/>}</div>
     {selected.status==='open'&&!selected.ready&&<div className="vat-readiness__reason"><p>{t('vat.closeUnavailable')}</p><p>{t('vat.nextStep')}</p></div>}
    </div>
   </section>}
   <section className="vat-card vat-summary" aria-label={t('vat.summaryTitle')}>
    <dl className="vat-summary__values">
     <div><dt>{t('vat.outputVat')}</dt><dd><bdi dir="ltr">{totals.output.toFixed(2)}</bdi><small>{currency}</small></dd></div>
     <div><dt>{t('vat.inputVat')}</dt><dd><bdi dir="ltr">{totals.input.toFixed(2)}</bdi><small>{currency}</small></dd></div>
     <div><dt>{t('vat.netVat')}</dt><dd><bdi dir="ltr">{(totals.output-totals.input).toFixed(2)}</bdi><small>{currency}</small></dd></div>
    </dl>
    <p className="vat-summary__note">{t('vat.summaryNote')}</p>
   </section>
   <div className="vat-filters">
    <div className="vat-search"><input type="search" aria-label={t('vat.search')} value={search} placeholder={t('vat.searchPlaceholder')} onChange={e=>setSearch(e.target.value)}/></div>
    <div className="vat-filter"><span aria-hidden="true">{t('vat.reviewStatus')}:</span><select aria-label={t('vat.reviewStatus')} value={reviewFilter} onChange={e=>setReviewFilter(e.target.value)}><option value="">{t('vat.all')}</option><option value="reviewed">{t('vat.reviewed')}</option><option value="pending">{t('vat.pending')}</option><option value="not_reviewed">{t('vat.notReviewed')}</option></select></div>
    <div className="vat-filter"><span aria-hidden="true">{t('vat.type')}:</span><select aria-label={t('vat.type')} value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}><option value="">{t('vat.all')}</option>{['purchase','expense','sale'].map(x=><option key={x} value={x}>{t(`documents.intake.types.${x}`)}</option>)}</select></div>
    <div className="vat-filter"><span aria-hidden="true">{t('vat.treatment')}:</span><select aria-label={t('vat.treatment')} value={treatmentFilter} onChange={e=>setTreatmentFilter(e.target.value)}><option value="">{t('vat.all')}</option>{['standard','zero_rated','exempt','out_of_scope'].map(x=><option key={x} value={x}>{t(`vat.treatments.${x}`)}</option>)}</select></div>
    {hasFilters&&<button className="vat-ghost" onClick={()=>{setSearch('');setReviewFilter('');setTypeFilter('');setTreatmentFilter('')}}>{t('vat.clearFilters')}</button>}
   </div>
   {documents.length===0?<WorkspaceState>{t('vat.noDocuments')}</WorkspaceState>:<div className={`vat-workspace${selectedDocument?' has-detail':''}`}>
    <section className="vat-card vat-register" aria-label={t('vat.registerTitle')}>
     <div className="vat-register__heading"><h3>{t('vat.registerTitle')}</h3><span className="vat-muted">{t('vat.resultCount',{count:visibleDocuments.length})} • {t('vat.amountsIn',{currency})}</span></div>
     <div className="vat-table-wrap"><table><thead><tr><th>{t('vat.document')}</th><th>{ar?'العميل / المورد':'Customer / Supplier'}</th><th>{t('vat.documentDate')}</th><th>{t('vat.type')}</th><th>{t('vat.total')}</th><th>{t('vat.vatAmount')}</th><th>{t('vat.reviewStatus')}</th><th>{t('vat.actions')}</th></tr></thead><tbody>{visibleDocuments.map(d=><tr key={d.id} tabIndex={0} aria-selected={selectedDocument?.id===d.id} className={selectedDocument?.id===d.id?'is-selected':undefined} onClick={()=>setSelectedDocument(d)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelectedDocument(d)}}}><td>{d.original_filename}</td><td>{d.counterparty_name??'—'}</td><td>{d.document_date?formatDisplayDate(d.document_date,i18n.language):'—'}</td><td>{t(`documents.intake.types.${d.document_type}`)}</td><td>{d.total_amount??'—'}</td><td>{d.vat_amount??'—'}</td><td><span className={`vat-badge vat-badge--${reviewTone(d)}`}>{reviewLabel(d)}</span></td><td>{canEdit(d)?<button className="vat-link" onClick={event=>{event.stopPropagation();setEditing(d)}}>{d.review_id?t('vat.editReview'):t('vat.review')}</button>:'—'}</td></tr>)}</tbody></table>{visibleDocuments.length===0&&<WorkspaceState>{t('vat.noResults')}</WorkspaceState>}</div>
     <p className="vat-register__count">{t('vat.showing',{count:visibleDocuments.length,total:documents.length})}</p>
    </section>
    {selectedDocument&&<aside className="vat-card vat-detail" aria-label={t('vat.documentDetails')}>
     <div className="vat-detail__header"><h3>{t('vat.detailTitle')}</h3><button className="vat-close" onClick={()=>setSelectedDocument(null)} aria-label={t('common.close')}>×</button></div>
     <div className="vat-detail__identity"><h4>{selectedDocument.original_filename}</h4><span className={`vat-badge vat-badge--${reviewTone(selectedDocument)}`}>{reviewLabel(selectedDocument)}</span></div>
     <dl className="vat-detail__rows">
      <div><dt>{t('vat.taxDate')}</dt><dd>{selectedDocument.tax_date?formatDisplayDate(selectedDocument.tax_date,i18n.language):'—'}</dd></div>
      <div className="vat-detail__stack"><dt>{t('vat.treatment')}</dt><dd>{selectedDocument.treatment?t(`vat.treatments.${selectedDocument.treatment}`):'—'}</dd></div>
      <div className="vat-detail__sep"><dt>{t('vat.taxable')} ({currency})</dt><dd>{amount(selectedDocument.taxable_amount)}</dd></div>
      <div><dt>{t('vat.vatAmount')} ({currency})</dt><dd>{amount(selectedDocument.vat_amount)}</dd></div>
     </dl>
     {selectedDocument.total_amount&&selectedDocument.taxable_amount&&selectedDocument.vat_amount&&<div className="vat-detail__compare"><span>{t('vat.totalFormula')}</span><bdi dir="ltr">{selectedDocument.total_amount} = {selectedDocument.taxable_amount} + {selectedDocument.vat_amount}</bdi></div>}
     <dl className="vat-detail__rows"><div><dt>{t('vat.note')}</dt><dd>{selectedDocument.review_note??'—'}</dd></div></dl>
     {canEdit(selectedDocument)&&<button className="vat-ghost vat-detail__edit" onClick={()=>setEditing(selectedDocument)}>{selectedDocument.review_id?t('vat.editReview'):t('vat.review')}<svg className="vat-icon" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 12l.6-2.6L9.5 2.5l2 2-6.9 6.9L2 12z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg></button>}
    </aside>}
   </div>}
  </>}
  {creating&&<Dialog title={t('vat.createPeriod')} busy={saving} onClose={()=>setCreating(false)}><form className="form-grid" onSubmit={create}><label>{t('vat.fiscalYear')}<select name="fiscal_year_id" required>{years.map(y=><option key={y.id} value={y.id}>{y.name}</option>)}</select></label><label>{t('vat.start')}<input name="period_start" type="date" required/></label><label>{t('vat.end')}<input name="period_end" type="date" required/></label><div className="modal-actions"><button type="button" onClick={()=>setCreating(false)}>{t('common.cancel')}</button><button className="primary" disabled={saving}>{t('common.save')}</button></div></form></Dialog>}
  {editing&&<Dialog title={t('vat.review')} busy={saving} onClose={()=>setEditing(null)}><form className="form-grid" onSubmit={saveReview}><label>{t('vat.taxDate')}<input name="tax_date" type="date" required defaultValue={editing.tax_date??editing.document_date??''}/></label><label>{t('vat.reviewStatus')}<select name="review_status" defaultValue={editing.review_status??'reviewed'}><option value="reviewed">{t('vat.reviewed')}</option><option value="pending">{t('vat.pending')}</option></select></label><label>{t('vat.treatment')}<select name="treatment" defaultValue={editing.treatment??'standard'}><option value="standard">{t('vat.treatments.standard')}</option><option value="zero_rated">{t('vat.treatments.zero_rated')}</option><option value="exempt">{t('vat.treatments.exempt')}</option><option value="out_of_scope">{t('vat.treatments.out_of_scope')}</option></select></label><label>{t('vat.taxable')}<input name="taxable_amount" inputMode="decimal" defaultValue={editing.taxable_amount??''}/></label><label>{t('vat.vatAmount')}<input name="vat_amount" inputMode="decimal" defaultValue={editing.vat_amount??''}/></label><label>{t('vat.note')}<textarea name="review_note" maxLength={500} defaultValue={editing.review_note??''}/></label><div className="modal-actions"><button type="button" onClick={()=>setEditing(null)}>{t('common.cancel')}</button><button className="primary" disabled={saving}>{t('common.save')}</button></div></form></Dialog>}
  {reopen&&<Dialog title={t('vat.reopenPeriod')} busy={saving} onClose={()=>setReopen(null)}><form className="form-grid" onSubmit={submitReopen}><label>{t('vat.reason')}<textarea name="reason" required maxLength={500}/></label><div className="modal-actions"><button type="button" onClick={()=>setReopen(null)}>{t('common.cancel')}</button><button className="primary" disabled={saving}>{t('vat.reopenPeriod')}</button></div></form></Dialog>}
 </section>;
}
