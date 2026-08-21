import {Fragment,useEffect,useMemo,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {formatDisplayDate} from '../date-format';
import {DataWorkspace,PageHeader,StatusBadge,WorkspacePage,WorkspaceState,WorkspaceToolbar} from './SharedUI';
import './sales.css';

type Settlement={id:string;amount:string;transaction_date:string;description:string|null;bank_reference:string|null};
type Sale={id:string;original_filename:string;status:string;document_date:string|null;reference_number:string|null;total_amount:string|null;counterparty_id:string|null;customer_name:string|null;receivable_id:string|null;receivable_original_amount:string|null;due_on:string|null;verification_status:string|null;receivable_cancelled:boolean;receivable_relationship:'not_created'|'linked_active'|'linked_cancelled';collected_amount:string;remaining_amount:string|null;financial_state:'open'|'partial'|'paid'|'overdue'|null;settlement_history:Settlement[]};

export function Sales({canView,canManage,onUnauthorized}:{canView:boolean;canManage:boolean;onUnauthorized:()=>void}){
 const{t,i18n}=useTranslation();
 const[data,setData]=useState<Sale[]|null>(null),[selectedId,setSelectedId]=useState<string|null>(null),[search,setSearch]=useState(''),[customer,setCustomer]=useState(''),[financial,setFinancial]=useState(''),[review,setReview]=useState(''),[error,setError]=useState(false);
 const load=async()=>{const response=await fetch('/api/sales');if(response.status===401){onUnauthorized();return;}if(!response.ok)throw Error();const next=(await response.json() as {sales:Sale[]}).sales;setData(next);setSelectedId(old=>old&&next.some(item=>item.id===old)?old:null)};
 useEffect(()=>{if(canView)void load().catch(()=>setError(true))},[canView]);
 const customers=useMemo(()=>Array.from(new Map((data??[]).filter(x=>x.counterparty_id).map(x=>[x.counterparty_id!,x.customer_name??t('sales.unknown')])).entries()),[data,t]);
 const rows=useMemo(()=>{const q=search.trim().toLocaleLowerCase();return(data??[]).filter(x=>(!q||[x.reference_number,x.original_filename,x.customer_name].some(v=>v?.toLocaleLowerCase().includes(q)))&&(!customer||x.counterparty_id===customer)&&(!financial||x.financial_state===financial)&&(!review||x.status===review))},[data,search,customer,financial,review]);
 const create=async(sale:Sale)=>{const response=await fetch('/api/obligations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({direction:'receivable',counterparty_id:sale.counterparty_id,document_id:sale.id,original_amount:sale.total_amount,recognized_on:sale.document_date,due_on:null,verification_status:'unconfirmed',source_type:'document',source_note:null})});if(response.status===401){onUnauthorized();return;}if(!response.ok){setError(true);return;}await load()};
 if(!canView)return <WorkspacePage><WorkspaceState>{t('sales.noAccess')}</WorkspaceState></WorkspacePage>;
 const eligible=(sale:Sale)=>canManage&&sale.receivable_relationship==='not_created'&&sale.status==='approved'&&!!sale.counterparty_id&&!!sale.document_date&&!!sale.total_amount;
 const toggle=(id:string)=>setSelectedId(current=>current===id?null:id);
 const financialStatus=(sale:Sale)=>sale.receivable_cancelled?<StatusBadge status="cancelled">{t('sales.cancelled')}</StatusBadge>:sale.financial_state?<StatusBadge status={sale.financial_state}>{t(`sales.${sale.financial_state}`)}</StatusBadge>:'—';
 const detail=(sale:Sale)=><section className="sales-detail" aria-label={t('sales.detail')}>
  <dl className="sales-detail__facts">
   <div><dt>{t('sales.customer')}</dt><dd>{sale.customer_name??t('sales.unknown')}</dd></div>
   <div><dt>{t('sales.reference')}</dt><dd>{sale.reference_number??sale.original_filename}</dd></div>
   <div><dt>{t('sales.financialState')}</dt><dd>{financialStatus(sale)}</dd></div>
   <div><dt>{t('sales.total')}</dt><dd className="sales-amount">{sale.total_amount??'—'}</dd></div>
   <div><dt>{t('sales.collected')}</dt><dd className="sales-amount">{sale.collected_amount}</dd></div>
   <div><dt>{t('sales.remaining')}</dt><dd className="sales-amount">{sale.remaining_amount??'—'}</dd></div>
   <div><dt>{t('sales.due')}</dt><dd>{formatDisplayDate(sale.due_on,i18n.language)}</dd></div>
   <div><dt>{t('sales.reviewState')}</dt><dd>{t(`documents.statuses.${sale.status}`)}</dd></div>
   <div><dt>{t('sales.receivable')}</dt><dd>{t(`sales.${sale.receivable_relationship}`)}</dd></div>
   <div><dt>{t('sales.verificationStatus')}</dt><dd>{sale.verification_status??'—'}</dd></div>
   {sale.receivable_original_amount!=null&&<div><dt>{t('sales.original')}</dt><dd className="sales-amount">{sale.receivable_original_amount}</dd></div>}
   <div><dt>{t('sales.originalFilename')}</dt><dd>{sale.original_filename}</dd></div>
  </dl>
  <div className="sales-detail__history"><h3>{t('sales.history')}</h3>{sale.settlement_history.length?<ul>{sale.settlement_history.map(item=><li key={item.id}><span>{formatDisplayDate(item.transaction_date,i18n.language)}</span><strong className="sales-amount">{item.amount}</strong><span>{item.description??item.bank_reference??'—'}</span></li>)}</ul>:<p>{t('sales.noCollections')}</p>}</div>
  <div className="sales-detail__actions"><a className="button-link" href={`/api/documents/${sale.id}/file`} target="_blank" rel="noreferrer">{t('sales.openDocument')}</a>{eligible(sale)&&<button className="primary" onClick={()=>void create(sale)}>{t('sales.createReceivable')}</button>}</div>
 </section>;
 return <WorkspacePage labelledBy="sales-title" className="sales-workspace"><PageHeader titleId="sales-title" eyebrow={t('sales.title')} title={t('sales.title')} description={t('sales.description')}/>{error&&<WorkspaceState tone="error" action={<button onClick={()=>void load()}>{t('common.retry')}</button>}>{t('sales.error')}</WorkspaceState>}{!data?<WorkspaceState>{t('common.loading')}</WorkspaceState>:<div className="shared-workspace-page__content"><WorkspaceToolbar search={<label>{t('sales.search')}<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder={t('sales.searchPlaceholder')}/></label>} filters={<><label>{t('sales.customer')}<select value={customer} onChange={e=>setCustomer(e.target.value)}><option value="">{t('sales.all')}</option>{customers.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>{t('sales.financialState')}<select value={financial} onChange={e=>setFinancial(e.target.value)}><option value="">{t('sales.all')}</option>{['open','partial','paid','overdue'].map(x=><option key={x} value={x}>{t(`sales.${x}`)}</option>)}</select></label><label>{t('sales.reviewState')}<select value={review} onChange={e=>setReview(e.target.value)}><option value="">{t('sales.all')}</option>{['uploaded','needs_review','approved','incomplete','rejected'].map(x=><option key={x} value={x}>{t(`documents.statuses.${x}`)}</option>)}</select></label></>} resultCount={t('sales.resultCount',{count:rows.length})} clearAction={(search||customer||financial||review)?<button onClick={()=>{setSearch('');setCustomer('');setFinancial('');setReview('')}}>{t('sales.clearFilters')}</button>:undefined}/><DataWorkspace className="sales-data-workspace"><div className="sales-table-wrap"><table className="sales-table"><thead><tr>{['customer','reference','date','total','collection','financialState','reviewState'].map(x=><th key={x}>{t(`sales.${x}`)}</th>)}</tr></thead><tbody>{rows.map(s=>{const expanded=selectedId===s.id;return <Fragment key={s.id}><tr className="sales-summary-row" tabIndex={0} aria-selected={expanded} aria-expanded={expanded} onClick={()=>toggle(s.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle(s.id)}}}>
  <td data-label={t('sales.customer')}><strong>{s.customer_name??t('sales.unknown')}</strong><span className="sales-mobile-financial">{financialStatus(s)}</span></td>
  <td data-label={t('sales.reference')}>{s.reference_number??s.original_filename}</td>
  <td data-label={t('sales.date')} className="sales-nowrap">{formatDisplayDate(s.document_date,i18n.language)}</td>
  <td data-label={t('sales.total')} className="sales-amount sales-nowrap">{s.total_amount??'—'}</td>
  <td data-label={t('sales.collection')}><strong className="sales-amount sales-nowrap">{s.collected_amount}</strong><small>{t('sales.remaining')}: <span className="sales-amount sales-nowrap">{s.remaining_amount??'—'}</span></small></td>
  <td data-label={t('sales.financialState')}>{financialStatus(s)}{s.due_on&&<small>{t('sales.due')}: <span className="sales-nowrap">{formatDisplayDate(s.due_on,i18n.language)}</span></small>}</td>
  <td data-label={t('sales.reviewState')}>{t(`documents.statuses.${s.status}`)}</td>
 </tr>{expanded&&<tr className="sales-detail-row"><td colSpan={7}>{detail(s)}</td></tr>}</Fragment>})}</tbody></table>{rows.length===0&&<WorkspaceState>{t('sales.noResults')}</WorkspaceState>}</div></DataWorkspace></div>}</WorkspacePage>;
}
