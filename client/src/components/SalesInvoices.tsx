import {FormEvent,useCallback,useEffect,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Dialog} from './Dialog';
import {formatDisplayDate} from '../date-format';
import './SalesInvoices.css';

export type SalesInvoiceCapabilities={canView:boolean;canCreate:boolean;canEdit:boolean;canSubmit:boolean};
type Line={line_number?:number;description:string;quantity:string;unit_price:string;discount_amount:string;vat_rate:string;net_amount?:string;vat_amount?:string;total_amount?:string;vat_treatment:string|null};
type Invoice={id:string;status:'draft'|'submitted'|'approved'|'cancelled';counterparty_id:string;counterparty_name:string;internal_number:string|null;external_reference:string|null;issue_date:string;due_date:string|null;supply_date:string|null;tax_point_date:string|null;currency:string;subtotal_amount:string;vat_amount:string;total_amount:string;notes:string|null;version:number;lines?:Line[]};
type Counterparty={id:string;name:string;type:string};
type FormLine={description:string;quantity:string;unit_price:string;discount_amount:string;vat_rate:string;vat_treatment:string};
type FormValues={counterparty_id:string;issue_date:string;due_date:string;supply_date:string;tax_point_date:string;external_reference:string;notes:string;lines:FormLine[]};
const TREATMENTS=['standard','zero_rated','exempt','out_of_scope'] as const;
const emptyLine=():FormLine=>({description:'',quantity:'1',unit_price:'',discount_amount:'',vat_rate:'',vat_treatment:''});
const emptyForm=():FormValues=>({counterparty_id:'',issue_date:'',due_date:'',supply_date:'',tax_point_date:'',external_reference:'',notes:'',lines:[emptyLine()]});
const fromInvoice=(i:Invoice):FormValues=>({counterparty_id:i.counterparty_id,issue_date:i.issue_date,due_date:i.due_date??'',supply_date:i.supply_date??'',tax_point_date:i.tax_point_date??'',external_reference:i.external_reference??'',notes:i.notes??'',lines:(i.lines??[]).map(l=>({description:l.description,quantity:l.quantity,unit_price:l.unit_price,discount_amount:l.discount_amount==='0.00'?'':l.discount_amount,vat_rate:l.vat_rate,vat_treatment:l.vat_treatment??''}))});
// Amounts are always computed by the server; the client only sends the raw inputs as strings.
const toPayload=(v:FormValues)=>({counterparty_id:v.counterparty_id,issue_date:v.issue_date,due_date:v.due_date||null,supply_date:v.supply_date||null,tax_point_date:v.tax_point_date||null,external_reference:v.external_reference.trim()||null,notes:v.notes.trim()||null,lines:v.lines.map(l=>({description:l.description,quantity:l.quantity,unit_price:l.unit_price,...(l.discount_amount?{discount_amount:l.discount_amount}:{}),vat_rate:l.vat_treatment&&l.vat_treatment!=='standard'?'0':l.vat_rate,vat_treatment:l.vat_treatment||null}))});

export function SalesInvoices({canView,canCreate,canEdit,canSubmit,onUnauthorized}:SalesInvoiceCapabilities&{onUnauthorized:()=>void}){
 const{t}=useTranslation();
 const unauthorizedRef=useRef(onUnauthorized);unauthorizedRef.current=onUnauthorized;
 const unauthorized=useCallback(()=>unauthorizedRef.current(),[]);
 const[list,setList]=useState<Invoice[]|null>(null),[loadError,setLoadError]=useState(false),[detail,setDetail]=useState<Invoice|null>(null),[form,setForm]=useState<{id:string|null;version:number|null;values:FormValues}|null>(null),[parties,setParties]=useState<Counterparty[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const money=(value:string)=>(parseFloat(value)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 const errorText=(code:string|undefined)=>{const key=`salesInvoice.errors.${code}`;const text=t(key);return code&&text!==key?text:t('salesInvoice.errors.generic')};

 const load=useCallback(async()=>{
  const response=await fetch('/api/invoices?direction=sales&limit=100');
  if(response.status===401){unauthorized();return;}
  if(!response.ok)throw Error();
  setList((await response.json() as {invoices:Invoice[]}).invoices);
 },[unauthorized]);
 useEffect(()=>{if(canView)void load().catch(()=>setLoadError(true))},[canView,load]);

 const request=async(url:string,method:string,body?:unknown):Promise<Invoice|null>=>{
  setBusy(true);setError(null);
  try{
   const response=await fetch(url,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
   if(response.status===401){unauthorized();return null;}
   const payload=await response.json().catch(()=>({})) as {invoice?:Invoice;code?:string};
   if(!response.ok||!payload.invoice){setError(errorText(payload.code));return null;}
   return payload.invoice;
  }catch{setError(errorText(undefined));return null;}
  finally{setBusy(false)}
 };
 const refresh=async()=>{if(canView)await load().catch(()=>setLoadError(true))};
 const loadParties=async()=>{try{const response=await fetch('/api/invoices/customers');if(response.status===401){unauthorized();return;}if(response.ok)setParties(((await response.json()) as {customers:Counterparty[]}).customers)}catch{/* the customer list stays empty; the server still validates the choice */}};

 const open=async(id:string)=>{setError(null);const response=await fetch(`/api/invoices/${id}`);if(response.status===401){unauthorized();return;}if(!response.ok){setLoadError(true);return;}setDetail((await response.json() as {invoice:Invoice}).invoice)};
 const startNew=()=>{setError(null);setDetail(null);setForm({id:null,version:null,values:emptyForm()});void loadParties()};
 const startEdit=(invoice:Invoice)=>{setError(null);setDetail(null);setForm({id:invoice.id,version:invoice.version,values:fromInvoice(invoice)});void loadParties()};
 const save=async(event:FormEvent)=>{
  event.preventDefault();if(!form)return;
  const saved=form.id?await request(`/api/invoices/${form.id}`,'PUT',{...toPayload(form.values),version:form.version}):await request('/api/invoices','POST',{direction:'sales',...toPayload(form.values)});
  if(saved){setForm(null);await refresh();await open(saved.id)}
 };
 const transition=async(invoice:Invoice,action:'submit'|'return')=>{
  const next=await request(`/api/invoices/${invoice.id}/${action}`,'POST',{version:invoice.version});
  if(next){await refresh();await open(next.id)}
 };
 const setValue=(patch:Partial<FormValues>)=>setForm(current=>current&&{...current,values:{...current.values,...patch}});
 const setLine=(index:number,patch:Partial<FormLine>)=>setForm(current=>current&&{...current,values:{...current.values,lines:current.values.lines.map((line,i)=>i===index?{...line,...patch}:line)}});

 if(!canView&&!canCreate)return null;
 const customers=parties;
 const statusLabel=(status:string)=>t(`salesInvoice.statuses.${status}`);
 return <section className="sales-invoices" aria-labelledby="sales-invoices-title">
  <div className="sales-invoices__head"><div><h2 id="sales-invoices-title">{t('salesInvoice.title')}</h2><p>{t('salesInvoice.intro')}</p></div>{canCreate&&<button type="button" className="primary" onClick={startNew}>{t('salesInvoice.add')}</button>}</div>
  {loadError&&<p role="alert" className="sales-invoices__error">{t('salesInvoice.loadError')}</p>}
  {canView&&list&&(list.length===0?<p className="sales-invoices__empty">{t('salesInvoice.empty')}</p>:<div className="sales-invoices__scroll"><table><thead><tr>{['number','customer','issueDate','dueDate','total','status'].map(k=><th key={k}>{t(`salesInvoice.${k}`)}</th>)}</tr></thead><tbody>{list.map(i=><tr key={i.id} tabIndex={0} onClick={()=>void open(i.id)} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();void open(i.id)}}}><td>{i.internal_number??i.external_reference??t('salesInvoice.draftNumber')}</td><td>{i.counterparty_name}</td><td>{formatDisplayDate(i.issue_date,'en')}</td><td>{formatDisplayDate(i.due_date,'en')}</td><td className="sales-invoices__amount">{money(i.total_amount)}</td><td><span className={`sales-invoices__status sales-invoices__status--${i.status}`}>{statusLabel(i.status)}</span></td></tr>)}</tbody></table></div>)}
  {detail&&<Dialog title={`${t('salesInvoice.detail')} | ${detail.internal_number??detail.external_reference??t('salesInvoice.draftNumber')}`} busy={busy} onClose={()=>setDetail(null)}>
   <dl className="sales-invoices__facts"><div><dt>{t('salesInvoice.customer')}</dt><dd>{detail.counterparty_name}</dd></div><div><dt>{t('salesInvoice.status')}</dt><dd>{statusLabel(detail.status)}</dd></div><div><dt>{t('salesInvoice.issueDate')}</dt><dd>{formatDisplayDate(detail.issue_date,'en')}</dd></div><div><dt>{t('salesInvoice.dueDate')}</dt><dd>{formatDisplayDate(detail.due_date,'en')}</dd></div><div><dt>{t('salesInvoice.taxPointDate')}</dt><dd>{formatDisplayDate(detail.tax_point_date,'en')}</dd></div></dl>
   <div className="sales-invoices__scroll"><table><thead><tr>{['description','quantity','unitPrice','vatTreatment','vatRate','net','vat','lineTotal'].map(k=><th key={k}>{t(`salesInvoice.${k}`)}</th>)}</tr></thead><tbody>{(detail.lines??[]).map(l=><tr key={l.line_number}><td>{l.description}</td><td>{l.quantity}</td><td>{money(l.unit_price)}</td><td>{l.vat_treatment?t(`salesInvoice.treatments.${l.vat_treatment}`):'—'}</td><td>{l.vat_rate}%</td><td>{money(l.net_amount??'0')}</td><td>{money(l.vat_amount??'0')}</td><td>{money(l.total_amount??'0')}</td></tr>)}</tbody></table></div>
   <dl className="sales-invoices__totals"><div><dt>{t('salesInvoice.subtotal')}</dt><dd>{money(detail.subtotal_amount)}</dd></div><div><dt>{t('salesInvoice.vatTotal')}</dt><dd>{money(detail.vat_amount)}</dd></div><div><dt>{t('salesInvoice.total')}</dt><dd><strong>{money(detail.total_amount)} {detail.currency}</strong></dd></div></dl>
   {error&&<p role="alert" className="sales-invoices__error">{error}</p>}
   <div className="modal-actions"><button type="button" onClick={()=>setDetail(null)} disabled={busy}>{t('common.close')}</button>
    {detail.status==='draft'&&canEdit&&<button type="button" onClick={()=>startEdit(detail)} disabled={busy}>{t('salesInvoice.edit')}</button>}
    {detail.status==='draft'&&canSubmit&&<button type="button" className="primary" onClick={()=>void transition(detail,'submit')} disabled={busy}>{t('salesInvoice.submit')}</button>}
    {detail.status==='submitted'&&canSubmit&&<button type="button" onClick={()=>void transition(detail,'return')} disabled={busy}>{t('salesInvoice.return')}</button>}</div>
  </Dialog>}
  {form&&<Dialog title={form.id?t('salesInvoice.editTitle'):t('salesInvoice.newTitle')} busy={busy} onClose={()=>setForm(null)}>
   <form className="sales-invoices__form" onSubmit={e=>void save(e)}>
    <label>{t('salesInvoice.customer')}<select required value={form.values.counterparty_id} onChange={e=>setValue({counterparty_id:e.target.value})}><option value="">{t('salesInvoice.chooseCustomer')}</option>{customers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <div className="sales-invoices__row"><label>{t('salesInvoice.issueDate')}<input type="date" required value={form.values.issue_date} onChange={e=>setValue({issue_date:e.target.value})}/></label><label>{t('salesInvoice.dueDate')}<input type="date" value={form.values.due_date} onChange={e=>setValue({due_date:e.target.value})}/></label></div>
    <div className="sales-invoices__row"><label>{t('salesInvoice.supplyDate')}<input type="date" value={form.values.supply_date} onChange={e=>setValue({supply_date:e.target.value})}/></label><label>{t('salesInvoice.taxPointDate')}<input type="date" value={form.values.tax_point_date} onChange={e=>setValue({tax_point_date:e.target.value})}/></label></div>
    <label>{t('salesInvoice.reference')}<input maxLength={100} value={form.values.external_reference} onChange={e=>setValue({external_reference:e.target.value})}/></label>
    <fieldset><legend>{t('salesInvoice.lines')}</legend>{form.values.lines.map((line,index)=><div className="sales-invoices__line" key={index} role="group" aria-label={t('salesInvoice.lineN',{n:index+1})}>
     <label>{t('salesInvoice.description')}<input required maxLength={500} value={line.description} onChange={e=>setLine(index,{description:e.target.value})}/></label>
     <label>{t('salesInvoice.quantity')}<input required inputMode="decimal" value={line.quantity} onChange={e=>setLine(index,{quantity:e.target.value})}/></label>
     <label>{t('salesInvoice.unitPrice')}<input required inputMode="decimal" value={line.unit_price} onChange={e=>setLine(index,{unit_price:e.target.value})}/></label>
     <label>{t('salesInvoice.discount')}<input inputMode="decimal" value={line.discount_amount} onChange={e=>setLine(index,{discount_amount:e.target.value})}/></label>
     <label>{t('salesInvoice.vatTreatment')}<select value={line.vat_treatment} onChange={e=>setLine(index,{vat_treatment:e.target.value,...(e.target.value&&e.target.value!=='standard'?{vat_rate:'0'}:{})})}><option value="">{t('salesInvoice.chooseTreatment')}</option>{TREATMENTS.map(x=><option key={x} value={x}>{t(`salesInvoice.treatments.${x}`)}</option>)}</select></label>
     <label>{t('salesInvoice.vatRate')}<input inputMode="decimal" disabled={!!line.vat_treatment&&line.vat_treatment!=='standard'} required={line.vat_treatment==='standard'} value={line.vat_rate} onChange={e=>setLine(index,{vat_rate:e.target.value})}/></label>
     {form.values.lines.length>1&&<button type="button" onClick={()=>setValue({lines:form.values.lines.filter((_,i)=>i!==index)})}>{t('salesInvoice.removeLine')}</button>}
    </div>)}<button type="button" onClick={()=>setValue({lines:[...form.values.lines,emptyLine()]})}>{t('salesInvoice.addLine')}</button></fieldset>
    <p className="sales-invoices__hint">{t('salesInvoice.totalsHint')}</p>
    <label>{t('salesInvoice.notes')}<textarea maxLength={2000} value={form.values.notes} onChange={e=>setValue({notes:e.target.value})}/></label>
    {error&&<p role="alert" className="sales-invoices__error">{error}</p>}
    <div className="modal-actions"><button type="button" onClick={()=>setForm(null)} disabled={busy}>{t('common.cancel')}</button><button className="primary" disabled={busy}>{t('salesInvoice.saveDraft')}</button></div>
   </form>
  </Dialog>}
 </section>;
}
