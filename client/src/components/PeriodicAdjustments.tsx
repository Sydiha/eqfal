import {FormEvent,useEffect,useMemo,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {formatDisplayDate} from '../date-format';
import {clearQueryParameters,readQueryParameter} from '../navigation/queryState';
import {useDateContext} from '../context/DateContext';
import {StatusBadge,WorkspaceState} from './SharedUI';
import './PeriodicAdjustments.css';

type AdjustmentType='accrued_expense'|'prepaid_expense'|'accrued_income'|'deferred_income';
type Status='draft'|'in_review'|'approved'|'completed';
type Schedule={id:string;period_start:string;period_end:string;recognition_date:string;amount:string;status:'pending'|'posted';journal_entry_id:string|null};
type Adjustment={id:string;adjustment_type:AdjustmentType;total_amount:string;recognition_start:string;recognition_end:string;document_id:string|null;obligation_id:string|null;document_name:string|null;description:string;reference:string|null;notes:string|null;balance_account_id:string;pnl_account_id:string;workflow_status:Status;review_note:string|null;version:number;schedule:Schedule[]};
type Account={id:string;code:string;name:string;account_type:'asset'|'liability'|'equity'|'revenue'|'expense';is_active:boolean};
type Document={id:string;original_filename:string;status:string};
type Obligation={id:string;direction:string;counterparty_name?:string;document_id:string|null;original_amount:string};
type Props={canView:boolean;canCreate:boolean;canEdit:boolean;canSubmit:boolean;canReview:boolean;canApprove:boolean;canPost:boolean;onUnauthorized:()=>void};

type FormState={type:AdjustmentType;amount:string;start:string;end:string;description:string;reference:string;notes:string;balanceAccountId:string;pnlAccountId:string;documentId:string;obligationId:string};
const initialForm:FormState={type:'accrued_expense',amount:'',start:'',end:'',description:'',reference:'',notes:'',balanceAccountId:'',pnlAccountId:'',documentId:'',obligationId:''};
async function api(url:string,options:RequestInit,onUnauthorized:()=>void){const response=await fetch(url,{credentials:'same-origin',...options});if(response.status===401)onUnauthorized();if(!response.ok)throw new Error(String(response.status));return response;}
const datePattern=/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const validDate=(value:string|null)=>value&&datePattern.test(value)&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value?value:'';
const readClosePeriod=()=>{const from=validDate(readQueryParameter('adjustmentFrom')),to=validDate(readQueryParameter('adjustmentTo'));return from&&to&&from<=to?{from,to}:null};
const json=(method:string,body:unknown):RequestInit=>({method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});

export function PeriodicAdjustments({canView,canCreate,canEdit,canSubmit,canReview,canApprove,canPost,onUnauthorized}:Props){
 const {i18n}=useTranslation();const ar=i18n.language==='ar';
 const {selectedPeriodId,periodMode,selectedFiscalYearId,availableFiscalYears,availablePeriodsForSelectedYear}=useDateContext();
 const l=ar?{
  title:'الاستحقاقات والمقدمات',description:'إدارة المصروفات والإيرادات المستحقة والمقدمة مع جداول الاعتراف والترحيل.',newItem:'إضافة تعديل دوري',type:'النوع',amount:'إجمالي المبلغ',start:'بداية الاعتراف',end:'نهاية الاعتراف',descriptionLabel:'الوصف',reference:'المرجع',notes:'ملاحظات',balanceAccount:'حساب الميزانية',pnlAccount:'حساب الربح والخسارة',document:'المستند المرتبط (اختياري)',obligation:'الالتزام المرتبط (اختياري)',none:'بدون ربط',save:'حفظ',update:'تحديث',cancel:'إلغاء التعديل',items:'التعديلات الدورية',schedule:'جدول الاعتراف',period:'الفترة',recognitionDate:'تاريخ الاعتراف',journal:'القيد',post:'ترحيل الفترة',submit:'إرسال للمراجعة',approve:'اعتماد',returnDraft:'إرجاع إلى المسودة',returnReason:'سبب الإرجاع',loading:'جارٍ التحميل...',empty:'لا توجد تعديلات دورية بعد.',error:'تعذر تحميل أو حفظ البيانات.',noAccess:'ليس لديك صلاحية عرض التعديلات الدورية.',draft:'مسودة',in_review:'قيد المراجعة',approved:'معتمد',completed:'مكتمل',pending:'معلق',posted:'مرحل',accrued_expense:'مصروف مستحق',prepaid_expense:'مصروف مقدم',accrued_income:'إيراد مستحق',deferred_income:'إيراد مقدم',total:'إجمالي التعديلات',pendingCount:'فترات معلقة',postedCount:'فترات مرحلة',accountHint:'اختيار الحسابات هو إعداد محاسبي؛ اتجاه المدين/الدائن يحدده النظام تلقائيًا.',
  progress:'التقدم',recognitionPeriod:'فترة الاعتراف',status:'الحالة',actions:'إجراءات',action:'الإجراء',viewSchedule:'عرض جدول الاعتراف',selected:'محدد',oneItem:'تعديل واحد',itemsCount:(n:number)=>n===1?'تعديل واحد':`${n} تعديلات`,showing:(n:number)=>`عرض ${n} من ${n} تعديل`,scheduleLinked:'جدول الاعتراف أدناه مرتبط بالتعديل المحدد',periodsCount:(n:number)=>`${n} فترات`,scheduleAmounts:'المبالغ بالريال السعودي',currency:'ر.س',progressOf:(a:number,b:number)=>`${a} من ${b} فترات مرحلة`,scheduleTotal:'إجمالي جدول الاعتراف',postNote:'ترحيل الفترة إجراء محاسبي للفترة المحددة فقط؛ الفترة المرحلة لا تُرحل مرة أخرى.',posting:'جارٍ الترحيل...',saving:'جارٍ الحفظ...',posted_done:'تم الترحيل',noSchedule:'لا يوجد جدول اعتراف لهذا التعديل بعد؛ يُنشأ الجدول عند الاعتماد.',selectPrompt:'اختر تعديلًا لعرض جدول الاعتراف.',close:'إغلاق',formTitle:'إضافة تعديل دوري'
 }:{
  title:'Accruals & Prepayments',description:'Manage accrued and prepaid expenses/income with governed recognition schedules and posting.',newItem:'Add periodic adjustment',type:'Type',amount:'Total amount',start:'Recognition start',end:'Recognition end',descriptionLabel:'Description',reference:'Reference',notes:'Notes',balanceAccount:'Balance-sheet account',pnlAccount:'P&L account',document:'Linked document (optional)',obligation:'Linked obligation (optional)',none:'No link',save:'Save',update:'Update',cancel:'Cancel edit',items:'Periodic adjustments',schedule:'Recognition schedule',period:'Period',recognitionDate:'Recognition date',journal:'Journal',post:'Post period',submit:'Submit for review',approve:'Approve',returnDraft:'Return to draft',returnReason:'Return reason',loading:'Loading...',empty:'No periodic adjustments yet.',error:'Could not load or save data.',noAccess:'You do not have access to periodic adjustments.',draft:'Draft',in_review:'In review',approved:'Approved',completed:'Completed',pending:'Pending',posted:'Posted',accrued_expense:'Accrued expense',prepaid_expense:'Prepaid expense',accrued_income:'Accrued income',deferred_income:'Deferred income',total:'Total adjustments',pendingCount:'Pending periods',postedCount:'Posted periods',accountHint:'Account selection is accounting setup; the system determines debit/credit direction automatically.',
  progress:'Progress',recognitionPeriod:'Recognition period',status:'Status',actions:'Actions',action:'Action',viewSchedule:'View schedule',selected:'Selected',oneItem:'1 adjustment',itemsCount:(n:number)=>n===1?'1 adjustment':`${n} adjustments`,showing:(n:number)=>`Showing ${n} of ${n} adjustments`,scheduleLinked:'The recognition schedule below belongs to the selected adjustment',periodsCount:(n:number)=>`${n} periods`,scheduleAmounts:'Amounts in Saudi riyals',currency:'SAR',progressOf:(a:number,b:number)=>`${a} of ${b} periods posted`,scheduleTotal:'Recognition schedule total',postNote:'Posting is an accounting action for the selected period only; a posted period is never posted again.',posting:'Posting...',saving:'Saving...',posted_done:'Posted',noSchedule:'No recognition schedule yet; it is generated on approval.',selectPrompt:'Select an adjustment to view its recognition schedule.',close:'Close',formTitle:'Add periodic adjustment'
 };
 const types:AdjustmentType[]=['accrued_expense','prepaid_expense','accrued_income','deferred_income'];
 const [items,setItems]=useState<Adjustment[]>([]),[accounts,setAccounts]=useState<Account[]>([]),[documents,setDocuments]=useState<Document[]>([]),[obligations,setObligations]=useState<Obligation[]>([]);
 const [form,setForm]=useState<FormState>(initialForm),[editing,setEditing]=useState<Adjustment|null>(null),[returnReasons,setReturnReasons]=useState<Record<string,string>>({});
 const [loading,setLoading]=useState(canView),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const [quick,setQuick]=useState<'all'|'pending'|'posted'>('all');const resultsRef=useRef<HTMLElement>(null);
 const scheduleRef=useRef<HTMLElement>(null);
 const pickQuick=(next:'all'|'pending'|'posted')=>{
  // Re-applying the active filter is idempotent; only the Total card returns to All.
  const remaining=next==='all'?scopedItems:scopedItems.filter(a=>entriesInScope(a).some(e=>e.status===next));
  const only=remaining.length===1?remaining[0]!:null;
  setQuick(next);setSelectedId(only?only.id:null);
  window.setTimeout(()=>{const el=(only&&scheduleRef.current)||resultsRef.current;el?.scrollIntoView?.({block:'start',behavior:'smooth'});el?.focus({preventScroll:true})},0)};
 const [formOpen,setFormOpen]=useState(false),[selectedId,setSelectedId]=useState<string|null>(null),[busyUrl,setBusyUrl]=useState<string|null>(null);
 const load=async()=>{setLoading(true);setError(false);try{const main=await api('/api/periodic-adjustments',{},onUnauthorized);setItems(((await main.json()) as {adjustments:Adjustment[]}).adjustments);const optional=await Promise.allSettled([api('/api/accounts',{},onUnauthorized),api('/api/documents',{},onUnauthorized),api('/api/obligations',{},onUnauthorized)]);if(optional[0].status==='fulfilled')setAccounts(((await optional[0].value.json()) as {accounts:Account[]}).accounts);if(optional[1].status==='fulfilled')setDocuments(((await optional[1].value.json()) as {documents:Document[]}).documents);if(optional[2].status==='fulfilled')setObligations(((await optional[2].value.json()) as {obligations:Obligation[]}).obligations);}catch{setError(true)}finally{setLoading(false)}};
 useEffect(()=>{if(canView)void load();// eslint-disable-next-line react-hooks/exhaustive-deps
 },[canView]);
 // A global fiscal-year/month change replaces any drill-down range carried in the URL, so the topbar always wins.
 const scopeKey=`${periodMode}|${selectedFiscalYearId}|${selectedPeriodId}`;const previousScope=useRef(scopeKey);const [,setScopeVersion]=useState(0);
 useEffect(()=>{if(previousScope.current!==scopeKey){previousScope.current=scopeKey;clearQueryParameters(['adjustmentFrom','adjustmentTo'],'replace');setSelectedId(null);setScopeVersion(v=>v+1)}},[scopeKey]);
 useEffect(()=>{if(editing&&items.find(i=>i.id===editing.id)?.workflow_status!=='draft'){setEditing(null);setForm(initialForm);setFormOpen(false)}},[items,editing]);
 const expected=useMemo(()=>{const balance=form.type==='accrued_expense'||form.type==='deferred_income'?'liability':'asset';const pnl=form.type==='accrued_expense'||form.type==='prepaid_expense'?'expense':'revenue';return{balance,pnl}},[form.type]);
 const balanceAccounts=accounts.filter(a=>a.is_active&&a.account_type===expected.balance),pnlAccounts=accounts.filter(a=>a.is_active&&a.account_type===expected.pnl);
 const reset=()=>{setEditing(null);setForm(initialForm);setFormOpen(false)};
 const edit=(a:Adjustment)=>{setEditing(a);setFormOpen(true);setForm({type:a.adjustment_type,amount:a.total_amount,start:a.recognition_start,end:a.recognition_end,description:a.description,reference:a.reference??'',notes:a.notes??'',balanceAccountId:a.balance_account_id,pnlAccountId:a.pnl_account_id,documentId:a.document_id??'',obligationId:a.obligation_id??''});};
 const payload=()=>({adjustment_type:form.type,total_amount:form.amount,recognition_start:form.start,recognition_end:form.end,description:form.description,reference:form.reference||null,notes:form.notes||null,balance_account_id:form.balanceAccountId,pnl_account_id:form.pnlAccountId,document_id:form.documentId||null,obligation_id:form.obligationId||null});
 const submitForm=async(e:FormEvent)=>{e.preventDefault();setBusy(true);setError(false);try{if(editing)await api(`/api/periodic-adjustments/${editing.id}`,json('PATCH',{...payload(),version:editing.version}),onUnauthorized);else await api('/api/periodic-adjustments',json('POST',payload()),onUnauthorized);reset();await load();}catch{setError(true)}finally{setBusy(false)}};
 const mutate=async(url:string,body?:unknown)=>{setBusy(true);setBusyUrl(url);setError(false);try{await api(url,body===undefined?{method:'POST'}:json('POST',body),onUnauthorized);await load();return true}catch{setError(true);return false}finally{setBusy(false);setBusyUrl(null)}};
 if(!canView)return <section className="panel pa-view"><WorkspaceState>{l.noAccess}</WorkspaceState></section>;
 const closePeriod=readClosePeriod();
 const globalRange=(()=>{if(periodMode==='all'){const year=availableFiscalYears.find(y=>y.id===selectedFiscalYearId);return year?{from:year.start_date.slice(0,10),to:year.end_date.slice(0,10)}:null}const period=availablePeriodsForSelectedYear.find(p=>p.id===selectedPeriodId);return period?{from:period.period_start.slice(0,10),to:period.period_end.slice(0,10)}:null})();
 const overlapsGlobal=(a:Adjustment)=>!globalRange||(a.recognition_start<=globalRange.to&&a.recognition_end>=globalRange.from);
 const scopedItems=closePeriod?items.filter(a=>((a.workflow_status==='draft'||a.workflow_status==='in_review')&&a.recognition_start<=closePeriod.to&&a.recognition_end>=closePeriod.from)||(a.workflow_status==='approved'&&a.schedule.some(entry=>entry.status==='pending'&&entry.recognition_date>=closePeriod.from&&entry.recognition_date<=closePeriod.to))):items.filter(overlapsGlobal);
 const scopeRange=closePeriod??globalRange;
 const entriesInScope=(a:Adjustment)=>scopeRange?a.schedule.filter(e=>e.recognition_date>=scopeRange.from&&e.recognition_date<=scopeRange.to):a.schedule;
 const countEntries=(status:Schedule['status'])=>scopedItems.reduce((sum,a)=>sum+entriesInScope(a).filter(e=>e.status===status).length,0);
 const pending=countEntries('pending'),posted=countEntries('posted');
 const visibleItems=quick==='all'?scopedItems:scopedItems.filter(a=>entriesInScope(a).some(e=>e.status===quick));
 const selected=visibleItems.find(a=>a.id===selectedId)??null;
 const money=(value:string)=>`${(parseFloat(value)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
 const shortRef=(id:string)=>id.length>20?`${id.slice(0,8)}…${id.slice(-8)}`:id;
 const showForm=(canCreate&&formOpen)||(!!editing&&canEdit);
 const scheduleRows=selected?(quick==='all'?selected.schedule:entriesInScope(selected).filter(e=>e.status===quick)):[];
 const scheduleTotal=selected?scheduleRows.reduce((sum,s)=>sum+Math.round((parseFloat(s.amount)||0)*100),0)/100:0;
 const icon=(d:string)=><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d}/></svg>;
 const amountCell=(value:string)=><span className="pa-amount"><small>{l.currency}</small><strong>{money(value)}</strong></span>;
 const formBusy=busy&&busyUrl===null;
 return <section className="panel pa-view" aria-labelledby="periodic-adjustments-title" data-workspace-size="operational">
  <header className="pa-header">
   <div><h2 id="periodic-adjustments-title">{l.title}</h2><p>{l.description}</p></div>
   {canCreate&&!showForm&&<button type="button" className="pa-primary" onClick={()=>setFormOpen(true)}><span aria-hidden="true">+</span> {l.newItem}</button>}
  </header>
  <div className="pa-kpis">
   <button type="button" className={`pa-kpi${quick==='all'?' is-active':''}`} aria-pressed={quick==='all'} onClick={()=>pickQuick('all')}><div><span>{l.total}</span><strong>{scopedItems.length}</strong></div><i aria-hidden="true">{icon('M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z')}</i></button>
   <button type="button" className={`pa-kpi pa-kpi--pending${quick==='pending'?' is-active':''}`} aria-pressed={quick==='pending'} onClick={()=>pickQuick('pending')}><div><span>{l.pendingCount}</span><strong>{pending}</strong></div><i aria-hidden="true">{icon('M12 6v6l4 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z')}</i></button>
   <button type="button" className={`pa-kpi pa-kpi--posted${quick==='posted'?' is-active':''}`} aria-pressed={quick==='posted'} onClick={()=>pickQuick('posted')}><div><span>{l.postedCount}</span><strong>{posted}</strong></div><i aria-hidden="true">{icon('M9 12l2 2 4-4M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z')}</i></button>
  </div>
  {error&&<WorkspaceState tone="error">{l.error}</WorkspaceState>}
  {showForm&&<section className="pa-card pa-form-card" aria-label={editing?l.update:l.newItem}><div className="pa-card__head"><h3>{editing?l.update:l.formTitle}</h3></div><p className="pa-muted">{l.accountHint}</p><form className="pa-form" onSubmit={submitForm}>
   <label>{l.type}<select value={form.type} onChange={e=>setForm({...form,type:e.target.value as AdjustmentType,balanceAccountId:'',pnlAccountId:''})}>{types.map(t=><option key={t} value={t}>{l[t]}</option>)}</select></label>
   <label>{l.amount}<input value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" required/></label>
   <label>{l.start}<input type="date" value={form.start} onChange={e=>setForm({...form,start:e.target.value})} required/></label>
   <label>{l.end}<input type="date" value={form.end} onChange={e=>setForm({...form,end:e.target.value})} required/></label>
   <label className="pa-form__wide">{l.descriptionLabel}<input value={form.description} onChange={e=>setForm({...form,description:e.target.value})} maxLength={500} required/></label>
   <label className="pa-form__wide">{l.reference}<input value={form.reference} onChange={e=>setForm({...form,reference:e.target.value})} maxLength={200}/></label>
   <label>{l.balanceAccount}<select value={form.balanceAccountId} onChange={e=>setForm({...form,balanceAccountId:e.target.value})} required><option value="">—</option>{balanceAccounts.map(a=><option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></label>
   <label>{l.pnlAccount}<select value={form.pnlAccountId} onChange={e=>setForm({...form,pnlAccountId:e.target.value})} required><option value="">—</option>{pnlAccounts.map(a=><option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></label>
   {documents.length>0&&<label>{l.document}<select value={form.documentId} onChange={e=>setForm({...form,documentId:e.target.value})}><option value="">{l.none}</option>{documents.map(d=><option key={d.id} value={d.id}>{d.original_filename}</option>)}</select></label>}
   {obligations.length>0&&<label>{l.obligation}<select value={form.obligationId} onChange={e=>setForm({...form,obligationId:e.target.value})}><option value="">{l.none}</option>{obligations.map(o=><option key={o.id} value={o.id}>{o.counterparty_name??o.id} — {o.original_amount}</option>)}</select></label>}
   <label className="pa-form__wide">{l.notes}<textarea value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} maxLength={1000}/></label>
   <div className="pa-form__actions"><button className="pa-primary" disabled={busy} type="submit">{formBusy?l.saving:editing?l.update:l.save}</button><button type="button" className="pa-ghost" disabled={busy} onClick={reset}>{editing?l.cancel:l.close}</button></div>
  </form></section>}
  <section className="pa-card pa-results" ref={resultsRef} tabIndex={-1} aria-labelledby="pa-items-title">
   <div className="pa-card__head"><h3 id="pa-items-title">{l.items}</h3><span className="pa-muted">{l.itemsCount(visibleItems.length)}</span></div>
   {loading?<WorkspaceState>{l.loading}</WorkspaceState>:visibleItems.length===0?<WorkspaceState kind="empty">{l.empty}</WorkspaceState>:<>
   <div className="table-wrap pa-table"><table><thead><tr><th>{l.type}</th><th>{l.descriptionLabel}</th><th>{l.amount}</th><th>{l.recognitionPeriod}</th><th>{l.progress}</th><th>{l.status}</th><th>{l.actions}</th></tr></thead><tbody>{visibleItems.map(a=>{const done=a.schedule.filter(s=>s.status==='posted').length;const isSel=selected?.id===a.id;return <tr key={a.id} className={isSel?'is-selected':undefined} aria-selected={isSel}>
    <td data-label={l.type}>{l[a.adjustment_type]}</td>
    <td data-label={l.descriptionLabel}><strong>{a.description}</strong>{a.document_name&&<small>{a.document_name}</small>}</td>
    <td data-label={l.amount}>{amountCell(a.total_amount)}</td>
    <td data-label={l.recognitionPeriod}><span className="pa-dates"><span>{formatDisplayDate(a.recognition_start,i18n.language)}</span><span>{formatDisplayDate(a.recognition_end,i18n.language)}</span></span></td>
    <td data-label={l.progress}>{a.schedule.length?<span className="pa-progress"><span>{l.progressOf(done,a.schedule.length)}</span><i><b style={{width:`${Math.round(done/a.schedule.length*100)}%`}}/></i></span>:'—'}</td>
    <td data-label={l.status}><StatusBadge status={a.workflow_status}>{l[a.workflow_status]}</StatusBadge></td>
    <td data-label={l.actions}><div className="pa-actions"><button type="button" className="pa-ghost" aria-pressed={isSel} onClick={()=>setSelectedId(a.id)}>{l.viewSchedule}</button>{canEdit&&a.workflow_status==='draft'&&<button type="button" className="pa-ghost" disabled={busy} onClick={()=>edit(a)}>{l.update}</button>}{canSubmit&&a.workflow_status==='draft'&&<button type="button" className="pa-ghost" disabled={busy} onClick={()=>void mutate(`/api/periodic-adjustments/${a.id}/submit-review`)}>{l.submit}</button>}{canApprove&&a.workflow_status==='in_review'&&<button type="button" className="pa-primary" disabled={busy} onClick={()=>void mutate(`/api/periodic-adjustments/${a.id}/approve`)}>{l.approve}</button>}</div>{canReview&&a.workflow_status==='in_review'&&<div className="pa-return"><textarea aria-label={l.returnReason} placeholder={l.returnReason} value={returnReasons[a.id]??''} onChange={e=>setReturnReasons({...returnReasons,[a.id]:e.target.value})}/><button type="button" className="pa-ghost" disabled={busy||!(returnReasons[a.id]??'').trim()} onClick={()=>void mutate(`/api/periodic-adjustments/${a.id}/return-to-draft`,{reason:(returnReasons[a.id]??'').trim()})}>{l.returnDraft}</button></div>}</td>
   </tr>})}</tbody></table></div>
   <div className="pa-foot"><span>{l.showing(visibleItems.length)}</span><span>{selected?l.scheduleLinked:l.selectPrompt}</span></div></>}
  </section>
  {!loading&&selected&&<section className="pa-card pa-results" ref={scheduleRef} tabIndex={-1} aria-labelledby="pa-schedule-title">
   <div className="pa-card__head"><div><h3 id="pa-schedule-title">{l.schedule}</h3><p className="pa-muted">{l[selected.adjustment_type]} — {selected.description}</p></div><span className="pa-muted">{scheduleRows.length?`${l.periodsCount(scheduleRows.length)} • ${l.scheduleAmounts}`:''}</span></div>
   {selected.schedule.length===0?<WorkspaceState kind="empty">{l.noSchedule}</WorkspaceState>:<>
   <div className="table-wrap pa-table"><table><thead><tr><th>{l.period}</th><th>{l.recognitionDate}</th><th>{l.amount}</th><th>{l.status}</th><th>{l.journal}</th><th>{l.action}</th></tr></thead><tbody>{scheduleRows.map(s=><tr key={s.id} className={s.status==='posted'?'is-posted':undefined}>
    <td data-label={l.period}><span className="pa-range"><span>{formatDisplayDate(s.period_start,i18n.language)}</span><span aria-hidden="true">–</span><span>{formatDisplayDate(s.period_end,i18n.language)}</span></span></td>
    <td data-label={l.recognitionDate}>{formatDisplayDate(s.recognition_date,i18n.language)}</td>
    <td data-label={l.amount}>{amountCell(s.amount)}</td>
    <td data-label={l.status}><StatusBadge status={s.status}>{l[s.status]}</StatusBadge></td>
    <td data-label={l.journal}>{s.journal_entry_id?<code className="pa-ref" title={s.journal_entry_id}>{shortRef(s.journal_entry_id)}</code>:'—'}</td>
    <td data-label={l.action}>{canPost&&s.status==='pending'?<button type="button" className="pa-primary" disabled={busy} onClick={()=>void mutate(`/api/periodic-adjustments/${selected.id}/schedule/${s.id}/post`)}>{busyUrl===`/api/periodic-adjustments/${selected.id}/schedule/${s.id}/post`?l.posting:l.post}</button>:s.status==='posted'?<span className="pa-done">✓ {l.posted_done}</span>:null}</td>
   </tr>)}</tbody></table></div>
   <div className="pa-total"><strong>{l.scheduleTotal} • {l.periodsCount(scheduleRows.length)}</strong>{amountCell(scheduleTotal.toFixed(2))}</div>
   <p className="pa-note">{l.postNote}</p></>}
  </section>}
 </section>;
}
