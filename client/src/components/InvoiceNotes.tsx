import {FormEvent,useCallback,useEffect,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {formatDisplayDate} from '../date-format';
import { formatMoney } from '../money-format';

/**
 * External credit / debit notes registered against one approved invoice. EQFAL registers notes issued elsewhere; it never issues them.
 * Amounts, VAT, period rules and caps are decided by the server; this only collects raw inputs and shows the stored result.
 */
type Note={id:string;adjustment_type:'credit'|'debit';status:'draft'|'approved'|'cancelled';adjustment_date:string;external_number:string;reason:string;subtotal_amount:string;vat_amount:string;total_amount:string;version:number;journal_id:string|null;journal_status:string|null};
type FormLine={description:string;vat_treatment:string;vat_rate:string;net_amount:string;vat_recoverability:string;vat_recoverable_percent:string};
type Form={adjustment_type:'credit'|'debit';external_number:string;adjustment_date:string;reason:string;lines:FormLine[]};
const TREATMENTS=['standard','zero_rated','exempt','out_of_scope'] as const;
const emptyLine=():FormLine=>({description:'',vat_treatment:'standard',vat_rate:'15',net_amount:'',vat_recoverability:'',vat_recoverable_percent:''});
const emptyForm=():Form=>({adjustment_type:'credit',external_number:'',adjustment_date:'',reason:'',lines:[emptyLine()]});
const toPayload=(f:Form,purchase:boolean)=>({adjustment_type:f.adjustment_type,external_number:f.external_number.trim(),adjustment_date:f.adjustment_date,reason:f.reason.trim(),lines:f.lines.map(l=>({description:l.description.trim(),vat_treatment:l.vat_treatment,vat_rate:l.vat_treatment==='standard'?l.vat_rate:'0',net_amount:l.net_amount,...(purchase&&l.vat_treatment==='standard'?{vat_recoverability:l.vat_recoverability,...(l.vat_recoverability==='partially_recoverable'?{vat_recoverable_percent:l.vat_recoverable_percent}:{})}:{})}))});

export function InvoiceNotes({invoiceId,purchase,currency,canAdjust,canApprove,onChanged,onUnauthorized}:{invoiceId:string;purchase:boolean;currency:string;canAdjust:boolean;canApprove:boolean;onChanged:()=>void;onUnauthorized:()=>void}){
 const{t}=useTranslation();
 const[notes,setNotes]=useState<Note[]|null>(null),[loadError,setLoadError]=useState(false),[form,setForm]=useState<Form|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[cancelling,setCancelling]=useState<{id:string;reason:string}|null>(null);
 const money=(v:string)=>formatMoney(v,'0.00');
 const errorText=(code?:string)=>{const key=`invoiceNotes.errors.${code}`;const text=t(key);return code&&text!==key?text:t('invoiceNotes.errors.generic')};
 const load=useCallback(async()=>{
  try{const response=await fetch(`/api/invoices/${invoiceId}/adjustments`);if(response.status===401){onUnauthorized();return;}if(!response.ok)throw new Error();const payload=await response.json() as {adjustments:Note[]};setNotes(payload.adjustments);setLoadError(false);}catch{setLoadError(true);}
 },[invoiceId,onUnauthorized]);
 useEffect(()=>{void load()},[load]);
 const send=async(url:string,method:'POST'|'PUT',body:unknown):Promise<boolean>=>{
  setBusy(true);setError(null);
  try{
   const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   if(response.status===401){onUnauthorized();return false;}
   if(!response.ok){const payload=await response.json().catch(()=>({})) as {code?:string};setError(errorText(payload.code));return false;}
   await load();onChanged();return true;
  }catch{setError(errorText(undefined));return false;}finally{setBusy(false);}
 };
 const submit=async(event:FormEvent)=>{event.preventDefault();if(!form)return;if(await send(`/api/invoices/${invoiceId}/adjustments`,'POST',toPayload(form,purchase)))setForm(null);};
 const setLine=(i:number,patch:Partial<FormLine>)=>setForm(f=>f&&{...f,lines:f.lines.map((l,x)=>x===i?{...l,...patch}:l)});
 return <section className="sales-invoices__finance" aria-label={t('invoiceNotes.title')} data-testid="invoice-notes"><h4>{t('invoiceNotes.title')}</h4>
  <p className="sales-invoices__hint">{t('invoiceNotes.hint')}</p>
  {loadError&&<p className="sales-invoices__error">{t('invoiceNotes.loadError')}</p>}
  {notes&&notes.length===0&&<p className="sales-invoices__hint">{t('invoiceNotes.empty')}</p>}
  {notes&&notes.length>0&&<ul className="sales-invoices__settlements" data-testid="invoice-notes-list">{notes.map(n=><li key={n.id}>
   <span>{t(`invoiceWorkspace.adjustmentTypes.${n.adjustment_type}`)} {n.external_number} | {t(`invoiceWorkspace.adjustmentStatuses.${n.status}`)}</span>
   <span>{formatDisplayDate(n.adjustment_date,'en')} | {n.reason}</span>
   <strong>{money(n.total_amount)} {currency}</strong>
   {n.status==='draft'&&<span className="modal-actions">
    {canApprove&&<button type="button" disabled={busy} onClick={()=>void send(`/api/invoice-adjustments/${n.id}/approve`,'POST',{version:n.version})}>{t('invoiceNotes.approve')}</button>}
    {canAdjust&&<button type="button" disabled={busy} onClick={()=>setCancelling({id:n.id,reason:''})}>{t('invoiceNotes.cancel')}</button>}
   </span>}
   {n.status==='approved'&&n.journal_status&&<span>{t('invoiceNotes.journal',{status:t(`invoiceWorkspace.journalStatuses.${n.journal_status}`)})}</span>}
  </li>)}</ul>}
  {error&&<p role="alert" className="sales-invoices__error">{error}</p>}
  {cancelling&&<div className="sales-invoices__confirm" role="group" aria-label={t('invoiceNotes.cancelTitle')}><p><strong>{t('invoiceNotes.cancelTitle')}</strong></p>
   <label>{t('invoiceNotes.cancelReason')}<textarea value={cancelling.reason} maxLength={500} onChange={e=>setCancelling({...cancelling,reason:e.target.value})}/></label>
   <div className="modal-actions"><button type="button" disabled={busy} onClick={()=>setCancelling(null)}>{t('common.cancel')}</button>
    <button type="button" className="primary" disabled={busy||cancelling.reason.trim()===''} onClick={()=>{const n=notes?.find(x=>x.id===cancelling.id);if(n)void send(`/api/invoice-adjustments/${n.id}/cancel`,'POST',{version:n.version,reason:cancelling.reason.trim()}).then(ok=>{if(ok)setCancelling(null)})}}>{t('invoiceNotes.confirmCancel')}</button></div></div>}
  {canAdjust&&!form&&<button type="button" onClick={()=>{setError(null);setForm(emptyForm())}} disabled={busy}>{t('invoiceNotes.register')}</button>}
  {canAdjust&&form&&<form className="sales-invoices__form" onSubmit={e=>void submit(e)}>
   <div className="sales-invoices__row">
    <label>{t('invoiceNotes.type')}<select value={form.adjustment_type} onChange={e=>setForm({...form,adjustment_type:e.target.value as 'credit'|'debit'})}><option value="credit">{t('invoiceWorkspace.adjustmentTypes.credit')}</option><option value="debit">{t('invoiceWorkspace.adjustmentTypes.debit')}</option></select></label>
    <label>{t('invoiceNotes.externalNumber')}<input required maxLength={100} dir="ltr" value={form.external_number} onChange={e=>setForm({...form,external_number:e.target.value})}/></label>
    <label>{t('invoiceNotes.date')}<input required type="date" value={form.adjustment_date} onChange={e=>setForm({...form,adjustment_date:e.target.value})}/></label>
   </div>
   <label>{t('invoiceNotes.reason')}<input required maxLength={500} value={form.reason} onChange={e=>setForm({...form,reason:e.target.value})}/></label>
   <fieldset><legend>{t('salesInvoice.lines')}</legend>{form.lines.map((l,i)=><div className="sales-invoices__line" key={i} role="group" aria-label={t('salesInvoice.lineN',{n:i+1})}>
    <label>{t('salesInvoice.description')}<input required maxLength={500} value={l.description} onChange={e=>setLine(i,{description:e.target.value})}/></label>
    <label>{t('salesInvoice.vatTreatment')}<select value={l.vat_treatment} onChange={e=>setLine(i,{vat_treatment:e.target.value,...(e.target.value!=='standard'?{vat_recoverability:'',vat_recoverable_percent:''}:{})})}>{TREATMENTS.map(x=><option key={x} value={x}>{t(`salesInvoice.treatments.${x}`)}</option>)}</select></label>
    {l.vat_treatment==='standard'&&<label>{t('salesInvoice.vatRate')}<input required inputMode="decimal" dir="ltr" value={l.vat_rate} onChange={e=>setLine(i,{vat_rate:e.target.value})}/></label>}
    <label>{t('invoiceNotes.net')}<input required inputMode="decimal" dir="ltr" value={l.net_amount} onChange={e=>setLine(i,{net_amount:e.target.value})}/></label>
    {purchase&&l.vat_treatment==='standard'&&<><label>{t('purchaseInvoice.recoverability')}<select required value={l.vat_recoverability} onChange={e=>setLine(i,{vat_recoverability:e.target.value,...(e.target.value!=='partially_recoverable'?{vat_recoverable_percent:''}:{})})}><option value="">{t('purchaseInvoice.chooseRecoverability')}</option>{['fully_recoverable','partially_recoverable','non_recoverable'].map(x=><option key={x} value={x}>{t(`purchaseInvoice.recoverabilities.${x}`)}</option>)}</select></label>
     {l.vat_recoverability==='partially_recoverable'&&<label>{t('purchaseInvoice.recoverablePercent')}<input required inputMode="decimal" dir="ltr" value={l.vat_recoverable_percent} onChange={e=>setLine(i,{vat_recoverable_percent:e.target.value})}/></label>}</>}
    {form.lines.length>1&&<button type="button" onClick={()=>setForm({...form,lines:form.lines.filter((_,x)=>x!==i)})}>{t('salesInvoice.removeLine')}</button>}
   </div>)}<button type="button" onClick={()=>setForm({...form,lines:[...form.lines,emptyLine()]})}>{t('salesInvoice.addLine')}</button></fieldset>
   <p className="sales-invoices__hint">{t('invoiceNotes.serverComputes')}</p>
   <div className="modal-actions"><button type="button" onClick={()=>setForm(null)} disabled={busy}>{t('common.cancel')}</button><button type="submit" className="primary" disabled={busy}>{t('invoiceNotes.save')}</button></div>
  </form>}
 </section>;
}
