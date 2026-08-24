import {Fragment,useEffect,useMemo,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {formatDisplayDate} from '../date-format';
import {DataWorkspace,PageHeader,StatusBadge,WorkspacePage,WorkspaceState,WorkspaceToolbar} from './SharedUI';
import './purchases.css';

type Settlement={id:string;amount:string;transaction_date:string;description:string|null;bank_reference:string|null};
type Purchase={id:string;document_type:'purchase'|'expense';original_filename:string;status:string;document_date:string|null;reference_number:string|null;total_amount:string|null;counterparty_id:string|null;supplier_name:string|null;payable_id:string|null;payable_original_amount:string|null;due_on:string|null;verification_status:string|null;payable_cancelled:boolean;payable_relationship:'not_created'|'linked_active'|'linked_cancelled';paid_amount:string;remaining_amount:string|null;financial_state:'open'|'partial'|'paid'|'overdue'|null;settlement_history:Settlement[];vat_review_status:'missing'|'pending'|'reviewed';tax_date:string|null;vat_treatment:string|null;taxable_amount:string|null;vat_amount:string|null};

export function Purchases({canView,canManage,onUnauthorized}:{canView:boolean;canManage:boolean;onUnauthorized:()=>void}){
 const{t,i18n}=useTranslation();
 const[data,setData]=useState<Purchase[]|null>(null),[selectedId,setSelectedId]=useState<string|null>(null),[search,setSearch]=useState(''),[supplier,setSupplier]=useState(''),[financial,setFinancial]=useState(''),[review,setReview]=useState(''),[error,setError]=useState(false);
 const load=async()=>{const response=await fetch('/api/purchases');if(response.status===401){onUnauthorized();return;}if(!response.ok)throw Error();const next=(await response.json() as {purchases:Purchase[]}).purchases;setData(next);setSelectedId(old=>old&&next.some(item=>item.id===old)?old:null)};
 useEffect(()=>{if(canView)void load().catch(()=>setError(true))},[canView]);
 const suppliers=useMemo(()=>Array.from(new Map((data??[]).filter(x=>x.counterparty_id).map(x=>[x.counterparty_id!,x.supplier_name??t('purchases.unknown')])).entries()),[data,t]);
 const rows=useMemo(()=>{const q=search.trim().toLocaleLowerCase();return(data??[]).filter(x=>(!q||[x.reference_number,x.original_filename,x.supplier_name].some(v=>v?.toLocaleLowerCase().includes(q)))&&(!supplier||x.counterparty_id===supplier)&&(!financial||x.financial_state===financial)&&(!review||x.status===review))},[data,search,supplier,financial,review]);
 const create=async(purchase:Purchase)=>{const response=await fetch('/api/obligations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({direction:'payable',counterparty_id:purchase.counterparty_id,document_id:purchase.id,original_amount:purchase.total_amount,recognized_on:purchase.document_date,due_on:null,verification_status:'unconfirmed',source_type:'document',source_note:null})});if(response.status===401){onUnauthorized();return;}if(!response.ok){setError(true);return;}await load()};
 if(!canView)return <WorkspacePage><WorkspaceState>{t('purchases.noAccess')}</WorkspaceState></WorkspacePage>;
 const eligible=(purchase:Purchase)=>canManage&&purchase.payable_relationship==='not_created'&&purchase.status==='approved'&&!!purchase.counterparty_id&&!!purchase.document_date&&!!purchase.total_amount;
 const toggle=(id:string)=>setSelectedId(current=>current===id?null:id);
 const financialStatus=(purchase:Purchase)=>purchase.payable_cancelled?<StatusBadge status="cancelled">{t('purchases.cancelled')}</StatusBadge>:purchase.financial_state?<StatusBadge status={purchase.financial_state}>{t(`purchases.${purchase.financial_state}`)}</StatusBadge>:'—';
 const detail=(purchase:Purchase)=><section className="purchases-detail" aria-label={t('purchases.detail')}>
  <dl className="purchases-detail__facts">
   <div><dt>{t('purchases.supplier')}</dt><dd>{purchase.supplier_name??t('purchases.unknown')}</dd></div>
   <div><dt>{t('purchases.type')}</dt><dd>{t(`purchases.${purchase.document_type}`)}</dd></div>
   <div><dt>{t('purchases.reference')}</dt><dd>{purchase.reference_number??purchase.original_filename}</dd></div>
   <div><dt>{t('purchases.financialState')}</dt><dd>{financialStatus(purchase)}</dd></div>
   <div><dt>{t('purchases.total')}</dt><dd className="purchases-amount">{purchase.total_amount??'—'}</dd></div>
   <div><dt>{t('purchases.paidAmount')}</dt><dd className="purchases-amount">{purchase.paid_amount}</dd></div>
   <div><dt>{t('purchases.remaining')}</dt><dd className="purchases-amount">{purchase.remaining_amount??'—'}</dd></div>
   <div><dt>{t('purchases.due')}</dt><dd>{formatDisplayDate(purchase.due_on,i18n.language)}</dd></div>
   <div><dt>{t('purchases.reviewState')}</dt><dd>{t(`documents.statuses.${purchase.status}`)}</dd></div>
   <div><dt>{t('purchases.payable')}</dt><dd>{t(`purchases.${purchase.payable_relationship}`)}</dd></div>
   <div><dt>{t('purchases.verificationStatus')}</dt><dd>{purchase.verification_status?t(`obligations.${purchase.verification_status}`):'—'}</dd></div>
   {purchase.payable_original_amount!=null&&<div><dt>{t('purchases.original')}</dt><dd className="purchases-amount">{purchase.payable_original_amount}</dd></div>}
   <div><dt>{t('purchases.originalFilename')}</dt><dd>{purchase.original_filename}</dd></div>
   <div><dt>{t('purchases.vatReview')}</dt><dd>{t(`purchases.vat_${purchase.vat_review_status}`)}</dd></div>
   <div><dt>{t('purchases.taxDate')}</dt><dd>{formatDisplayDate(purchase.tax_date,i18n.language)}</dd></div>
   <div><dt>{t('purchases.vatTreatment')}</dt><dd>{purchase.vat_treatment?t(`purchases.treatment_${purchase.vat_treatment}`):'—'}</dd></div>
   <div><dt>{t('purchases.taxableAmount')}</dt><dd className="purchases-amount">{purchase.taxable_amount??'—'}</dd></div>
   <div><dt>{t('purchases.inputVat')}</dt><dd className="purchases-amount">{purchase.vat_amount??'—'}</dd></div>
  </dl>
  <div className="purchases-detail__history"><h3>{t('purchases.history')}</h3>{purchase.settlement_history.length?<ul>{purchase.settlement_history.map(item=><li key={item.id}><span>{formatDisplayDate(item.transaction_date,i18n.language)}</span><strong className="purchases-amount">{item.amount}</strong><span>{item.description??item.bank_reference??'—'}</span></li>)}</ul>:<p>{t('purchases.noPayments')}</p>}</div>
  <div className="purchases-detail__actions"><a className="button-link" href={`/api/documents/${purchase.id}/file`} target="_blank" rel="noreferrer">{t('purchases.openDocument')}</a>{eligible(purchase)&&<button className="primary" onClick={()=>void create(purchase)}>{t('purchases.createPayable')}</button>}</div>
 </section>;
 return <WorkspacePage labelledBy="purchases-title" className="purchases-workspace"><PageHeader titleId="purchases-title" eyebrow={t('purchases.title')} title={t('purchases.title')} description={t('purchases.description')}/>{error&&<WorkspaceState tone="error" action={<button onClick={()=>void load()}>{t('common.retry')}</button>}>{t('purchases.error')}</WorkspaceState>}{!data?<WorkspaceState>{t('common.loading')}</WorkspaceState>:<div className="shared-workspace-page__content"><WorkspaceToolbar search={<label>{t('purchases.search')}<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder={t('purchases.searchPlaceholder')}/></label>} filters={<><label>{t('purchases.supplier')}<select value={supplier} onChange={e=>setSupplier(e.target.value)}><option value="">{t('purchases.all')}</option>{suppliers.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>{t('purchases.financialState')}<select value={financial} onChange={e=>setFinancial(e.target.value)}><option value="">{t('purchases.all')}</option>{['open','partial','paid','overdue'].map(x=><option key={x} value={x}>{t(`purchases.${x}`)}</option>)}</select></label><label>{t('purchases.reviewState')}<select value={review} onChange={e=>setReview(e.target.value)}><option value="">{t('purchases.all')}</option>{['uploaded','needs_review','approved','incomplete','rejected'].map(x=><option key={x} value={x}>{t(`documents.statuses.${x}`)}</option>)}</select></label></>} resultCount={t('purchases.resultCount',{count:rows.length})} clearAction={(search||supplier||financial||review)?<button onClick={()=>{setSearch('');setSupplier('');setFinancial('');setReview('')}}>{t('purchases.clearFilters')}</button>:undefined}/><DataWorkspace className="purchases-data-workspace"><div className="purchases-table-wrap"><table className="purchases-table"><thead><tr>{['supplier','reference','date','total','payment','financialState','reviewState'].map(x=><th key={x}>{t(`purchases.${x}`)}</th>)}</tr></thead><tbody>{rows.map(s=>{const expanded=selectedId===s.id;return <Fragment key={s.id}><tr className="purchases-summary-row" tabIndex={0} aria-selected={expanded} aria-expanded={expanded} onClick={()=>toggle(s.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle(s.id)}}}>
  <td data-label={t('purchases.supplier')}><span><strong>{s.supplier_name??t('purchases.unknown')}</strong> <span className="purchases-type-badge">{t(`purchases.${s.document_type}`)}</span></span><span className="purchases-mobile-financial">{financialStatus(s)}</span></td>
  <td data-label={t('purchases.reference')}>{s.reference_number??s.original_filename}</td>
  <td data-label={t('purchases.date')} className="purchases-nowrap">{formatDisplayDate(s.document_date,i18n.language)}{s.due_on&&<small className="purchases-mobile-due">{t('purchases.due')}: {formatDisplayDate(s.due_on,i18n.language)}</small>}</td>
  <td data-label={t('purchases.total')} className="purchases-amount purchases-nowrap">{s.total_amount??'—'}</td>
  <td data-label={t('purchases.payment')}><strong className="purchases-amount purchases-nowrap">{s.paid_amount}</strong><small>{t('purchases.remaining')}: <span className="purchases-amount purchases-nowrap">{s.remaining_amount??'—'}</span></small></td>
  <td data-label={t('purchases.financialState')}>{financialStatus(s)}{s.due_on&&<small>{t('purchases.due')}: <span className="purchases-nowrap">{formatDisplayDate(s.due_on,i18n.language)}</span></small>}</td>
  <td data-label={t('purchases.reviewState')}>{t(`documents.statuses.${s.status}`)}</td>
 </tr>{expanded&&<tr className="purchases-detail-row"><td colSpan={7}>{detail(s)}</td></tr>}</Fragment>})}</tbody></table>{rows.length===0&&<WorkspaceState>{t('purchases.noResults')}</WorkspaceState>}</div></DataWorkspace></div>}</WorkspacePage>;
}
