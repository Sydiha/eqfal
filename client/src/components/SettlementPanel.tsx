import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { transactionOptionLabel } from './bankTransactionLabel';
import { ApiError, parseApiError, screenErrorMessage, toApiError } from '../api/apiError';

type Transaction = { id:string; transaction_date:string; description:string|null; bank_reference:string|null; amount:string; reconciliation_status:'unmatched'|'matched'|'reconciled' };
type CandidateDocument = { id:string; status:string; counterparty_name:string|null; document_date:string|null; reference_number:string|null; total_amount:string|null; original_filename:string; remaining_amount?:string|null; linked_obligation:{remaining_amount:string}|null };
type MatchResponse = { transaction:{id:string;amount:string;reconciliation_status:Transaction['reconciliation_status']}; match:{document_id:string|null}|null; matches?:Array<{document_id:string|null}>; allocated_amount?:string; unallocated_amount?:string; documents?:CandidateDocument[] };
type Settlement = { id:string; bank_transaction_id:string; amount:string; created_at:string; note:string|null; transaction_date:string; transaction_description:string|null; bank_reference:string|null; transaction_amount:string };
type Summary = { document:{id:string;status:string;original_filename:string;total_amount:string|null}; settled_amount:string; remaining_amount:string|null; payment_status:'unpaid'|'partially_paid'|'paid'; settlements:Settlement[] };

type Props = { canView:boolean; canSettle:boolean; onUnauthorized:()=>void };

async function api<T>(url:string,init?:RequestInit,onUnauthorized?:()=>void):Promise<T>{
  const response=await fetch(url,init).catch(e=>{throw toApiError(e);});
  if(response.status===401){onUnauthorized?.();throw new ApiError({status:401});}
  if(!response.ok) throw await parseApiError(response);
  return await response.json().catch(()=>({})) as T;
}

const strings={
  en:{title:'Payment settlements',description:'Record how much of an approved document is settled by an already-matched bank transaction.',transaction:'Matched bank transaction',document:'Document',total:'Total',settled:'Settled',remaining:'Remaining',status:'Payment status',unpaid:'Unpaid',partially_paid:'Partially paid',paid:'Paid',amount:'Settlement amount',note:'Note',create:'Record settlement',history:'Settlement history',none:'No settlement records',delete:'Delete',reason:'Deletion reason',deleteAction:'Delete settlement',error:'Unable to load payment settlements',select:'Select a bank transaction matched to a document',emptyTitle:'No eligible matched transaction yet',emptyHelp:'Match a bank transaction to an approved document first. It will then appear here for settlement.',selectedTitle:'Selected payment',allocateTitle:'Allocate to several documents',allocateHelp:'One bank transaction can settle several approved documents of the same counterparty. Any unallocated amount keeps the transaction open for closing.',bankAmount:'Bank amount',allocated:'Allocated',unallocated:'Unallocated',allocationTotal:'This allocation',allocate:'Save allocations',matchedDocuments:'Allocated documents',noCandidates:'No approved documents are available for this transaction',allocationExceeds:'The allocation exceeds the unallocated amount',docExceeds:'An amount exceeds the document remaining amount',counterparty:'Counterparty',retry:'Retry',actionError:'The change was not saved. Check the entered values and try again; reload the page if the problem continues.',savedRefreshFailed:'The change was saved, but the screen could not be refreshed. Retry to load the latest status; the previous values are hidden because they may be outdated.'},
  ar:{title:'تسويات المدفوعات',description:'تسجيل الجزء المسدد من مستند معتمد بواسطة حركة بنكية تمت مطابقتها مسبقًا.',transaction:'الحركة البنكية المطابقة',document:'المستند',total:'الإجمالي',settled:'المسدد',remaining:'المتبقي',status:'حالة السداد',unpaid:'غير مسدد',partially_paid:'مسدد جزئيًا',paid:'مسدد',amount:'مبلغ التسوية',note:'ملاحظة',create:'تسجيل تسوية',history:'سجل التسويات',none:'لا توجد تسويات',delete:'حذف',reason:'سبب الحذف',deleteAction:'حذف التسوية',error:'تعذر تحميل تسويات المدفوعات',select:'اختر حركة بنكية مطابقة لمستند',emptyTitle:'لا توجد حركة مؤهلة للتسوية حاليًا',emptyHelp:'طابق حركة بنكية مع مستند معتمد أولًا، وبعدها ستظهر هنا لتسجيل التسوية.',selectedTitle:'التسوية المحددة',allocateTitle:'توزيع الحركة على عدة مستندات',allocateHelp:'يمكن لحركة بنكية واحدة أن تسدد عدة مستندات معتمدة لنفس الطرف المقابل. أي مبلغ غير موزع يُبقي الحركة مفتوحة عند الإقفال.',bankAmount:'مبلغ الحركة',allocated:'الموزع',unallocated:'غير الموزع',allocationTotal:'هذا التوزيع',allocate:'حفظ التوزيع',matchedDocuments:'المستندات الموزع عليها',noCandidates:'لا توجد مستندات معتمدة متاحة لهذه الحركة',allocationExceeds:'التوزيع يتجاوز المبلغ غير الموزع',docExceeds:'مبلغ يتجاوز المتبقي من المستند',counterparty:'الطرف المقابل',retry:'إعادة المحاولة',actionError:'لم يتم حفظ التغيير. راجع القيم المدخلة وحاول مجددًا، وأعد تحميل الصفحة إن استمرت المشكلة.',savedRefreshFailed:'تم حفظ التغيير، لكن تعذر تحديث الشاشة. أعد المحاولة لتحميل أحدث حالة؛ أُخفيت القيم السابقة لأنها قد تكون قديمة.'}
};

export function SettlementPanel({canView,canSettle,onUnauthorized}:Props){
  const {t,i18n}=useTranslation(); const s=i18n.language==='ar'?strings.ar:strings.en;
  const [transactions,setTransactions]=useState<Transaction[]>([]); const [selectedTx,setSelectedTx]=useState<string|null>(null); const [documentId,setDocumentId]=useState<string|null>(null); const [summary,setSummary]=useState<Summary|null>(null);
  const [refreshFailed,setRefreshFailed]=useState<'load'|'afterSave'|null>(null); const [listStale,setListStale]=useState(false); const seq=useRef(0);
  const [candidates,setCandidates]=useState<MatchResponse|null>(null); const [allocations,setAllocations]=useState<Record<string,number|string>>({});
  const [amount,setAmount]=useState<number|string>(''); const [note,setNote]=useState(''); const [reason,setReason]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState('');

  const toCents=(v:unknown)=>Math.round(Number(v)*100);
  // Every load gets a ticket; a response whose ticket is no longer current is dropped, and state is committed only after all requests of the load succeeded.
  const load=async(txId:string|null,opts:{list:boolean;afterSave?:boolean})=>{
    const ticket=++seq.current; const live=()=>ticket===seq.current;
    setBusy(true); setError(''); setRefreshFailed(null);
    try{
      const list=opts.list?(await api<{transactions:Transaction[]}>('/api/bank-transactions',undefined,onUnauthorized)).transactions.filter(t=>canSettle||t.reconciliation_status!=='unmatched'):transactions;
      const keep=txId&&list.some(t=>t.id===txId)?txId:null;
      if(!keep){if(!live())return;setListStale(false);setTransactions(list);setSelectedTx(null);setDocumentId(null);setSummary(null);setCandidates(null);setAllocations({});setAmount('');return;}
      const match=await api<MatchResponse>(`/api/bank-transactions/${keep}/match-candidates`,undefined,onUnauthorized);
      const docId=match.match?.document_id??null;
      const data=docId?await api<Summary>(`/api/documents/${docId}/settlements`,undefined,onUnauthorized):null;
      if(!live())return;
      const available=match.unallocated_amount!=null&&match.unallocated_amount!==''?toCents(match.unallocated_amount):NaN;
      const remaining=data&&data.remaining_amount!==null?toCents(data.remaining_amount):NaN;
      const next=Math.min(available,remaining);
      setListStale(false);setTransactions(list);setSelectedTx(keep);setCandidates(match);setDocumentId(docId);setSummary(data);setAllocations({});setAmount(Number.isFinite(next)&&next>0?next/100:'');
      if(!docId&&!canSettle)setError(s.select);
    }catch(e){
      if(!live())return;
      setCandidates(null);setDocumentId(null);setSummary(null);setAllocations({});setAmount('');
      if(opts.list)setListStale(true);
      setRefreshFailed(opts.afterSave?'afterSave':'load');
      setError(opts.afterSave?s.savedRefreshFailed:screenErrorMessage(e,t,s.error));
    }finally{if(live())setBusy(false);}
  };
  useEffect(()=>{if(!canView)return;void load(null,{list:true});return()=>{seq.current++;};},[canView]);
  // After a failed reload the list may be outdated: only the selected transaction stays visible (so retry keeps its id) and nothing else can be picked.
  const options=useMemo(()=>transactions.filter(t=>!listStale||t.id===selectedTx).map(t=>({value:t.id,label:transactionOptionLabel(t)})),[transactions,listStale,selectedTx]);

  const choose=async(value:string|null)=>{setSelectedTx(value);setDocumentId(null);setSummary(null);setCandidates(null);setAllocations({});setAmount('');setError('');setRefreshFailed(null);if(!value){seq.current++;setBusy(false);return;}await load(value,{list:false});};
  const retry=()=>void load(selectedTx,{list:true,afterSave:refreshFailed==='afterSave'});
  const allocationTotal=Object.values(allocations).reduce<number>((n,v)=>n+Math.round(Number(v||0)*100),0);
  const unallocatedCents=Math.round(Number(candidates?.unallocated_amount??0)*100);
  const allocationRows=(candidates?.documents??[]).filter(d=>d.status==='approved'&&!(d.remaining_amount!=null&&toCents(d.remaining_amount)<=0));
  const docOver=allocationRows.some(d=>d.remaining_amount!=null&&Math.round(Number(allocations[d.id]||0)*100)>Math.round(Number(d.remaining_amount)*100));
  // Mutations never retry themselves: after a successful save only the read requests are repeated (see load/retry).
  const mutate=async(request:()=>Promise<unknown>)=>{const txId=selectedTx;setBusy(true);setError('');setRefreshFailed(null);try{await request();}catch(e){setError(screenErrorMessage(e,t,s.actionError));setBusy(false);return;}setNote('');setReason('');await load(txId,{list:true,afterSave:true});};
  const post=(url:string,method:string,body:unknown)=>api(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},onUnauthorized);
  const allocate=async(event:FormEvent)=>{event.preventDefault();if(!selectedTx)return;const rows=Object.entries(allocations).filter(([,v])=>Number(v)>0).map(([document_id,v])=>({document_id,amount:Number(v).toFixed(2)}));if(!rows.length)return;await mutate(()=>post(`/api/bank-transactions/${selectedTx}/allocations`,'POST',{allocations:rows,note:note||undefined}));};
  const create=async(event:FormEvent)=>{event.preventDefault();if(!documentId||!selectedTx||!amount)return;await mutate(()=>post(`/api/documents/${documentId}/settlements`,'POST',{bank_transaction_id:selectedTx,amount:String(amount),note:note||undefined}));};
  const remove=async(id:string)=>{if(!documentId||!reason.trim())return;await mutate(()=>post(`/api/documents/${documentId}/settlements/${id}`,'DELETE',{reason:reason.trim()}));};

  if(!canView)return null;
  return <Card withBorder padding="lg" className="banking-settlement-panel"><Stack gap="lg">
    <div className="banking-section-heading"><Title order={2} size="h3">{s.title}</Title><Text c="dimmed">{s.description}</Text></div>
    {error&&<Alert color={refreshFailed==='afterSave'?'yellow':'red'} role="alert"><Group justify="space-between" align="center" wrap="nowrap"><span>{error}</span>{refreshFailed&&<Button size="compact-sm" variant="default" onClick={retry} loading={busy}>{s.retry}</Button>}</Group></Alert>}
    <div className="banking-operation-card">
      <Select label={s.transaction} placeholder={s.select} data={options} value={selectedTx} onChange={v=>void choose(v)} searchable clearable disabled={busy||listStale}/>
      {transactions.length===0&&!error&&<div className="banking-empty-guidance"><Text fw={700}>{s.emptyTitle}</Text><Text size="sm" c="dimmed">{s.emptyHelp}</Text></div>}
    </div>
    {candidates&&canSettle&&candidates.transaction.reconciliation_status!=='reconciled'&&<div className="banking-selected-operation"><Stack gap="md">
      <div><Title order={3} size="h4">{s.allocateTitle}</Title><Text size="sm" c="dimmed">{s.allocateHelp}</Text></div>
      <div className="banking-metrics-grid">
        <div><span>{s.bankAmount}</span><strong dir="ltr">{candidates.transaction.amount}</strong></div>
        <div><span>{s.allocated}</span><strong dir="ltr">{candidates.allocated_amount??'0.00'}</strong></div>
        <div><span>{s.unallocated}</span><strong dir="ltr">{candidates.unallocated_amount??'—'}</strong></div>
        <div><span>{s.matchedDocuments}</span><strong dir="ltr">{candidates.matches?.length??0}</strong></div>
      </div>
      {unallocatedCents>0&&(allocationRows.length===0?<Text c="dimmed">{s.noCandidates}</Text>:<form onSubmit={allocate}><Stack gap="sm">
        <Table.ScrollContainer minWidth={640} className="settlement-scroll"><Table className="settlement-stack settlement-stack--alloc"><Table.Thead><Table.Tr><Table.Th>{s.document}</Table.Th><Table.Th>{s.counterparty}</Table.Th><Table.Th>{s.remaining}</Table.Th><Table.Th>{s.amount}</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{allocationRows.map(d=><Table.Tr key={d.id}><Table.Td data-label={s.document}><Text dir="auto" size="sm">{d.original_filename}</Text></Table.Td><Table.Td data-label={s.counterparty}><Text dir="auto" size="sm">{d.counterparty_name||'—'}</Text></Table.Td><Table.Td dir="ltr" data-label={s.remaining}>{d.remaining_amount??d.linked_obligation?.remaining_amount??d.total_amount??'—'}</Table.Td><Table.Td data-label={s.amount}><NumberInput aria-label={`${s.amount} ${d.original_filename}`} value={allocations[d.id]??''} onChange={v=>setAllocations(a=>({...a,[d.id]:v}))} min={0} max={d.remaining_amount!=null?Number(d.remaining_amount):undefined} clampBehavior="none" decimalScale={2} disabled={busy}/></Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>
        {allocationTotal>unallocatedCents&&<Alert color="red">{s.allocationExceeds}</Alert>}
        {docOver&&<Alert color="red">{s.docExceeds}</Alert>}
        <Group align="end" grow className="settlement-form-row"><div><Text size="sm" c="dimmed">{s.allocationTotal}</Text><Text fw={700} dir="ltr">{(allocationTotal/100).toFixed(2)}</Text></div><TextInput label={s.note} value={note} onChange={e=>setNote(e.currentTarget.value)} maxLength={500}/><Button type="submit" loading={busy} disabled={docOver||allocationTotal<=0||allocationTotal>unallocatedCents}>{s.allocate}</Button></Group>
      </Stack></form>)}
    </Stack></div>}
    {summary&&<div className="banking-selected-operation"><Stack gap="md">
      <Text fw={700}>{s.selectedTitle}</Text>
      <div className="banking-metrics-grid">
        <div><span>{s.document}</span><strong><bdi dir="ltr">{summary.document.original_filename}</bdi></strong></div>
        <div><span>{s.status}</span><strong>{s[summary.payment_status]}</strong></div>
        <div><span>{s.total}</span><strong dir="ltr">{summary.document.total_amount??'—'}</strong></div>
        <div><span>{s.settled}</span><strong dir="ltr">{summary.settled_amount}</strong></div>
        <div><span>{s.remaining}</span><strong dir="ltr">{summary.remaining_amount??'—'}</strong></div>
      </div>
      {canSettle&&summary.document.status==='approved'&&summary.remaining_amount!==null&&Number(summary.remaining_amount)>0&&<form onSubmit={create} className="banking-inline-form"><Group align="end" grow className="settlement-form-row"><NumberInput label={s.amount} value={amount} onChange={setAmount} min={0.01} decimalScale={2} required/><TextInput label={s.note} value={note} onChange={e=>setNote(e.currentTarget.value)} maxLength={500}/><Button type="submit" loading={busy}>{s.create}</Button></Group></form>}
      <div className="banking-subsection"><Title order={3} size="h4">{s.history}</Title>
        {summary.settlements.length===0?<Text c="dimmed">{s.none}</Text>:<Table.ScrollContainer minWidth={700} className="settlement-scroll"><Table className="settlement-stack settlement-stack--history"><Table.Thead><Table.Tr><Table.Th>{s.transaction}</Table.Th><Table.Th>{s.amount}</Table.Th><Table.Th>{s.note}</Table.Th>{canSettle&&<Table.Th>{s.delete}</Table.Th>}</Table.Tr></Table.Thead><Table.Tbody>{summary.settlements.map(x=><Table.Tr key={x.id}><Table.Td data-label={s.transaction}><span>{x.transaction_date} · <bdi>{x.transaction_description||x.bank_reference||x.bank_transaction_id}</bdi></span></Table.Td><Table.Td data-label={s.amount}>{x.amount}</Table.Td><Table.Td dir="auto" data-label={s.note}>{x.note||'—'}</Table.Td>{canSettle&&<Table.Td data-label={s.delete}><Group align="end" className="settlement-delete-row"><TextInput aria-label={s.reason} placeholder={s.reason} value={reason} onChange={e=>setReason(e.currentTarget.value)} maxLength={500}/><Button color="red" variant="light" onClick={()=>void remove(x.id)} disabled={!reason.trim()} loading={busy}>{s.deleteAction}</Button></Group></Table.Td>}</Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>}
      </div>
    </Stack></div>}
  </Stack></Card>;
}
