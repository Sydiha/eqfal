import {FormEvent,useCallback,useEffect,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Dialog} from './Dialog';
import {formatDisplayDate} from '../date-format';
import './RecurringInvoices.css';
import { formatMoney } from '../money-format';

/**
 * Recurring invoice schedules inside the invoice workspace. A schedule only ever produces DRAFT invoices: nothing here submits, approves,
 * posts, settles or sends. Dates, amounts, VAT and every rule are decided by the server; this component collects raw inputs and shows stored results.
 */
type Line={description:string;quantity:string;unit_price:string;discount_amount:string;vat_rate:string;vat_treatment:string;vat_recoverability:string;vat_recoverable_percent:string};
type Template={id:string;direction:'sales'|'purchase';name:string;counterparty_id:string;counterparty_name:string;frequency:'monthly'|'quarterly'|'annual';start_date:string;end_date:string|null;next_run_date:string;status:'active'|'paused'|'ended';due_days:number|null;notes:string|null;last_generated_for:string|null;last_error_code:string|null;version:number;
 lines?:Array<Record<string,string|null>>;generated_invoices?:Array<{id:string;internal_number:string|null;status:string;occurrence_date:string;total_amount:string}>};
type Form={id:string|null;version:number|null;locked:boolean;name:string;counterparty_id:string;frequency:string;start_date:string;end_date:string;due_days:string;notes:string;lines:Line[]};
type Party={id:string;name:string};
const TREATMENTS=['standard','zero_rated','exempt','out_of_scope'] as const;
const FREQUENCIES=['monthly','quarterly','annual'] as const;
const emptyLine=():Line=>({description:'',quantity:'1',unit_price:'',discount_amount:'',vat_rate:'',vat_treatment:'standard',vat_recoverability:'',vat_recoverable_percent:''});
const emptyForm=():Form=>({id:null,version:null,locked:false,name:'',counterparty_id:'',frequency:'monthly',start_date:'',end_date:'',due_days:'',notes:'',lines:[emptyLine()]});
const fromTemplate=(x:Template):Form=>({id:x.id,version:x.version,locked:x.last_generated_for!==null,name:x.name,counterparty_id:x.counterparty_id,frequency:x.frequency,start_date:x.start_date,end_date:x.end_date??'',due_days:x.due_days==null?'':String(x.due_days),notes:x.notes??'',
 lines:(x.lines??[]).map(l=>({description:l.description??'',quantity:l.quantity??'1',unit_price:l.unit_price??'',discount_amount:l.discount_amount&&Number(l.discount_amount)!==0?l.discount_amount:'',vat_rate:l.vat_rate??'',vat_treatment:l.vat_treatment??'standard',vat_recoverability:l.vat_recoverability??'',vat_recoverable_percent:l.vat_recoverable_percent??''}))});
const toPayload=(f:Form,purchase:boolean)=>({name:f.name.trim(),counterparty_id:f.counterparty_id,frequency:f.frequency,start_date:f.start_date,end_date:f.end_date||null,due_days:f.due_days.trim()===''?null:Number(f.due_days),notes:f.notes.trim()||null,
 lines:f.lines.map(l=>({description:l.description,quantity:l.quantity,unit_price:l.unit_price,...(l.discount_amount.trim()?{discount_amount:l.discount_amount}:{}),vat_rate:l.vat_treatment==='standard'?l.vat_rate:'0',vat_treatment:l.vat_treatment,
  ...(purchase&&l.vat_treatment==='standard'&&l.vat_recoverability?{vat_recoverability:l.vat_recoverability,...(l.vat_recoverability==='partially_recoverable'?{vat_recoverable_percent:l.vat_recoverable_percent}:{})}:{})}))});

export function RecurringInvoices({direction,canManage,canGenerate,onChanged,onUnauthorized}:{direction:'sales'|'purchase';canManage:boolean;canGenerate:boolean;onChanged:()=>void;onUnauthorized:()=>void}){
 const{t}=useTranslation();
 const purchase=direction==='purchase';
 const[list,setList]=useState<Template[]|null>(null),[loadError,setLoadError]=useState(false),[detail,setDetail]=useState<Template|null>(null),[form,setForm]=useState<Form|null>(null),[parties,setParties]=useState<Party[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[confirmEnd,setConfirmEnd]=useState(false),[stdRate,setStdRate]=useState<string|null>(null);
 const errorText=(code?:string)=>{const key=`recurringInvoice.errors.${code}`;const text=t(key);if(code&&text!==key)return text;const shared=t(`salesInvoice.errors.${code}`);return code&&shared!==`salesInvoice.errors.${code}`?shared:t('recurringInvoice.errors.generic')};
 const call=useCallback(async(url:string,method:'GET'|'POST'|'PUT',body?:unknown)=>{
  const response=await fetch(url,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.status===401){onUnauthorized();throw new Error('unauthorized');}
  const payload=await response.json().catch(()=>({})) as Record<string,any>;
  return{ok:response.ok,payload};
 },[onUnauthorized]);
 const load=useCallback(async()=>{
  try{const r=await call(`/api/recurring-invoices?direction=${direction}`,'GET');if(!r.ok)throw new Error();if(!Array.isArray(r.payload.templates))throw new Error();setList(r.payload.templates as Template[]);setLoadError(false);}catch{setLoadError(true);}
 },[call,direction]);
 useEffect(()=>{void load()},[load]);
 useEffect(()=>{if(!canManage)return;void call(`/api/invoices/customers?direction=${direction}`,'GET').then(r=>{if(r.ok)setParties(((purchase?r.payload.suppliers:r.payload.customers)??[]) as Party[])}).catch(()=>undefined)},[call,canManage,direction,purchase]);
 // Sales only: show the standard VAT rate effective on the start date as a convenience. The server re-checks the rate at every generation.
 const startDate=form?.start_date??'';
 useEffect(()=>{setStdRate(null);if(purchase||!/^\d{4}-\d{2}-\d{2}$/.test(startDate))return;let cancelled=false;void call(`/api/invoices/standard-rate?date=${startDate}`,'GET').then(r=>{if(!cancelled&&r.ok)setStdRate(String(r.payload.rate))}).catch(()=>undefined);return()=>{cancelled=true}},[call,purchase,startDate]);
 const act=async(url:string,method:'POST'|'PUT',body:unknown):Promise<Record<string,any>|null>=>{
  setBusy(true);setError(null);setNotice(null);
  try{const r=await call(url,method,body);if(!r.ok){setError(errorText(r.payload.code as string|undefined));return null;}await load();return r.payload;}
  catch{setError(errorText(undefined));return null;}finally{setBusy(false);}
 };
 const openDetail=async(id:string)=>{setError(null);setConfirmEnd(false);try{const r=await call(`/api/recurring-invoices/${id}`,'GET');if(r.ok)setDetail(r.payload.template as Template);else setError(errorText(r.payload.code as string|undefined));}catch{setError(errorText(undefined));}};
 const save=async(event:FormEvent)=>{
  event.preventDefault();if(!form)return;
  const body=toPayload(form,purchase);
  const payload=form.id?await act(`/api/recurring-invoices/${form.id}`,'PUT',{...body,version:form.version}):await act('/api/recurring-invoices','POST',{direction,...body});
  if(payload){setForm(null);setDetail(null);}
 };
 const transition=async(x:Template,action:'pause'|'resume'|'end')=>{const payload=await act(`/api/recurring-invoices/${x.id}/${action}`,'POST',{version:x.version});if(payload){setDetail(payload.template as Template);setConfirmEnd(false);await openDetail(x.id);}};
 const generate=async()=>{
  const payload=await act('/api/recurring-invoices/run-due','POST',{});
  if(!payload)return;
  const results=payload.results as Array<{generated:unknown[];error_code:string|null}>;
  const created=results.reduce((n,r)=>n+r.generated.length,0);const failed=results.filter(r=>r.error_code).length;
  setNotice(t('recurringInvoice.runResult',{created,failed}));
  if(created>0)onChanged();
 };
 const setLine=(i:number,patch:Partial<Line>)=>setForm(f=>f&&{...f,lines:f.lines.map((l,x)=>x===i?{...l,...patch}:l)});
 const money=(v:string|null|undefined)=>formatMoney(v,'0.00');
 const status=(s:string)=><span className={`recurring-invoices__status recurring-invoices__status--${s}`}>{t(`recurringInvoice.statuses.${s}`)}</span>;
 return <section className="recurring-invoices" aria-labelledby={`recurring-${direction}-title`} data-testid="recurring-invoices">
  <div className="recurring-invoices__head"><div><h3 id={`recurring-${direction}-title`}>{t('recurringInvoice.title')}</h3><p className="recurring-invoices__hint">{t('recurringInvoice.draftOnly')}</p></div>
   <span className="modal-actions">{canGenerate&&<button type="button" disabled={busy} onClick={()=>void generate()}>{t('recurringInvoice.generateNow')}</button>}{canManage&&<button type="button" className="primary" disabled={busy} onClick={()=>{setError(null);setNotice(null);setForm(emptyForm())}}>{t('recurringInvoice.add')}</button>}</span></div>
  {loadError&&<p className="recurring-invoices__error">{t('recurringInvoice.loadError')}</p>}
  {notice&&<p role="status" className="recurring-invoices__notice">{notice}</p>}
  {error&&!form&&!detail&&<p role="status" className="recurring-invoices__error">{error}</p>}
  {list&&list.length===0&&<p className="recurring-invoices__hint">{t('recurringInvoice.empty')}</p>}
  {list&&list.length>0&&<div className="recurring-invoices__scroll"><table><thead><tr><th>{t('recurringInvoice.name')}</th><th>{t(purchase?'purchaseInvoice.counterparty':'salesInvoice.counterparty')}</th><th>{t('recurringInvoice.frequency')}</th><th>{t('recurringInvoice.nextRun')}</th><th>{t('recurringInvoice.endDate')}</th><th>{t('salesInvoice.status')}</th></tr></thead>
   <tbody>{list.map(x=><tr key={x.id}><td><button type="button" className="recurring-invoices__link" onClick={()=>void openDetail(x.id)}>{x.name}</button>{x.last_error_code&&<span className="recurring-invoices__error"> ⚠ {t('recurringInvoice.needsAttention')}</span>}</td><td>{x.counterparty_name}</td><td>{t(`recurringInvoice.frequencies.${x.frequency}`)}</td><td>{x.status==='ended'?'—':formatDisplayDate(x.next_run_date,'en')}</td><td>{x.end_date?formatDisplayDate(x.end_date,'en'):'—'}</td><td>{status(x.status)}</td></tr>)}</tbody></table></div>}
  {detail&&!form&&<Dialog size="wide" title={`${t('recurringInvoice.detail')} | ${detail.name}`} busy={busy} onClose={()=>setDetail(null)}>
   <dl className="recurring-invoices__facts"><div><dt>{t(purchase?'purchaseInvoice.counterparty':'salesInvoice.counterparty')}</dt><dd>{detail.counterparty_name}</dd></div><div><dt>{t('salesInvoice.status')}</dt><dd>{status(detail.status)}</dd></div>
    <div><dt>{t('recurringInvoice.frequency')}</dt><dd>{t(`recurringInvoice.frequencies.${detail.frequency}`)}</dd></div><div><dt>{t('recurringInvoice.startDate')}</dt><dd>{formatDisplayDate(detail.start_date,'en')}</dd></div>
    <div><dt>{t('recurringInvoice.endDate')}</dt><dd>{detail.end_date?formatDisplayDate(detail.end_date,'en'):'—'}</dd></div><div><dt>{t('recurringInvoice.nextRun')}</dt><dd>{detail.status==='ended'?'—':formatDisplayDate(detail.next_run_date,'en')}</dd></div>
    <div><dt>{t('recurringInvoice.dueDays')}</dt><dd>{detail.due_days==null?'—':detail.due_days}</dd></div></dl>
   {detail.last_error_code&&<p role="alert" className="recurring-invoices__error">{t('recurringInvoice.lastError',{reason:errorText(detail.last_error_code)})}</p>}
   <div className="recurring-invoices__scroll"><table><thead><tr>{['description','quantity','unitPrice','vatTreatment','vatRate'].map(k=><th key={k}>{t(`salesInvoice.${k}`)}</th>)}</tr></thead><tbody>{(detail.lines??[]).map((l,i)=><tr key={i}><td>{l.description}</td><td>{l.quantity}</td><td>{money(l.unit_price)}</td><td>{l.vat_treatment?t(`salesInvoice.treatments.${l.vat_treatment}`):'—'}</td><td>{l.vat_rate}%</td></tr>)}</tbody></table></div>
   <h4>{t('recurringInvoice.generated')}</h4>
   {(detail.generated_invoices?.length??0)===0?<p className="recurring-invoices__hint">{t('recurringInvoice.noneGenerated')}</p>
    :<ul className="recurring-invoices__generated" data-testid="recurring-generated">{detail.generated_invoices!.map(g=><li key={g.id}><span>{formatDisplayDate(g.occurrence_date,'en')}</span><span>{t(`salesInvoice.statuses.${g.status}`)}</span><strong>{money(g.total_amount)}</strong></li>)}</ul>}
   {error&&<p role="alert" className="recurring-invoices__error">{error}</p>}
   {canManage&&detail.status!=='ended'&&(confirmEnd?<div className="recurring-invoices__confirm" role="group" aria-label={t('recurringInvoice.endTitle')}><p><strong>{t('recurringInvoice.endTitle')}</strong></p><p>{t('recurringInvoice.endBody')}</p>
     <div className="modal-actions"><button type="button" disabled={busy} onClick={()=>setConfirmEnd(false)}>{t('common.cancel')}</button><button type="button" className="primary" disabled={busy} onClick={()=>void transition(detail,'end')}>{t('recurringInvoice.confirmEnd')}</button></div></div>
    :<div className="modal-actions"><button type="button" disabled={busy} onClick={()=>{setError(null);setForm(fromTemplate(detail))}}>{t('recurringInvoice.edit')}</button>
      {detail.status==='active'?<button type="button" disabled={busy} onClick={()=>void transition(detail,'pause')}>{t('recurringInvoice.pause')}</button>:<button type="button" disabled={busy} onClick={()=>void transition(detail,'resume')}>{t('recurringInvoice.resume')}</button>}
      <button type="button" disabled={busy} onClick={()=>setConfirmEnd(true)}>{t('recurringInvoice.end')}</button></div>)}
   {detail.status==='paused'&&<p className="recurring-invoices__hint">{t('recurringInvoice.resumeNote')}</p>}
  </Dialog>}
  {form&&<Dialog size="wide" title={form.id?t('recurringInvoice.editTitle'):t('recurringInvoice.newTitle')} busy={busy} onClose={()=>setForm(null)}>
   <form className="recurring-invoices__form" onSubmit={e=>void save(e)}>
    <label>{t('recurringInvoice.name')}<input required maxLength={200} value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label>
    <label>{t(purchase?'purchaseInvoice.counterparty':'salesInvoice.counterparty')}<select required value={form.counterparty_id} onChange={e=>setForm({...form,counterparty_id:e.target.value})}><option value="">{t(purchase?'purchaseInvoice.chooseCounterparty':'salesInvoice.chooseCounterparty')}</option>{parties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <div className="recurring-invoices__row">
     <label>{t('recurringInvoice.frequency')}<select disabled={form.locked} value={form.frequency} onChange={e=>setForm({...form,frequency:e.target.value})}>{FREQUENCIES.map(f=><option key={f} value={f}>{t(`recurringInvoice.frequencies.${f}`)}</option>)}</select></label>
     <label>{t('recurringInvoice.startDate')}<input type="date" required disabled={form.locked} value={form.start_date} onChange={e=>setForm({...form,start_date:e.target.value})}/></label>
     <label>{t('recurringInvoice.endDateOptional')}<input type="date" value={form.end_date} min={form.start_date||undefined} onChange={e=>setForm({...form,end_date:e.target.value})}/></label>
     <label>{t('recurringInvoice.dueDays')}<input inputMode="numeric" dir="ltr" maxLength={3} value={form.due_days} onChange={e=>setForm({...form,due_days:e.target.value.replace(/\D/g,'')})}/></label>
    </div>
    {form.locked&&<p className="recurring-invoices__hint">{t('recurringInvoice.scheduleLocked')}</p>}
    <p className="recurring-invoices__hint">{t('recurringInvoice.monthEndNote')}</p>
    <fieldset><legend>{t('salesInvoice.lines')}</legend>{form.lines.map((l,i)=><div className="recurring-invoices__line" key={i} role="group" aria-label={t('salesInvoice.lineN',{n:i+1})}>
     <label>{t('salesInvoice.description')}<input required maxLength={500} value={l.description} onChange={e=>setLine(i,{description:e.target.value})}/></label>
     <label>{t('salesInvoice.quantity')}<input required inputMode="decimal" dir="ltr" value={l.quantity} onChange={e=>setLine(i,{quantity:e.target.value})}/></label>
     <label>{t('salesInvoice.unitPrice')}<input required inputMode="decimal" dir="ltr" value={l.unit_price} onChange={e=>setLine(i,{unit_price:e.target.value})}/></label>
     <label>{t('salesInvoice.discount')}<input inputMode="decimal" dir="ltr" value={l.discount_amount} onChange={e=>setLine(i,{discount_amount:e.target.value})}/></label>
     <label>{t('salesInvoice.vatTreatment')}<select value={l.vat_treatment} onChange={e=>setLine(i,{vat_treatment:e.target.value,...(e.target.value==='standard'&&!purchase&&!l.vat_rate&&stdRate?{vat_rate:stdRate}:{}),...(e.target.value!=='standard'?{vat_recoverability:'',vat_recoverable_percent:''}:{})})}>{TREATMENTS.map(x=><option key={x} value={x}>{t(`salesInvoice.treatments.${x}`)}</option>)}</select></label>
     {l.vat_treatment==='standard'&&<label>{t('salesInvoice.vatRate')}<input required inputMode="decimal" dir="ltr" value={l.vat_rate} placeholder={stdRate??undefined} onChange={e=>setLine(i,{vat_rate:e.target.value})}/></label>}
     {purchase&&l.vat_treatment==='standard'&&<><label>{t('purchaseInvoice.recoverability')}<select required value={l.vat_recoverability} onChange={e=>setLine(i,{vat_recoverability:e.target.value,...(e.target.value!=='partially_recoverable'?{vat_recoverable_percent:''}:{})})}><option value="">{t('purchaseInvoice.chooseRecoverability')}</option>{['fully_recoverable','partially_recoverable','non_recoverable'].map(x=><option key={x} value={x}>{t(`purchaseInvoice.recoverabilities.${x}`)}</option>)}</select></label>
      {l.vat_recoverability==='partially_recoverable'&&<label>{t('purchaseInvoice.recoverablePercent')}<input required inputMode="decimal" dir="ltr" value={l.vat_recoverable_percent} onChange={e=>setLine(i,{vat_recoverable_percent:e.target.value})}/></label>}</>}
     {form.lines.length>1&&<button type="button" onClick={()=>setForm({...form,lines:form.lines.filter((_,x)=>x!==i)})}>{t('salesInvoice.removeLine')}</button>}
    </div>)}<button type="button" onClick={()=>setForm({...form,lines:[...form.lines,emptyLine()]})}>{t('salesInvoice.addLine')}</button></fieldset>
    {!purchase&&<p className="recurring-invoices__hint">{stdRate?t('recurringInvoice.rateHint',{rate:stdRate}):t('recurringInvoice.rateHintNone')}</p>}
    <p className="recurring-invoices__hint">{t('recurringInvoice.serverComputes')}</p>
    <label>{t('salesInvoice.notes')}<textarea maxLength={2000} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></label>
    {error&&<p role="alert" className="recurring-invoices__error">{error}</p>}
    <div className="modal-actions"><button type="button" onClick={()=>setForm(null)} disabled={busy}>{t('common.cancel')}</button><button type="submit" className="primary" disabled={busy}>{t('recurringInvoice.save')}</button></div>
   </form>
  </Dialog>}
 </section>;
}
