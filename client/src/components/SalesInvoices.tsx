import {FormEvent,useCallback,useEffect,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Dialog} from './Dialog';
import {formatDisplayDate} from '../date-format';
import {clearQueryParameters,readQueryParameter,writeQueryParameters} from '../navigation/queryState';
import {INVOICE_STATUSES,InvoiceCaps,PAGE_SIZE,nextAction,sumDecimalStrings} from './invoiceWorkspaceLogic';
import './SalesInvoices.css';

/**
 * One invoice workspace for both directions (sales and purchase). Amounts, numbering, VAT, obligations and journals are
 * always decided by the server; this component only collects raw inputs, offers the next permitted action and navigates.
 */
export type SalesInvoiceCapabilities=InvoiceCaps;
export type InvoiceDirection='sales'|'purchase';
type Line={line_number?:number;description:string;quantity:string;unit_price:string;discount_amount:string;vat_rate:string;net_amount?:string;vat_amount?:string;total_amount?:string;vat_treatment:string|null;vat_recoverability?:string|null;vat_recoverable_percent?:string|null};
type Invoice={id:string;status:'draft'|'submitted'|'approved'|'cancelled';counterparty_id:string;counterparty_name:string;internal_number:string|null;external_reference:string|null;issue_date:string;due_date:string|null;supply_date:string|null;tax_point_date:string|null;currency:string;subtotal_amount:string;vat_amount:string;total_amount:string;notes:string|null;version:number;created_by_user_id?:string|null;source_document_id?:string|null;lines?:Line[];
 obligation?:{id:string;is_cancelled:boolean;original_amount:string}|null;journal?:{id:string;status:string}|null;vat?:{status:'pending'|'reviewed'|'missing';review_id:string|null;tax_date:string|null};paid_amount?:string|null;outstanding_amount?:string|null;actionable_status?:string};
type Counterparty={id:string;name:string;type:string};
type EvidenceDocument={id:string;original_filename:string;reference_number:string|null;document_type:string|null;status:string;document_date:string|null};
type FormLine={description:string;quantity:string;unit_price:string;discount_amount:string;vat_rate:string;vat_treatment:string;vat_recoverability:string;vat_recoverable_percent:string;rate_source:'auto'|'saved'};
type RateState={date:string;status:'loading'|'ok'|'missing'|'error';value?:string};
type FormValues={counterparty_id:string;issue_date:string;due_date:string;supply_date:string;tax_point_date:string;external_reference:string;notes:string;source_document_id:string;lines:FormLine[]};
type Filters={q:string;status:string;party:string;from:string;to:string};
const TREATMENTS=['standard','zero_rated','exempt','out_of_scope'] as const;
const emptyLine=():FormLine=>({description:'',quantity:'1',unit_price:'',discount_amount:'',vat_rate:'',vat_treatment:'',vat_recoverability:'',vat_recoverable_percent:'',rate_source:'auto'});
const emptyForm=():FormValues=>({counterparty_id:'',issue_date:'',due_date:'',supply_date:'',tax_point_date:'',external_reference:'',notes:'',source_document_id:'',lines:[emptyLine()]});
const fromInvoice=(i:Invoice):FormValues=>({counterparty_id:i.counterparty_id,issue_date:i.issue_date,due_date:i.due_date??'',supply_date:i.supply_date??'',tax_point_date:i.tax_point_date??'',external_reference:i.external_reference??'',notes:i.notes??'',source_document_id:i.source_document_id??'',lines:(i.lines??[]).map(l=>({description:l.description,quantity:l.quantity,unit_price:l.unit_price,discount_amount:l.discount_amount==='0.00'?'':l.discount_amount,vat_rate:l.vat_rate,vat_treatment:l.vat_treatment??'',vat_recoverability:l.vat_recoverability??'',vat_recoverable_percent:l.vat_recoverable_percent??'',rate_source:'saved'}))});
// Amounts are always computed by the server; the client only sends the raw inputs as strings.
// The source document link is part of the full draft replacement, so an edit must send the existing link back or the server removes it.
const toPayload=(v:FormValues,direction:InvoiceDirection)=>({counterparty_id:v.counterparty_id,issue_date:v.issue_date,due_date:v.due_date||null,supply_date:v.supply_date||null,tax_point_date:v.tax_point_date||null,external_reference:v.external_reference.trim()||null,notes:v.notes.trim()||null,source_document_id:v.source_document_id||null,lines:v.lines.map(l=>({description:l.description,quantity:l.quantity,unit_price:l.unit_price,...(l.discount_amount?{discount_amount:l.discount_amount}:{}),vat_rate:l.vat_treatment==='standard'?l.vat_rate:l.vat_treatment?'0':l.vat_rate,vat_treatment:l.vat_treatment||null,...(direction==='purchase'&&l.vat_treatment==='standard'&&l.vat_recoverability?{vat_recoverability:l.vat_recoverability,...(l.vat_recoverability==='partially_recoverable'?{vat_recoverable_percent:l.vat_recoverable_percent}:{})}:{})}))});
const validDate=(value:string|null)=>value&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value?value:'';

export function InvoiceWorkspace({direction='sales',onNavigate,onUnauthorized,...caps}:SalesInvoiceCapabilities&{direction?:InvoiceDirection;onUnauthorized:()=>void;onNavigate?:(page:string,parameters:Record<string,string>)=>void}){
 const{canView,canCreate,canEdit,canSubmit,canViewDocuments=false}=caps;
 const{t}=useTranslation();
 const ns=direction==='purchase'?'purchaseInvoice':'salesInvoice';
 const d=(key:string,options?:Record<string,unknown>)=>t(`${ns}.${key}`,options);
 const prefix=direction==='purchase'?'purchaseInv':'salesInv';
 const unauthorizedRef=useRef(onUnauthorized);unauthorizedRef.current=onUnauthorized;
 const unauthorized=useCallback(()=>unauthorizedRef.current(),[]);
 const[list,setList]=useState<Invoice[]|null>(null),[total,setTotal]=useState(0),[loadError,setLoadError]=useState(false),[detail,setDetail]=useState<Invoice|null>(null),[form,setForm]=useState<{id:string|null;version:number|null;values:FormValues}|null>(null),[parties,setParties]=useState<Counterparty[]>([]),[documents,setDocuments]=useState<EvidenceDocument[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[confirmPost,setConfirmPost]=useState(false);
 const[rate,setRate]=useState<RateState|null>(null);
 const readFilters=():Filters=>({q:readQueryParameter(`${prefix}Q`)??'',status:readQueryParameter(`${prefix}Status`,{allowedValues:INVOICE_STATUSES})??'',party:readQueryParameter(`${prefix}Party`,{pattern:/^[0-9a-f-]{36}$/i})??'',from:validDate(readQueryParameter(`${prefix}From`)),to:validDate(readQueryParameter(`${prefix}To`))});
 const[filters,setFilters]=useState<Filters>(readFilters);
 const[searchText,setSearchText]=useState(filters.q);
 const[offset,setOffset]=useState(()=>{const page=Number(readQueryParameter(`${prefix}Page`,{pattern:/^\d{1,5}$/})??'1');return page>1?(page-1)*PAGE_SIZE:0});
 const loadSeq=useRef(0);
 const isPurchase=direction==='purchase';
 const rangeInvalid=!!filters.from&&!!filters.to&&filters.to<filters.from;
 const filtersActive=Object.values(filters).some(Boolean);
 const rateDate=form&&!isPurchase?(form.values.tax_point_date||form.values.issue_date):'';
 const formOpen=!!form;
 const money=(value:string|null|undefined)=>(parseFloat(value??'')||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 const errorText=(code:string|undefined)=>{const key=`${ns}.errors.${code}`;const text=t(key);if(code&&text!==key)return text;const shared=t(`salesInvoice.errors.${code}`);return code&&shared!==`salesInvoice.errors.${code}`?shared:t('salesInvoice.errors.generic')};

 const load=useCallback(async()=>{
  if(rangeInvalid)return;
  const seq=++loadSeq.current;
  const query=new URLSearchParams({direction,limit:String(PAGE_SIZE),offset:String(offset)});
  if(filters.status)query.set('status',filters.status);
  if(filters.party)query.set('counterparty_id',filters.party);
  if(filters.from)query.set('from',filters.from);
  if(filters.to)query.set('to',filters.to);
  if(filters.q.trim())query.set('q',filters.q.trim());
  const response=await fetch(`/api/invoices?${query.toString()}`);
  if(response.status===401){unauthorized();return;}
  if(!response.ok)throw Error();
  const payload=await response.json() as {invoices:Invoice[];total?:number};
  if(seq!==loadSeq.current)return;
  setList(payload.invoices);setTotal(payload.total??payload.invoices.length);setLoadError(false);
 },[unauthorized,direction,offset,filters,rangeInvalid]);
 useEffect(()=>{if(canView)void load().catch(()=>setLoadError(true))},[canView,load]);
 // A page past the end (for example after the data changed) falls back to the last page instead of showing a misleading empty table.
 useEffect(()=>{if(list&&list.length===0&&total>0&&offset>0)setOffset(Math.max(0,Math.floor((total-1)/PAGE_SIZE)*PAGE_SIZE))},[list,total,offset]);
 // The text search is committed to the filters (and the URL) shortly after typing stops.
 useEffect(()=>{
  if(searchText===filters.q)return;
  const timer=setTimeout(()=>{setFilters(current=>({...current,q:searchText}));setOffset(0);writeQueryParameters({[`${prefix}Q`]:searchText||null,[`${prefix}Page`]:null},'replace')},300);
  return()=>clearTimeout(timer);
 },[searchText,filters.q,prefix]);

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
 useEffect(()=>{
  if(!formOpen||!rateDate){setRate(null);return;}
  let cancelled=false;setRate({date:rateDate,status:'loading'});
  fetch(`/api/invoices/standard-rate?date=${rateDate}`).then(async response=>{
   if(cancelled)return;
   if(response.status===401){unauthorized();return;}
   if(response.ok){const payload=await response.json() as {rate:string};if(cancelled)return;setRate({date:rateDate,status:'ok',value:payload.rate});
    // Only lines whose rate was resolved automatically (or is still empty) follow the resolved rate; a saved rate is never overwritten.
    setForm(current=>current&&{...current,values:{...current.values,lines:current.values.lines.map(l=>l.vat_treatment==='standard'&&(l.rate_source==='auto'||l.vat_rate==='')?{...l,vat_rate:payload.rate,rate_source:'auto'}:l)}});}
   else setRate({date:rateDate,status:response.status===404?'missing':'error'});
  }).catch(()=>{if(!cancelled)setRate({date:rateDate,status:'error'})});
  return()=>{cancelled=true};
 },[formOpen,rateDate,unauthorized]);
 const sameRate=(a:string,b:string)=>a!==''&&b!==''&&Number(a).toFixed(2)===Number(b).toFixed(2);
 // The effective-rate check is a sales rule; purchase lines carry the supplier's stated rate and the server validates it.
 const lineRateState=(line:FormLine):'na'|'ok'|'pending'|'mismatch'|'missing'|'error'|'loading'=>{
  if(isPurchase||line.vat_treatment!=='standard')return 'na';
  if(!rate||rate.status==='loading')return 'loading';
  if(rate.status==='missing')return 'missing';
  if(rate.status==='error')return 'error';
  if(line.vat_rate==='')return 'pending';
  return sameRate(line.vat_rate,rate.value??'')?'ok':'mismatch';
 };
 const refresh=async()=>{if(canView)await load().catch(()=>setLoadError(true))};
 const loadParties=useCallback(async()=>{try{const response=await fetch(isPurchase?'/api/invoices/customers?direction=purchase':'/api/invoices/customers');if(response.status===401){unauthorized();return;}if(response.ok){const payload=await response.json() as {customers?:Counterparty[];suppliers?:Counterparty[]};setParties((isPurchase?payload.suppliers:payload.customers)??[])}}catch{/* the picker stays empty; the server still validates the choice */}},[isPurchase,unauthorized]);
 useEffect(()=>{if(canView||canCreate)void loadParties()},[canView,canCreate,loadParties]);
 const loadDocuments=async()=>{if(!canViewDocuments)return;try{const response=await fetch('/api/documents');if(response.status===401){unauthorized();return;}if(response.ok)setDocuments(((await response.json()) as {documents?:EvidenceDocument[]}).documents??[])}catch{/* evidence linking is optional */}};

 const open=async(id:string)=>{setError(null);setConfirmPost(false);const response=await fetch(`/api/invoices/${id}`);if(response.status===401){unauthorized();return;}if(!response.ok){setLoadError(true);return;}setDetail((await response.json() as {invoice:Invoice}).invoice)};
 const startNew=()=>{setError(null);setDetail(null);setForm({id:null,version:null,values:emptyForm()});void loadParties();void loadDocuments()};
 const startEdit=(invoice:Invoice)=>{setError(null);setDetail(null);setForm({id:invoice.id,version:invoice.version,values:fromInvoice(invoice)});void loadParties();void loadDocuments()};
 const save=async(event:FormEvent)=>{
  event.preventDefault();if(!form)return;
  const saved=form.id?await request(`/api/invoices/${form.id}`,'PUT',{...toPayload(form.values,direction),version:form.version}):await request('/api/invoices','POST',{direction,...toPayload(form.values,direction)});
  if(saved){setForm(null);await refresh();await open(saved.id)}
 };
 const transition=async(invoice:Invoice,action:'submit'|'return'|'approve')=>{
  const next=await request(`/api/invoices/${invoice.id}/${action}`,'POST',{version:invoice.version});
  if(next){await refresh();await open(next.id)}
 };
 // Posting is an explicit, separate accounting act through the authorized journal API. The invoice is re-read afterwards so every figure comes from the server.
 const postJournal=async(invoice:Invoice)=>{
  if(!invoice.journal)return;
  setBusy(true);setError(null);
  try{
   const response=await fetch(`/api/accounting/journals/${invoice.journal.id}/post`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
   if(response.status===401){unauthorized();return;}
   if(!response.ok){const payload=await response.json().catch(()=>({})) as {code?:string};const key=`invoiceWorkspace.postErrors.${payload.code}`;const text=t(key);setError(payload.code&&text!==key?text:t('invoiceWorkspace.postErrors.generic'));setConfirmPost(false);return;}
   setConfirmPost(false);
  }catch{setError(t('invoiceWorkspace.postErrors.generic'));setConfirmPost(false);return;}
  finally{setBusy(false)}
  await refresh();await open(invoice.id);
 };
 const setValue=(patch:Partial<FormValues>)=>setForm(current=>current&&{...current,values:{...current.values,...patch}});
 const setLine=(index:number,patch:Partial<FormLine>)=>setForm(current=>current&&{...current,values:{...current.values,lines:current.values.lines.map((line,i)=>i===index?{...line,...patch}:line)}});

 const changeFilter=(patch:Partial<Filters>)=>{
  setFilters(current=>({...current,...patch}));setOffset(0);
  writeQueryParameters({...Object.fromEntries(Object.entries(patch).map(([k,v])=>[`${prefix}${k==='party'?'Party':k==='status'?'Status':k==='from'?'From':'To'}`,v||null])),[`${prefix}Page`]:null});
 };
 const resetFilters=()=>{setFilters({q:'',status:'',party:'',from:'',to:''});setSearchText('');setOffset(0);clearQueryParameters(['Q','Status','Party','From','To','Page'].map(k=>`${prefix}${k}`))};
 const goToPage=(page:number)=>{setOffset((page-1)*PAGE_SIZE);writeQueryParameters({[`${prefix}Page`]:page>1?String(page):null})};

 if(!canView&&!canCreate)return null;
 const saveBlocked=!!form&&form.values.lines.some(l=>{const st=lineRateState(l);return st==='pending'||st==='loading'||(!!form.values.tax_point_date&&(st==='mismatch'||st==='missing'||st==='error'))});
 const statusLabel=(status:string)=>t(`salesInvoice.statuses.${status}`);
 const stageLabel=(invoice:Invoice)=>invoice.actionable_status?t(`invoiceWorkspace.stages.${invoice.actionable_status}`):statusLabel(invoice.status);
 const numberOf=(i:Invoice)=>i.internal_number??i.external_reference??t('salesInvoice.draftNumber');
 const page=Math.floor(offset/PAGE_SIZE)+1,pages=Math.max(1,Math.ceil(total/PAGE_SIZE));
 const rows=list??[];
 const eligibleDocuments=documents.filter(x=>x.status!=='rejected'&&(isPurchase?(x.document_type==='purchase'||x.document_type==='expense'):x.document_type==='sale'));
 const linkTo=(label:string,page:string,parameters:Record<string,string>)=><button type="button" className="sales-invoices__link" onClick={()=>onNavigate?.(page,parameters)}>{label}</button>;

 const renderActions=(invoice:Invoice)=>{
  const action=nextAction({status:invoice.status,created_by_user_id:invoice.created_by_user_id,obligation:invoice.obligation,journal:invoice.journal},caps);
  const reason=action.reason?t(`invoiceWorkspace.reasons.${action.reason}`):null;
  const primaryLabel=action.kind==='submit'?t('salesInvoice.submit'):action.kind==='approve'?t('invoiceWorkspace.approve'):action.kind==='post'?t('invoiceWorkspace.postJournal'):null;
  const onPrimary=()=>{if(action.kind==='submit')void transition(invoice,'submit');else if(action.kind==='approve')void transition(invoice,'approve');else if(action.kind==='post')setConfirmPost(true)};
  return <>
   {reason&&<p className={`sales-invoices__hint sales-invoices__next${action.kind==='none'?'':' sales-invoices__next--blocked'}`} data-testid="next-action-note">{reason}</p>}
   <div className="modal-actions"><button type="button" onClick={()=>setDetail(null)} disabled={busy}>{t('common.close')}</button>
    {invoice.status==='draft'&&canEdit&&<button type="button" onClick={()=>startEdit(invoice)} disabled={busy}>{t('salesInvoice.edit')}</button>}
    {invoice.status==='submitted'&&canSubmit&&<button type="button" onClick={()=>void transition(invoice,'return')} disabled={busy}>{t('salesInvoice.return')}</button>}
    {primaryLabel&&<button type="button" className="primary" onClick={onPrimary} disabled={busy||!action.enabled}>{primaryLabel}</button>}</div>
  </>;
 };

 return <section className="sales-invoices" aria-labelledby={`${prefix}-title`}>
  <div className="sales-invoices__head"><div><h2 id={`${prefix}-title`}>{d('title')}</h2><p>{d('intro')}</p></div>{canCreate&&<button type="button" className="primary" onClick={startNew}>{d('add')}</button>}</div>
  {loadError&&<p role="alert" className="sales-invoices__error">{d('loadError')}</p>}
  {canView&&<div className="sales-invoices__filters" role="search" aria-label={t('invoiceWorkspace.filters.label')}>
   <label>{t('invoiceWorkspace.filters.search')}<input type="search" value={searchText} maxLength={100} placeholder={t('invoiceWorkspace.filters.searchPlaceholder')} onChange={e=>setSearchText(e.target.value)}/></label>
   <label>{d('counterparty')}<select value={filters.party} onChange={e=>changeFilter({party:e.target.value})}><option value="">{d('allCounterparties')}</option>{parties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
   <label>{t('salesInvoice.status')}<select value={filters.status} onChange={e=>changeFilter({status:e.target.value})}><option value="">{t('invoiceWorkspace.filters.allStatuses')}</option>{INVOICE_STATUSES.map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}</select></label>
   <label>{t('invoiceWorkspace.filters.from')}<input type="date" value={filters.from} onChange={e=>changeFilter({from:e.target.value})}/></label>
   <label>{t('invoiceWorkspace.filters.to')}<input type="date" value={filters.to} onChange={e=>changeFilter({to:e.target.value})}/></label>
   {filtersActive&&<button type="button" className="sales-invoices__reset" onClick={resetFilters}>{t('invoiceWorkspace.filters.reset')}</button>}
  </div>}
  {rangeInvalid&&<p role="alert" className="sales-invoices__error">{t('invoiceWorkspace.filters.rangeInvalid')}</p>}
  {canView&&list&&(list.length===0?<div className="sales-invoices__empty">{filtersActive?<><p>{t('invoiceWorkspace.filters.noMatch')}</p><button type="button" onClick={resetFilters}>{t('invoiceWorkspace.filters.reset')}</button></>:<p>{d('empty')}</p>}</div>:<>
   <p className="sales-invoices__summary" aria-live="polite">{t('invoiceWorkspace.summary',{count:total,subtotal:money(sumDecimalStrings(rows.map(i=>i.total_amount)))})}</p>
   <div className="sales-invoices__scroll"><table><thead><tr><th>{t('salesInvoice.number')}</th><th>{d('counterparty')}</th><th>{t('salesInvoice.issueDate')}</th><th>{t('salesInvoice.dueDate')}</th><th>{t('salesInvoice.total')}</th><th>{t('invoiceWorkspace.outstanding')}</th><th>{t('salesInvoice.status')}</th></tr></thead><tbody>{rows.map(i=><tr key={i.id} tabIndex={0} onClick={()=>void open(i.id)} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();void open(i.id)}}}><td>{numberOf(i)}</td><td>{i.counterparty_name}</td><td>{formatDisplayDate(i.issue_date,'en')}</td><td>{formatDisplayDate(i.due_date,'en')}</td><td className="sales-invoices__amount">{money(i.total_amount)}</td><td className="sales-invoices__amount">{i.outstanding_amount!=null?money(i.outstanding_amount):'—'}</td><td><span className={`sales-invoices__status sales-invoices__status--${i.status}`}>{stageLabel(i)}</span></td></tr>)}</tbody></table></div>
   {pages>1&&<nav className="sales-invoices__pager" aria-label={t('invoiceWorkspace.pagination.label')}><button type="button" disabled={page<=1} onClick={()=>goToPage(page-1)}>{t('invoiceWorkspace.pagination.previous')}</button><span>{t('invoiceWorkspace.pagination.page',{page,pages})}</span><button type="button" disabled={page>=pages} onClick={()=>goToPage(page+1)}>{t('invoiceWorkspace.pagination.next')}</button></nav>}</>)}
  {detail&&<Dialog size="wide" title={`${t('salesInvoice.detail')} | ${numberOf(detail)}`} busy={busy} onClose={()=>setDetail(null)}>
   <dl className="sales-invoices__facts"><div><dt>{d('counterparty')}</dt><dd>{detail.counterparty_name}</dd></div><div><dt>{t('salesInvoice.status')}</dt><dd>{stageLabel(detail)}</dd></div><div><dt>{t('salesInvoice.issueDate')}</dt><dd>{formatDisplayDate(detail.issue_date,'en')}</dd></div><div><dt>{t('salesInvoice.dueDate')}</dt><dd>{formatDisplayDate(detail.due_date,'en')}</dd></div><div><dt>{t('salesInvoice.taxPointDate')}</dt><dd>{formatDisplayDate(detail.tax_point_date,'en')}</dd></div>{detail.external_reference&&<div><dt>{t('salesInvoice.reference')}</dt><dd>{detail.external_reference}</dd></div>}</dl>
   {(detail.status==='approved'||detail.status==='cancelled')&&<section className="sales-invoices__finance" aria-label={t('invoiceWorkspace.financeTitle')}><h4>{t('invoiceWorkspace.financeTitle')}</h4>
    <dl className="sales-invoices__facts">
     <div><dt>{t('invoiceWorkspace.invoiceNumber')}</dt><dd>{detail.internal_number??'—'}</dd></div>
     <div><dt>{t('invoiceWorkspace.obligation')}</dt><dd>{detail.obligation?(<>{detail.obligation.is_cancelled?t('invoiceWorkspace.obligationCancelled'):t('invoiceWorkspace.obligationLinked')}{caps.canViewObligations&&onNavigate&&<> {linkTo(t('invoiceWorkspace.openObligation'),'obligations',{obligationId:detail.obligation.id})}</>}</>):'—'}</dd></div>
     <div><dt>{t('invoiceWorkspace.journal')}</dt><dd>{detail.journal?(<>{t(`invoiceWorkspace.journalStatuses.${detail.journal.status}`)}{caps.canViewAccounting&&onNavigate&&<> {linkTo(t('invoiceWorkspace.openJournal'),'accounting',{accountingTab:'journals',journalId:detail.journal.id})}</>}</>):t('invoiceWorkspace.journalStatuses.none')}</dd></div>
     <div><dt>{t('invoiceWorkspace.vat')}</dt><dd>{t(`invoiceWorkspace.vatStatuses.${detail.vat?.status??'pending'}`)}{detail.vat?.status==='reviewed'&&caps.canViewVat&&onNavigate&&<> {linkTo(t('invoiceWorkspace.openVat'),'vat',{})}</>}</dd></div>
     <div><dt>{t('invoiceWorkspace.paid')}</dt><dd>{detail.paid_amount!=null?`${money(detail.paid_amount)} ${detail.currency}`:'—'}</dd></div>
     <div><dt>{t('invoiceWorkspace.outstanding')}</dt><dd>{detail.outstanding_amount!=null?`${money(detail.outstanding_amount)} ${detail.currency}`:'—'}</dd></div>
    </dl></section>}
   {detail.source_document_id&&canViewDocuments&&<p className="sales-invoices__hint">{t('invoiceWorkspace.evidence')}: <a href={`/api/documents/${detail.source_document_id}/file`} target="_blank" rel="noreferrer">{t('invoiceWorkspace.openDocument')}</a></p>}
   <div className="sales-invoices__scroll"><table><thead><tr>{['description','quantity','unitPrice','vatTreatment','vatRate','net','vat','lineTotal'].map(k=><th key={k}>{t(`salesInvoice.${k}`)}</th>)}</tr></thead><tbody>{(detail.lines??[]).map(l=><tr key={l.line_number}><td>{l.description}</td><td>{l.quantity}</td><td>{money(l.unit_price)}</td><td>{l.vat_treatment?t(`salesInvoice.treatments.${l.vat_treatment}`):'—'}</td><td>{l.vat_rate}%</td><td>{money(l.net_amount??'0')}</td><td>{money(l.vat_amount??'0')}</td><td>{money(l.total_amount??'0')}</td></tr>)}</tbody></table></div>
   <dl className="sales-invoices__totals"><div><dt>{t('salesInvoice.subtotal')}</dt><dd>{money(detail.subtotal_amount)}</dd></div><div><dt>{t('salesInvoice.vatTotal')}</dt><dd>{money(detail.vat_amount)}</dd></div><div><dt>{t('salesInvoice.total')}</dt><dd><strong>{money(detail.total_amount)} {detail.currency}</strong></dd></div></dl>
   {error&&<p role="alert" className="sales-invoices__error">{error}</p>}
   {confirmPost?<div className="sales-invoices__confirm" role="group" aria-label={t('invoiceWorkspace.confirmPostTitle')}><p><strong>{t('invoiceWorkspace.confirmPostTitle')}</strong></p><p>{t('invoiceWorkspace.confirmPostBody')}</p>
     <div className="modal-actions"><button type="button" onClick={()=>setConfirmPost(false)} disabled={busy}>{t('common.cancel')}</button><button type="button" className="primary" onClick={()=>void postJournal(detail)} disabled={busy}>{t('invoiceWorkspace.confirmPost')}</button></div></div>
    :renderActions(detail)}
  </Dialog>}
  {form&&<Dialog size="wide" title={form.id?t('salesInvoice.editTitle'):d('newTitle')} busy={busy} onClose={()=>setForm(null)}>
   <form className="sales-invoices__form" onSubmit={e=>void save(e)}>
    <label>{d('counterparty')}<select required value={form.values.counterparty_id} onChange={e=>setValue({counterparty_id:e.target.value})}><option value="">{d('chooseCounterparty')}</option>{parties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <div className="sales-invoices__row"><label>{t('salesInvoice.issueDate')}<input type="date" required value={form.values.issue_date} onChange={e=>setValue({issue_date:e.target.value})}/></label><label>{t('salesInvoice.dueDate')}<input type="date" value={form.values.due_date} onChange={e=>setValue({due_date:e.target.value})}/></label></div>
    <div className="sales-invoices__row"><label>{t('salesInvoice.supplyDate')}<input type="date" value={form.values.supply_date} onChange={e=>setValue({supply_date:e.target.value})}/></label><label>{t('salesInvoice.taxPointDate')}<input type="date" value={form.values.tax_point_date} onChange={e=>setValue({tax_point_date:e.target.value})}/></label></div>
    {!isPurchase&&!form.values.tax_point_date&&<p className="sales-invoices__hint">{t('salesInvoice.rateProvisional')}</p>}
    {isPurchase&&!form.values.tax_point_date&&<p className="sales-invoices__hint">{t('purchaseInvoice.taxPointRequired')}</p>}
    <label>{t('salesInvoice.reference')}<input maxLength={100} value={form.values.external_reference} onChange={e=>setValue({external_reference:e.target.value})}/></label>
    {canViewDocuments&&<label>{t('invoiceWorkspace.evidenceDocument')}<select value={form.values.source_document_id} onChange={e=>setValue({source_document_id:e.target.value})}><option value="">{t('invoiceWorkspace.noEvidence')}</option>{form.values.source_document_id&&!eligibleDocuments.some(x=>x.id===form.values.source_document_id)&&<option value={form.values.source_document_id}>{t('invoiceWorkspace.currentEvidence')}</option>}{eligibleDocuments.map(x=><option key={x.id} value={x.id}>{x.reference_number??x.original_filename}{x.document_date?` · ${x.document_date}`:''}</option>)}</select><span className="sales-invoices__hint">{t('invoiceWorkspace.evidenceHint')}</span></label>}
    <fieldset><legend>{t('salesInvoice.lines')}</legend>{form.values.lines.map((line,index)=><div className="sales-invoices__line" key={index} role="group" aria-label={t('salesInvoice.lineN',{n:index+1})}>
     <label>{t('salesInvoice.description')}<input required maxLength={500} value={line.description} onChange={e=>setLine(index,{description:e.target.value})}/></label>
     <label>{t('salesInvoice.quantity')}<input required inputMode="decimal" value={line.quantity} onChange={e=>setLine(index,{quantity:e.target.value})}/></label>
     <label>{t('salesInvoice.unitPrice')}<input required inputMode="decimal" value={line.unit_price} onChange={e=>setLine(index,{unit_price:e.target.value})}/></label>
     <label>{t('salesInvoice.discount')}<input inputMode="decimal" value={line.discount_amount} onChange={e=>setLine(index,{discount_amount:e.target.value})}/></label>
     <label>{t('salesInvoice.vatTreatment')}<select value={line.vat_treatment} onChange={e=>setLine(index,{vat_treatment:e.target.value,...(e.target.value!=='standard'?{vat_recoverability:'',vat_recoverable_percent:''}:{}),...(e.target.value==='standard'?(isPurchase?{vat_rate:line.vat_rate,rate_source:'saved' as const}:{vat_rate:rate?.status==='ok'?rate.value??'':'',rate_source:'auto' as const}):e.target.value?{vat_rate:'0'}:{})})}><option value="">{t('salesInvoice.chooseTreatment')}</option>{TREATMENTS.map(x=><option key={x} value={x}>{t(`salesInvoice.treatments.${x}`)}</option>)}</select></label>
     {isPurchase&&line.vat_treatment==='standard'?<>
      <label>{t('salesInvoice.vatRate')}<input required inputMode="decimal" dir="ltr" value={line.vat_rate} onChange={e=>setLine(index,{vat_rate:e.target.value,rate_source:'saved'})}/></label>
      <label>{t('purchaseInvoice.recoverability')}<select required value={line.vat_recoverability} onChange={e=>setLine(index,{vat_recoverability:e.target.value,...(e.target.value!=='partially_recoverable'?{vat_recoverable_percent:''}:{})})}><option value="">{t('purchaseInvoice.chooseRecoverability')}</option>{['fully_recoverable','partially_recoverable','non_recoverable'].map(x=><option key={x} value={x}>{t(`purchaseInvoice.recoverabilities.${x}`)}</option>)}</select><span className="sales-invoices__hint">{t('purchaseInvoice.recoverabilityHint')}</span></label>
      {line.vat_recoverability==='partially_recoverable'&&<label>{t('purchaseInvoice.recoverablePercent')}<input required inputMode="decimal" dir="ltr" value={line.vat_recoverable_percent} onChange={e=>setLine(index,{vat_recoverable_percent:e.target.value})}/></label>}</>
     :(()=>{const state=lineRateState(line);const shown=line.vat_treatment==='standard'?(line.vat_rate?`${line.vat_rate}%`:'—'):line.vat_treatment?'0%':'—';
      return <div className="sales-invoices__rate-field"><span className="sales-invoices__rate-label">{t('salesInvoice.vatRate')}</span><output className="sales-invoices__rate" dir="ltr" aria-label={t('salesInvoice.vatRate')}>{shown}</output>
       {state==='mismatch'&&<p role="alert" className="sales-invoices__error sales-invoices__rate-note">{t('salesInvoice.rateMismatch',{saved:line.vat_rate,rate:rate?.value})} <button type="button" onClick={()=>setLine(index,{vat_rate:rate?.value??'',rate_source:'auto'})}>{t('salesInvoice.applyRate',{rate:rate?.value})}</button></p>}
       {state==='missing'&&<p role="alert" className="sales-invoices__error sales-invoices__rate-note">{t('salesInvoice.rateMissing')}</p>}
       {state==='error'&&<p role="alert" className="sales-invoices__error sales-invoices__rate-note">{t('salesInvoice.rateError')}</p>}</div>})()}
     {form.values.lines.length>1&&<button type="button" onClick={()=>setValue({lines:form.values.lines.filter((_,i)=>i!==index)})}>{t('salesInvoice.removeLine')}</button>}
    </div>)}<button type="button" onClick={()=>setValue({lines:[...form.values.lines,emptyLine()]})}>{t('salesInvoice.addLine')}</button></fieldset>
    <p className="sales-invoices__hint">{t('salesInvoice.totalsHint')}</p>{!isPurchase&&<p className="sales-invoices__hint">{t('salesInvoice.rateScopeNote')}</p>}
    <label>{t('salesInvoice.notes')}<textarea maxLength={2000} value={form.values.notes} onChange={e=>setValue({notes:e.target.value})}/></label>
    {error&&<p role="alert" className="sales-invoices__error">{error}</p>}
    <div className="modal-actions"><button type="button" onClick={()=>setForm(null)} disabled={busy}>{t('common.cancel')}</button><button className="primary" disabled={busy||saveBlocked}>{t('salesInvoice.saveDraft')}</button></div>
   </form>
  </Dialog>}
 </section>;
}

/** Original export name, kept so existing imports (the Sales page) keep working. */
export const SalesInvoices=InvoiceWorkspace;
