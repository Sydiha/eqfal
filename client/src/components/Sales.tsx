import {Fragment,useEffect,useMemo,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {formatDisplayDate} from '../date-format';
import {clearQueryParameters,readQueryParameter,writeQueryParameters} from '../navigation/queryState';
import {DataWorkspace,PageHeader,StatusBadge,WorkspacePage,WorkspaceState,WorkspaceToolbar} from './SharedUI';
import './sales.css';

type Settlement={id:string;amount:string;transaction_date:string;description:string|null;bank_reference:string|null};
type CounterpartyType='customer'|'supplier'|'government'|'other';
type Sale={id:string;original_filename:string;status:string;document_date:string|null;reference_number:string|null;total_amount:string|null;intake_note:string|null;counterparty_id:string|null;customer_name:string|null;counterparty_type:CounterpartyType|null;receivable_id:string|null;receivable_original_amount:string|null;due_on:string|null;verification_status:string|null;receivable_cancelled:boolean;receivable_relationship:'not_created'|'linked_active'|'linked_cancelled';collected_amount:string;remaining_amount:string|null;financial_state:'open'|'partial'|'paid'|'overdue'|null;settlement_history:Settlement[]};
type DiscoveryFilters={search:string;customer:string;financial:string;review:string;from:string;to:string;receivable:string;verification:string};
const financialValues=['open','partial','paid','overdue'] as const,reviewValues=['uploaded','needs_review','approved','incomplete','rejected'] as const,receivableValues=['not_created','linked_active','linked_cancelled'] as const,verificationValues=['confirmed','unconfirmed'] as const;
const filterParameters=['salesSearch','salesCustomer','salesFinancial','salesReview','salesFrom','salesTo','salesReceivable','salesVerification'] as const;
const validDate=(value:string|null)=>value&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value?value:'';
const readFilters=():DiscoveryFilters=>({search:readQueryParameter('salesSearch')??'',customer:readQueryParameter('salesCustomer')??'',financial:readQueryParameter('salesFinancial',{allowedValues:financialValues})??'',review:readQueryParameter('salesReview',{allowedValues:reviewValues})??'',from:validDate(readQueryParameter('salesFrom')),to:validDate(readQueryParameter('salesTo')),receivable:readQueryParameter('salesReceivable',{allowedValues:receivableValues})??'',verification:readQueryParameter('salesVerification',{allowedValues:verificationValues})??''});

export function Sales({canView,canManage,canCreate=false,canEdit=false,onCreateDocument,onEditDocument,onUnauthorized}:{canView:boolean;canManage:boolean;canCreate?:boolean;canEdit?:boolean;onCreateDocument?:()=>void;onEditDocument?:(documentId:string)=>void;onUnauthorized:()=>void}){
 const{t,i18n}=useTranslation();
 const[data,setData]=useState<Sale[]|null>(null),[selectedId,setSelectedId]=useState<string|null>(null),[filters,setFilters]=useState<DiscoveryFilters>(readFilters),[error,setError]=useState(false);
 const load=async()=>{const response=await fetch('/api/sales');if(response.status===401){onUnauthorized();return;}if(!response.ok)throw Error();const next=(await response.json() as {sales:Sale[]}).sales;setData(next);setSelectedId(old=>old&&next.some(item=>item.id===old)?old:null)};
 useEffect(()=>{if(canView)void load().catch(()=>setError(true))},[canView]);
 useEffect(()=>{const restore=()=>setFilters(readFilters());window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore)},[]);
 const customers=useMemo(()=>Array.from(new Map((data??[]).filter(x=>x.counterparty_id).map(x=>[x.counterparty_id!,x.customer_name??t('sales.unknown')])).entries()),[data,t]);
 useEffect(()=>{if(data&&filters.customer&&!data.some(x=>x.counterparty_id===filters.customer))setFilters(current=>({...current,customer:''}))},[data,filters.customer]);
 const updateFilter=(name:keyof DiscoveryFilters,value:string)=>{setFilters(current=>({...current,[name]:value}));const parameter={search:'salesSearch',customer:'salesCustomer',financial:'salesFinancial',review:'salesReview',from:'salesFrom',to:'salesTo',receivable:'salesReceivable',verification:'salesVerification'}[name];writeQueryParameters({[parameter]:value||null},name==='search'?'replace':'push')};
 const clearFilters=()=>{setFilters({search:'',customer:'',financial:'',review:'',from:'',to:'',receivable:'',verification:''});clearQueryParameters(filterParameters)};
 const rows=useMemo(()=>{const q=filters.search.trim().toLocaleLowerCase();return(data??[]).filter(x=>(!q||[x.reference_number,x.original_filename,x.customer_name,x.intake_note].some(v=>v?.toLocaleLowerCase().includes(q)))&&(!filters.customer||x.counterparty_id===filters.customer)&&(!filters.financial||x.financial_state===filters.financial)&&(!filters.review||x.status===filters.review)&&(!filters.from||(x.document_date!==null&&x.document_date>=filters.from))&&(!filters.to||(x.document_date!==null&&x.document_date<=filters.to))&&(!filters.receivable||x.receivable_relationship===filters.receivable)&&(!filters.verification||x.verification_status===filters.verification))},[data,filters]);
 const create=async(sale:Sale)=>{const response=await fetch('/api/obligations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({direction:'receivable',counterparty_id:sale.counterparty_id,document_id:sale.id,original_amount:sale.total_amount,recognized_on:sale.document_date,due_on:null,verification_status:'unconfirmed',source_type:'document',source_note:null})});if(response.status===401){onUnauthorized();return;}if(!response.ok){setError(true);return;}await load()};
 if(!canView)return <WorkspacePage><WorkspaceState>{t('sales.noAccess')}</WorkspaceState></WorkspacePage>;
 const roleLabel=(type:CounterpartyType|null)=>type?(i18n.language==='ar'?({customer:'عميل',supplier:'مورد',government:'جهة حكومية',other:'أخرى'} as const)[type]:({customer:'Customer',supplier:'Supplier',government:'Government',other:'Other'} as const)[type]):'—';
 const integrityIssue=(sale:Sale)=>!!sale.counterparty_id&&sale.counterparty_type!==null&&sale.counterparty_type!=='customer';
 const eligible=(sale:Sale)=>canManage&&sale.receivable_relationship==='not_created'&&sale.status==='approved'&&!!sale.counterparty_id&&sale.counterparty_type==='customer'&&!!sale.document_date&&!!sale.total_amount;
 const editable=(sale:Sale)=>canEdit&&sale.status==='uploaded'&&!!onEditDocument;
 const toggle=(id:string)=>setSelectedId(current=>current===id?null:id);
 const financialStatus=(sale:Sale)=>sale.receivable_cancelled?<StatusBadge status="cancelled">{t('sales.cancelled')}</StatusBadge>:sale.financial_state?<StatusBadge status={sale.financial_state}>{t(`sales.${sale.financial_state}`)}</StatusBadge>:'—';
 const addAction=canCreate&&onCreateDocument?<button className="primary" onClick={onCreateDocument}>+ {t('documents.intake.types.sale')}</button>:undefined;
 const editLabel=i18n.language==='ar'?'تعديل':'Edit';
 const integrityWarning=i18n.language==='ar'?'تنبيه سلامة البيانات: مستند البيع مرتبط بطرف ليس من نوع عميل. صحح الطرف المقابل قبل إنشاء الذمم المدينة.':'Data integrity warning: this sale is linked to a non-customer counterparty. Correct the counterparty before creating a receivable.';
 const detail=(sale:Sale)=><section className="sales-detail" aria-label={t('sales.detail')}>
  {integrityIssue(sale)&&<WorkspaceState tone="error">{integrityWarning}</WorkspaceState>}
  <dl className="sales-detail__facts">
   <div><dt>{integrityIssue(sale)?roleLabel(sale.counterparty_type):t('sales.customer')}</dt><dd>{sale.customer_name??t('sales.unknown')} {sale.counterparty_type&&<small>({roleLabel(sale.counterparty_type)})</small>}</dd></div>
   <div><dt>{t('sales.reference')}</dt><dd>{sale.reference_number??sale.original_filename}</dd></div>
   <div><dt>{t('sales.financialState')}</dt><dd>{financialStatus(sale)}</dd></div>
   <div><dt>{t('sales.total')}</dt><dd className="sales-amount">{sale.total_amount??'—'}</dd></div>
   <div><dt>{t('sales.collected')}</dt><dd className="sales-amount">{sale.collected_amount}</dd></div>
   <div><dt>{t('sales.remaining')}</dt><dd className="sales-amount">{sale.remaining_amount??'—'}</dd></div>
   <div><dt>{t('sales.due')}</dt><dd>{formatDisplayDate(sale.due_on,i18n.language)}</dd></div>
   <div><dt>{t('sales.reviewState')}</dt><dd>{t(`documents.statuses.${sale.status}`)}</dd></div>
   <div><dt>{t('sales.receivable')}</dt><dd>{t(`sales.${sale.receivable_relationship}`)}</dd></div>
   <div><dt>{t('sales.verificationStatus')}</dt><dd>{sale.verification_status?t(`obligations.${sale.verification_status}`):'—'}</dd></div>
   {sale.receivable_original_amount!=null&&<div><dt>{t('sales.original')}</dt><dd className="sales-amount">{sale.receivable_original_amount}</dd></div>}
   <div><dt>{t('documents.intake.note')}</dt><dd>{sale.intake_note??'—'}</dd></div>
   <div><dt>{t('sales.originalFilename')}</dt><dd>{sale.original_filename}</dd></div>
  </dl>
  <div className="sales-detail__history"><h3>{t('sales.history')}</h3>{sale.settlement_history.length?<ul>{sale.settlement_history.map(item=><li key={item.id}><span>{formatDisplayDate(item.transaction_date,i18n.language)}</span><strong className="sales-amount">{item.amount}</strong><span>{item.description??item.bank_reference??'—'}</span></li>)}</ul>:<p>{t('sales.noCollections')}</p>}</div>
  <div className="sales-detail__actions"><a className="button-link" href={`/api/documents/${sale.id}/file`} target="_blank" rel="noreferrer">{t('sales.openDocument')}</a>{editable(sale)&&<button type="button" onClick={()=>onEditDocument?.(sale.id)}>{editLabel}</button>}{eligible(sale)&&<button className="primary" onClick={()=>void create(sale)}>{t('sales.createReceivable')}</button>}</div>
 </section>;
 return <WorkspacePage labelledBy="sales-title" className="sales-workspace"><PageHeader titleId="sales-title" eyebrow={t('sales.title')} title={t('sales.title')} description={t('sales.description')} action={addAction}/>{error&&<WorkspaceState tone="error" action={<button onClick={()=>void load()}>{t('common.retry')}</button>}>{t('sales.error')}</WorkspaceState>}{!data?<WorkspaceState>{t('common.loading')}</WorkspaceState>:data.length===0?<WorkspaceState kind="empty" action={addAction}>{t('sales.empty')}</WorkspaceState>:<div className="shared-workspace-page__content"><WorkspaceToolbar ariaLabel={t('sales.discoveryToolbar')} search={<label>{t('sales.search')}<input type="search" value={filters.search} onChange={e=>updateFilter('search',e.target.value)} placeholder={t('sales.searchPlaceholder')}/></label>} filters={<>
<label>{t('sales.customer')}<select value={filters.customer} onChange={e=>updateFilter('customer',e.target.value)}><option value="">{t('sales.all')}</option>{customers.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
<label>{t('sales.financialState')}<select value={filters.financial} onChange={e=>updateFilter('financial',e.target.value)}><option value="">{t('sales.all')}</option>{financialValues.map(x=><option key={x} value={x}>{t(`sales.${x}`)}</option>)}</select></label>
<label>{t('sales.reviewState')}<select value={filters.review} onChange={e=>updateFilter('review',e.target.value)}><option value="">{t('sales.all')}</option>{reviewValues.map(x=><option key={x} value={x}>{t(`documents.statuses.${x}`)}</option>)}</select></label>
<label>{t('sales.from')}<input type="date" value={filters.from} onChange={e=>updateFilter('from',e.target.value)}/></label><label>{t('sales.to')}<input type="date" value={filters.to} onChange={e=>updateFilter('to',e.target.value)}/></label>
<label>{t('sales.receivable')}<select value={filters.receivable} onChange={e=>updateFilter('receivable',e.target.value)}><option value="">{t('sales.all')}</option>{receivableValues.map(x=><option key={x} value={x}>{t(`sales.${x}`)}</option>)}</select></label>
<label>{t('sales.verificationStatus')}<select value={filters.verification} onChange={e=>updateFilter('verification',e.target.value)}><option value="">{t('sales.all')}</option>{verificationValues.map(x=><option key={x} value={x}>{t(`obligations.${x}`)}</option>)}</select></label>
</>} resultCount={t('sales.resultCount',{count:rows.length})} clearAction={Object.values(filters).some(Boolean)?<button onClick={clearFilters}>{t('sales.clearFilters')}</button>:undefined}/><DataWorkspace className="sales-data-workspace"><div className="sales-table-wrap"><table className="sales-table"><thead><tr>{['customer','reference','date','total','collection','financialState','reviewState'].map(x=><th key={x}>{t(`sales.${x}`)}</th>)}</tr></thead><tbody>{rows.map(s=>{const expanded=selectedId===s.id;return <Fragment key={s.id}><tr className="sales-summary-row" tabIndex={0} aria-selected={expanded} aria-expanded={expanded} onClick={()=>toggle(s.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle(s.id)}}}>
  <td data-label={t('sales.customer')}><strong>{s.customer_name??t('sales.unknown')}</strong>{s.counterparty_type&&<small>{roleLabel(s.counterparty_type)}{integrityIssue(s)?' ⚠':''}</small>}<span className="sales-mobile-financial">{financialStatus(s)}</span></td>
  <td data-label={t('sales.reference')}>{s.reference_number??s.original_filename}</td>
  <td data-label={t('sales.date')} className="sales-nowrap">{formatDisplayDate(s.document_date,i18n.language)}</td>
  <td data-label={t('sales.total')} className="sales-amount sales-nowrap">{s.total_amount??'—'}</td>
  <td data-label={t('sales.collection')}><strong className="sales-amount sales-nowrap">{s.collected_amount}</strong><small>{t('sales.remaining')}: <span className="sales-amount sales-nowrap">{s.remaining_amount??'—'}</span></small></td>
  <td data-label={t('sales.financialState')}>{financialStatus(s)}{s.due_on&&<small>{t('sales.due')}: <span className="sales-nowrap">{formatDisplayDate(s.due_on,i18n.language)}</span></small>}</td>
  <td data-label={t('sales.reviewState')}>{t(`documents.statuses.${s.status}`)}</td>
 </tr>{expanded&&<tr className="sales-detail-row"><td colSpan={7}>{detail(s)}</td></tr>}</Fragment>})}</tbody></table>{rows.length===0&&<WorkspaceState kind="no-results">{t('sales.noResults')}</WorkspaceState>}</div></DataWorkspace></div>}</WorkspacePage>;
}
