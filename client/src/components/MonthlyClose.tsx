import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDisplayDate } from '../date-format';
import { readQueryParameter, writeQueryParameters } from '../navigation/queryState';
import { Dialog } from './Dialog';
import { WorkspacePage, WorkspaceState } from './SharedUI';
import './MonthlyClose.css';

type Blockers={documents:number;obligations:number;bank_transactions:number;vat:number;ledger:number;assets:number;opening_balances:number;periodic_adjustments:number};
type Period={id:string;fiscal_year_id:string;period_start:string;period_end:string;status:'open'|'closed';ready:boolean;blockers:Partial<Blockers>;disclosed_total:number;has_hidden_blockers:boolean};
type FiscalYear={id:string;name:string;start_date:string;end_date:string};
type DestinationPage='documents'|'banks'|'obligations'|'vat'|'accounting'|'assets'|'openingBalances'|'periodicAdjustments';
interface Props{canView:boolean;canViewFiscalYears:boolean;canCreate:boolean;canClose:boolean;canReopen:boolean;viewCapabilities:{documents:boolean;obligations:boolean;bank:boolean;vat:boolean;accounting:boolean;assets:boolean;openingBalances:boolean;periodicAdjustments:boolean};onNavigate?:(page:DestinationPage,parameters:Record<string,string>)=>void;onUnauthorized:()=>void;selectedPeriodId?:string|null}
async function api(url:string,options:RequestInit,onUnauthorized:()=>void){const response=await fetch(url,{credentials:'same-origin',...options});if(response.status===401)onUnauthorized();if(!response.ok)throw new Error(String(response.status));return response;}

// Presentation-only icons (Lucide geometry, matching the Figma icon layers).
const Ic=({children,size=14}:{children:ReactNode;size?:number})=><svg className="mc-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>;
const IcPlus=()=><Ic><path d="M5 12h14M12 5v14"/></Ic>;
const IcChevronLeft=()=><Ic size={12}><path d="m15 18-6-6 6-6"/></Ic>;
const IcLock=()=><Ic><circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/></Ic>;
const IcFileText=()=><Ic><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/></Ic>;
const IcUsers=()=><Ic><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></Ic>;
const IcCard=()=><Ic><rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/></Ic>;
const IcPercent=()=><Ic><path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></Ic>;
const IcDatabase=()=><Ic><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/></Ic>;
const IcKey=()=><Ic><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></Ic>;
const IcCalendar=()=><Ic><path d="M8 2v4M16 2v4M3 10h18"/><rect width="18" height="18" x="3" y="4" rx="2"/></Ic>;
const IcBook=()=><Ic><path d="M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></Ic>;

export function MonthlyClose({canView,canViewFiscalYears,canCreate,canClose,canReopen,viewCapabilities,onNavigate=()=>undefined,onUnauthorized,selectedPeriodId}:Props){
 const {t,i18n}=useTranslation();
 const [periods,setPeriods]=useState<Period[]>([]),[years,setYears]=useState<FiscalYear[]>([]);
 const [selectedId,setSelectedId]=useState<string|null>(null),[yearFilter,setYearFilter]=useState('');
 const [loading,setLoading]=useState(canView),[error,setError]=useState(false),[creating,setCreating]=useState(false),[reopen,setReopen]=useState<Period|null>(null),[saving,setSaving]=useState(false);
 const load=async()=>{setLoading(true);setError(false);try{const p=await api('/api/monthly-close-periods',{},onUnauthorized);const next=((await p.json()) as {periods:Period[]}).periods;const fiscalYearsUrl=canViewFiscalYears?'/api/fiscal-years':canCreate?'/api/monthly-close-fiscal-years':null;const nextYears=fiscalYearsUrl?((await (await api(fiscalYearsUrl,{},onUnauthorized)).json()) as {fiscalYears:FiscalYear[]}).fiscalYears:[];const requestedYear=readQueryParameter('closeYear');const requestedPeriod=readQueryParameter('closePeriod');const validYear=requestedYear&&(nextYears.some(year=>year.id===requestedYear)||(!canViewFiscalYears&&next.some(period=>period.fiscal_year_id===requestedYear)))?requestedYear:'';const available=validYear?next.filter(period=>period.fiscal_year_id===validYear):next;const restored=requestedPeriod&&available.some(period=>period.id===requestedPeriod)?requestedPeriod:(available[0]?.id??null);setPeriods(next);setYears(nextYears);setYearFilter(validYear);setSelectedId(restored);writeQueryParameters({closeYear:validYear||null,closePeriod:restored},'replace');}catch{setError(true)}finally{setLoading(false)}};
 useEffect(()=>{if(canView)void load();// eslint-disable-next-line react-hooks/exhaustive-deps
 },[canView]);
 useEffect(()=>{if(selectedPeriodId&&periods.length>0){const globalPeriod=periods.find(p=>p.id===selectedPeriodId);if(globalPeriod&&selectedId!==globalPeriod.id){selectPeriod(globalPeriod.id);}}},[selectedPeriodId,periods]);
 if(!canView)return <WorkspacePage><WorkspaceState>{t('monthlyClose.noAccess')}</WorkspaceState></WorkspacePage>;
 const availablePeriods=yearFilter?periods.filter(period=>period.fiscal_year_id===yearFilter):periods,selected=periods.find(period=>period.id===selectedId)??null;
 const selectPeriod=(id:string)=>{setSelectedId(id);writeQueryParameters({closePeriod:id});};
 const selectYear=(value:string)=>{const next=(value?periods.find(period=>period.fiscal_year_id===value):periods[0])?.id??null;setYearFilter(value);setSelectedId(next);writeQueryParameters({closeYear:value||null,closePeriod:next});};
 const drill=(page:DestinationPage,parameters:Record<string,string>)=>selected&&onNavigate(page,parameters);
 const create=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const data=new FormData(event.currentTarget);setSaving(true);try{await api('/api/monthly-close-periods',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fiscal_year_id:data.get('fiscal_year_id'),period_start:data.get('period_start'),period_end:data.get('period_end')})},onUnauthorized);setCreating(false);await load()}catch{setError(true)}finally{setSaving(false)}};
 const close=async(period:Period)=>{setSaving(true);try{await api(`/api/monthly-close-periods/${period.id}/close`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'},onUnauthorized);await load()}catch{setError(true)}finally{setSaving(false)}};
 const submitReopen=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!reopen)return;const reason=String(new FormData(event.currentTarget).get('reason')??'').trim();if(!reason)return;setSaving(true);try{await api(`/api/monthly-close-periods/${reopen.id}/reopen`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason})},onUnauthorized);setReopen(null);await load()}catch{setError(true)}finally{setSaving(false)}};
 const monthLabel=(iso:string)=>{const m=/^(\d{4})-(\d{2})/.exec(iso);if(!m)return iso;return new Intl.DateTimeFormat(i18n.language.startsWith('ar')?'ar-SA-u-ca-gregory-nu-latn':'en-GB',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(Number(m[1]),Number(m[2])-1,1)))};
 const rangeLabel=(period:Period)=>`${formatDisplayDate(period.period_start,i18n.language)} — ${formatDisplayDate(period.period_end,i18n.language)}`;
 // Same eight domains, labels, permission gates and drill-through targets as before; only the presentation changed.
 const domains=selected?[
  {key:'documents',allowed:viewCapabilities.documents,label:t('monthlyClose.documents',{count:selected.blockers.documents}).replace(/:\s*\d+$/,''),count:selected.blockers.documents,icon:<IcFileText/>,go:()=>drill('documents',{from:selected.period_start,to:selected.period_end})},
  {key:'obligations',allowed:viewCapabilities.obligations,label:t('monthlyClose.obligations',{count:selected.blockers.obligations}).replace(/:\s*\d+$/,''),count:selected.blockers.obligations,icon:<IcUsers/>,go:()=>drill('obligations',{confirmation:'unconfirmed',recognizedFrom:selected.period_start,recognizedTo:selected.period_end})},
  {key:'bank',allowed:viewCapabilities.bank,label:t('monthlyClose.transactions',{count:selected.blockers.bank_transactions}).replace(/:\s*\d+$/,''),count:selected.blockers.bank_transactions,icon:<IcCard/>,go:()=>drill('banks',{section:'transactions',from:selected.period_start,to:selected.period_end})},
  {key:'vat',allowed:viewCapabilities.vat,label:t('nav.vat'),count:selected.blockers.vat,icon:<IcPercent/>,go:()=>drill('vat',{vatFrom:selected.period_start,vatTo:selected.period_end})},
  {key:'assets',allowed:viewCapabilities.assets,label:t('assets.title'),count:selected.blockers.assets,icon:<IcDatabase/>,go:()=>drill('assets',{assetFrom:selected.period_start,assetTo:selected.period_end})},
  {key:'openingBalances',allowed:viewCapabilities.openingBalances,label:t('monthlyClose.openingBalances'),count:selected.blockers.opening_balances,icon:<IcKey/>,go:()=>drill('openingBalances',{fiscalYear:selected.fiscal_year_id})},
  {key:'periodicAdjustments',allowed:viewCapabilities.periodicAdjustments,label:t('monthlyClose.periodicAdjustments'),count:selected.blockers.periodic_adjustments,icon:<IcCalendar/>,go:()=>drill('periodicAdjustments',{adjustmentFrom:selected.period_start,adjustmentTo:selected.period_end})},
  {key:'ledger',allowed:viewCapabilities.accounting,label:`${t('accounting.title')} / ${t('accounting.tabs.ledger')}`,count:selected.blockers.ledger,icon:<IcBook/>,go:()=>drill('accounting',{accountingTab:'sources',sourceFrom:selected.period_start,sourceTo:selected.period_end})},
 ].filter(domain=>domain.allowed&&domain.count!==undefined):[];
 const clearDomains=domains.filter(domain=>domain.count===0).length,actionDomains=domains.length-clearDomains;
 const showClose=!!selected&&canClose&&selected.status==='open',showReopen=!!selected&&canReopen&&selected.status==='closed';
 return <section className="panel mc-view" aria-labelledby="monthly-close-title">
  <header className="mc-header"><h2 id="monthly-close-title">{t('monthlyClose.title')}</h2><p>{t('monthlyClose.description')}</p></header>
  {error&&<WorkspaceState tone="error" action={<button onClick={()=>void load()}>{t('common.retry')}</button>}>{t('monthlyClose.error')}</WorkspaceState>}
  {loading?<WorkspaceState>{t('monthlyClose.loading')}</WorkspaceState>:<>
   <section className="mc-card mc-periods" aria-label={t('monthlyClose.periods')}>
    <div className="mc-periods__bar">
     <div className="mc-periods__filter"><h3>{t('monthlyClose.periods')}</h3>{canViewFiscalYears&&<label><span>{t('monthlyClose.fiscalYear')}</span><select value={yearFilter} onChange={e=>selectYear(e.target.value)}><option value="">{t('monthlyClose.allYears')}</option>{years.map(year=><option key={year.id} value={year.id}>{year.name}</option>)}</select></label>}</div>
     {canCreate&&<button className="mc-primary" onClick={()=>setCreating(true)}><IcPlus/>{t('monthlyClose.create')}</button>}
    </div>
    {periods.length===0?<p className="mc-empty">{t('monthlyClose.empty')}</p>:<div className="mc-period-list" aria-label={t('monthlyClose.selectPeriod')}>{availablePeriods.map(period=>{const isSelected=selectedId===period.id;return <button key={period.id} type="button" className={`mc-period${isSelected?' is-selected':''}`} aria-pressed={isSelected} onClick={()=>selectPeriod(period.id)}><span className="mc-period__top">{isSelected?<span className="mc-badge mc-badge--neutral">{t(`monthlyClose.${period.status}`)}</span>:<span className="mc-period__dash" aria-hidden="true">—</span>}<span className="mc-period__month">{monthLabel(period.period_start)}</span></span><span className="mc-period__dates">{rangeLabel(period)}</span></button>})}</div>}
   </section>
   {selected&&<>
    <section className={`mc-card mc-summary ${selected.status}`} aria-label={monthLabel(selected.period_start)}>
     <div className="mc-summary__head">
      <div className="mc-summary__identity"><h3>{monthLabel(selected.period_start)}</h3><span className={`mc-badge mc-badge--${selected.status==='open'?'neutral':'closed'}`}>{t(`monthlyClose.${selected.status}`)}</span><span className="mc-summary__dates">{rangeLabel(selected)}</span></div>
      <span className={`mc-badge ${selected.ready?'mc-badge--ok':'mc-badge--warn'}`}>{selected.ready?t('monthlyClose.ready'):t('monthlyClose.notReady')}</span>
     </div>
     {!selected.ready&&<div className="mc-summary__metrics">
      <div className="mc-metric mc-metric--blockers"><strong>{selected.has_hidden_blockers?t('monthlyClose.blockedHidden'):t('monthlyClose.blocked',{count:selected.disclosed_total})}</strong>{!selected.has_hidden_blockers&&<span>{t('monthlyClose.domainsNeedAction',{count:actionDomains})}</span>}</div>
      {!selected.has_hidden_blockers&&<div className="mc-metric mc-metric--clear"><strong>{t('monthlyClose.domainsClear',{clear:clearDomains,total:domains.length})}</strong><span>{t('monthlyClose.domainsClearNote')}</span></div>}
      <div className="mc-metric mc-metric--next"><span>{t('monthlyClose.nextStep')}</span><strong>{t('monthlyClose.nextStepText')}</strong></div>
     </div>}
    </section>
    {(!selected.ready||showClose||showReopen)&&<section className="mc-card mc-readiness" aria-label={t('monthlyClose.readinessTitle')}>
     {!selected.ready&&<>
      <div className="mc-readiness__head"><div><h3>{t('monthlyClose.readinessTitle')}</h3><p>{t('monthlyClose.readinessSubtitle',{period:monthLabel(selected.period_start)})}</p></div><span className="mc-muted">{t('monthlyClose.domainCount',{count:domains.length})}</span></div>
      <div className="mc-table"><table><thead><tr><th>{t('monthlyClose.colDomain')}</th><th>{t('monthlyClose.colStatus')}</th><th>{t('monthlyClose.colCount')}</th><th>{t('monthlyClose.colAction')}</th></tr></thead>
       <tbody>{domains.map(domain=>{const count=domain.count as number;return <tr key={domain.key} className={count>0?'is-blocked':undefined}>
        <td><span className="mc-domain">{domain.icon}<span>{domain.label}</span></span></td>
        <td><span className={`mc-badge ${count>0?'mc-badge--warn':'mc-badge--ok'}`}>{count>0?t('monthlyClose.needsAction'):t('monthlyClose.noBlockers')}</span></td>
        <td className={count>0?'mc-count mc-count--active':'mc-count'}>{count}</td>
        <td>{count>0?<button type="button" className="mc-link" aria-label={`${domain.label} ${count}`} onClick={domain.go}><span>{t('monthlyClose.viewItems')}</span><IcChevronLeft/></button>:<span className="mc-muted" aria-hidden="true">—</span>}</td>
       </tr>})}</tbody></table></div>
     </>}
     {(showClose||showReopen)&&<div className="mc-readiness__foot">
      {showClose&&!selected.ready&&<div className="mc-readiness__reason"><span>{selected.has_hidden_blockers?t('monthlyClose.closeUnavailableGeneric'):t('monthlyClose.closeUnavailable',{count:selected.disclosed_total})}</span><span>{t('monthlyClose.openNotClosed')}</span></div>}
      {showClose&&<button className={selected.ready?'mc-dark':'mc-disabled'} disabled={!selected.ready||saving} onClick={()=>void close(selected)}>{t('monthlyClose.close')}<IcLock/></button>}
      {showReopen&&<button className="mc-ghost" disabled={saving} onClick={()=>setReopen(selected)}>{t('monthlyClose.reopen')}</button>}
     </div>}
    </section>}
   </>}
  </>}
  {creating&&<Dialog title={t('monthlyClose.create')} busy={saving} onClose={()=>setCreating(false)}><form className="mc-form" onSubmit={create}><label>{t('monthlyClose.fiscalYear')}<select name="fiscal_year_id" required>{years.map(y=><option key={y.id} value={y.id}>{y.name}</option>)}</select></label><label>{t('monthlyClose.start')}<input name="period_start" type="date" required/></label><label>{t('monthlyClose.end')}<input name="period_end" type="date" required/></label><div className="modal-actions"><button type="button" className="mc-ghost" onClick={()=>setCreating(false)}>{t('common.cancel')}</button><button className="mc-primary" disabled={saving}>{t('common.save')}</button></div></form></Dialog>}
  {reopen&&<Dialog title={t('monthlyClose.reopen')} busy={saving} onClose={()=>setReopen(null)}><form className="mc-form" onSubmit={submitReopen}><label>{t('monthlyClose.reason')}<textarea name="reason" required maxLength={500}/></label><div className="modal-actions"><button type="button" className="mc-ghost" onClick={()=>setReopen(null)}>{t('common.cancel')}</button><button className="mc-primary" disabled={saving}>{t('monthlyClose.reopen')}</button></div></form></Dialog>}
 </section>;
}
