import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';

type Transaction = { id:string; transaction_date:string; description:string|null; bank_reference:string|null; amount:string; reconciliation_status:'unmatched'|'matched'|'reconciled' };
type CandidateDocument = { id:string; status:string; counterparty_name:string|null; document_date:string|null; reference_number:string|null; total_amount:string|null; original_filename:string; linked_obligation:{remaining_amount:string}|null };
type MatchResponse = { transaction:{id:string;amount:string;reconciliation_status:Transaction['reconciliation_status']}; match:{document_id:string|null}|null; matches?:Array<{document_id:string|null}>; allocated_amount?:string; unallocated_amount?:string; documents?:CandidateDocument[] };
type Settlement = { id:string; bank_transaction_id:string; amount:string; created_at:string; note:string|null; transaction_date:string; transaction_description:string|null; bank_reference:string|null; transaction_amount:string };
type Summary = { document:{id:string;status:string;original_filename:string;total_amount:string|null}; settled_amount:string; remaining_amount:string|null; payment_status:'unpaid'|'partially_paid'|'paid'; settlements:Settlement[] };

type Props = { canView:boolean; canSettle:boolean; onUnauthorized:()=>void };

async function api<T>(url:string,init?:RequestInit,onUnauthorized?:()=>void):Promise<T>{
  const response=await fetch(url,init);
  if(response.status===401){onUnauthorized?.();throw new Error('unauthorized');}
  const body=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(typeof body.error==='string'?body.error:`HTTP ${response.status}`);
  return body as T;
}

const strings={
  en:{title:'Payment settlements',description:'Record how much of an approved document is settled by an already-matched bank transaction.',transaction:'Matched bank transaction',document:'Document',total:'Total',settled:'Settled',remaining:'Remaining',status:'Payment status',unpaid:'Unpaid',partially_paid:'Partially paid',paid:'Paid',amount:'Settlement amount',note:'Note',create:'Record settlement',history:'Settlement history',none:'No settlement records',delete:'Delete',reason:'Deletion reason',deleteAction:'Delete settlement',error:'Unable to load payment settlements',select:'Select a bank transaction matched to a document',emptyTitle:'No eligible matched transaction yet',emptyHelp:'Match a bank transaction to an approved document first. It will then appear here for settlement.',selectedTitle:'Selected payment',allocateTitle:'Allocate to several documents',allocateHelp:'One bank transaction can settle several approved documents of the same counterparty. Any unallocated amount keeps the transaction open for closing.',bankAmount:'Bank amount',allocated:'Allocated',unallocated:'Unallocated',allocationTotal:'This allocation',allocate:'Save allocations',matchedDocuments:'Allocated documents',noCandidates:'No approved documents are available for this transaction',allocationExceeds:'The allocation exceeds the unallocated amount',counterparty:'Counterparty'},
  ar:{title:'تسويات المدفوعات',description:'تسجيل الجزء المسدد من مستند معتمد بواسطة حركة بنكية تمت مطابقتها مسبقًا.',transaction:'الحركة البنكية المطابقة',document:'المستند',total:'الإجمالي',settled:'المسدد',remaining:'المتبقي',status:'حالة السداد',unpaid:'غير مسدد',partially_paid:'مسدد جزئيًا',paid:'مسدد',amount:'مبلغ التسوية',note:'ملاحظة',create:'تسجيل تسوية',history:'سجل التسويات',none:'لا توجد تسويات',delete:'حذف',reason:'سبب الحذف',deleteAction:'حذف التسوية',error:'تعذر تحميل تسويات المدفوعات',select:'اختر حركة بنكية مطابقة لمستند',emptyTitle:'لا توجد حركة مؤهلة للتسوية حاليًا',emptyHelp:'طابق حركة بنكية مع مستند معتمد أولًا، وبعدها ستظهر هنا لتسجيل التسوية.',selectedTitle:'التسوية المحددة',allocateTitle:'توزيع الحركة على عدة مستندات',allocateHelp:'يمكن لحركة بنكية واحدة أن تسدد عدة مستندات معتمدة لنفس الطرف المقابل. أي مبلغ غير موزع يُبقي الحركة مفتوحة عند الإقفال.',bankAmount:'مبلغ الحركة',allocated:'الموزع',unallocated:'غير الموزع',allocationTotal:'هذا التوزيع',allocate:'حفظ التوزيع',matchedDocuments:'المستندات الموزع عليها',noCandidates:'لا توجد مستندات معتمدة متاحة لهذه الحركة',allocationExceeds:'التوزيع يتجاوز المبلغ غير الموزع',counterparty:'الطرف المقابل'}
};

export function SettlementPanel({canView,canSettle,onUnauthorized}:Props){
  const {i18n}=useTranslation(); const s=i18n.language==='ar'?strings.ar:strings.en;
  const [transactions,setTransactions]=useState<Transaction[]>([]); const [selectedTx,setSelectedTx]=useState<string|null>(null); const [documentId,setDocumentId]=useState<string|null>(null); const [summary,setSummary]=useState<Summary|null>(null);
  const [candidates,setCandidates]=useState<MatchResponse|null>(null); const [allocations,setAllocations]=useState<Record<string,number|string>>({});
  const [amount,setAmount]=useState<number|string>(''); const [note,setNote]=useState(''); const [reason,setReason]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState('');

  useEffect(()=>{if(!canView)return;void api<{transactions:Transaction[]}>('/api/bank-transactions',undefined,onUnauthorized).then(x=>setTransactions(x.transactions.filter(t=>canSettle||t.reconciliation_status!=='unmatched'))).catch(e=>setError(e instanceof Error?e.message:s.error));},[canView]);
  const options=useMemo(()=>transactions.map(t=>({value:t.id,label:`${t.transaction_date} · ${t.description||t.bank_reference||t.id} · ${t.amount}`})),[transactions]);

  const choose=async(value:string|null)=>{setSelectedTx(value);setDocumentId(null);setSummary(null);setCandidates(null);setAllocations({});setError('');if(!value)return;setBusy(true);try{const match=await api<MatchResponse>(`/api/bank-transactions/${value}/match-candidates`,undefined,onUnauthorized);setCandidates(match);if(!match.match?.document_id){if(!canSettle)throw new Error(s.select);return;}setDocumentId(match.match.document_id);const data=await api<Summary>(`/api/documents/${match.match.document_id}/settlements`,undefined,onUnauthorized);setSummary(data);const tx=transactions.find(t=>t.id===value);if(tx&&data.remaining_amount!==null)setAmount(Math.min(Math.abs(Number(tx.amount)),Number(data.remaining_amount)));}catch(e){setError(e instanceof Error?e.message:s.error);}finally{setBusy(false);}};
  const allocationTotal=Object.values(allocations).reduce<number>((n,v)=>n+Math.round(Number(v||0)*100),0);
  const unallocatedCents=Math.round(Number(candidates?.unallocated_amount??0)*100);
  const allocationRows=(candidates?.documents??[]).filter(d=>d.status==='approved');
  const allocate=async(event:FormEvent)=>{event.preventDefault();if(!selectedTx)return;const rows=Object.entries(allocations).filter(([,v])=>Number(v)>0).map(([document_id,v])=>({document_id,amount:Number(v).toFixed(2)}));if(!rows.length)return;setBusy(true);setError('');try{await api(`/api/bank-transactions/${selectedTx}/allocations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({allocations:rows,note:note||undefined})},onUnauthorized);setNote('');const value=selectedTx;await choose(value);}catch(e){setError(e instanceof Error?e.message:s.error);}finally{setBusy(false);}};
  const refresh=async()=>{if(!documentId)return;setSummary(await api<Summary>(`/api/documents/${documentId}/settlements`,undefined,onUnauthorized));};
  const create=async(event:FormEvent)=>{event.preventDefault();if(!documentId||!selectedTx||!amount)return;setBusy(true);setError('');try{await api(`/api/documents/${documentId}/settlements`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bank_transaction_id:selectedTx,amount:String(amount),note:note||undefined})},onUnauthorized);setNote('');await refresh();}catch(e){setError(e instanceof Error?e.message:s.error);}finally{setBusy(false);}};
  const remove=async(id:string)=>{if(!documentId||!reason.trim())return;setBusy(true);setError('');try{await api(`/api/documents/${documentId}/settlements/${id}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:reason.trim()})},onUnauthorized);setReason('');await refresh();}catch(e){setError(e instanceof Error?e.message:s.error);}finally{setBusy(false);}};

  if(!canView)return null;
  return <Card withBorder padding="lg" className="banking-settlement-panel"><Stack gap="lg">
    <div className="banking-section-heading"><Title order={2} size="h3">{s.title}</Title><Text c="dimmed">{s.description}</Text></div>
    {error&&<Alert color="red" role="alert">{error}</Alert>}
    <div className="banking-operation-card">
      <Select label={s.transaction} placeholder={s.select} data={options} value={selectedTx} onChange={v=>void choose(v)} searchable clearable disabled={busy}/>
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
        <Table.ScrollContainer minWidth={640}><Table><Table.Thead><Table.Tr><Table.Th>{s.document}</Table.Th><Table.Th>{s.counterparty}</Table.Th><Table.Th>{s.remaining}</Table.Th><Table.Th>{s.amount}</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{allocationRows.map(d=><Table.Tr key={d.id}><Table.Td><Text dir="auto" size="sm">{d.original_filename}</Text></Table.Td><Table.Td><Text dir="auto" size="sm">{d.counterparty_name||'—'}</Text></Table.Td><Table.Td dir="ltr">{d.linked_obligation?.remaining_amount??d.total_amount??'—'}</Table.Td><Table.Td><NumberInput aria-label={`${s.amount} ${d.original_filename}`} value={allocations[d.id]??''} onChange={v=>setAllocations(a=>({...a,[d.id]:v}))} min={0} decimalScale={2} disabled={busy}/></Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>
        {allocationTotal>unallocatedCents&&<Alert color="red">{s.allocationExceeds}</Alert>}
        <Group align="end" grow><div><Text size="sm" c="dimmed">{s.allocationTotal}</Text><Text fw={700} dir="ltr">{(allocationTotal/100).toFixed(2)}</Text></div><TextInput label={s.note} value={note} onChange={e=>setNote(e.currentTarget.value)} maxLength={500}/><Button type="submit" loading={busy} disabled={allocationTotal<=0||allocationTotal>unallocatedCents}>{s.allocate}</Button></Group>
      </Stack></form>)}
    </Stack></div>}
    {summary&&<div className="banking-selected-operation"><Stack gap="md">
      <Text fw={700}>{s.selectedTitle}</Text>
      <div className="banking-metrics-grid">
        <div><span>{s.document}</span><strong dir="auto">{summary.document.original_filename}</strong></div>
        <div><span>{s.status}</span><strong>{s[summary.payment_status]}</strong></div>
        <div><span>{s.total}</span><strong dir="ltr">{summary.document.total_amount??'—'}</strong></div>
        <div><span>{s.settled}</span><strong dir="ltr">{summary.settled_amount}</strong></div>
        <div><span>{s.remaining}</span><strong dir="ltr">{summary.remaining_amount??'—'}</strong></div>
      </div>
      {canSettle&&summary.document.status==='approved'&&summary.remaining_amount!==null&&Number(summary.remaining_amount)>0&&<form onSubmit={create} className="banking-inline-form"><Group align="end" grow><NumberInput label={s.amount} value={amount} onChange={setAmount} min={0.01} decimalScale={2} required/><TextInput label={s.note} value={note} onChange={e=>setNote(e.currentTarget.value)} maxLength={500}/><Button type="submit" loading={busy}>{s.create}</Button></Group></form>}
      <div className="banking-subsection"><Title order={3} size="h4">{s.history}</Title>
        {summary.settlements.length===0?<Text c="dimmed">{s.none}</Text>:<Table.ScrollContainer minWidth={700}><Table><Table.Thead><Table.Tr><Table.Th>{s.transaction}</Table.Th><Table.Th>{s.amount}</Table.Th><Table.Th>{s.note}</Table.Th>{canSettle&&<Table.Th>{s.delete}</Table.Th>}</Table.Tr></Table.Thead><Table.Tbody>{summary.settlements.map(x=><Table.Tr key={x.id}><Table.Td>{x.transaction_date} · {x.transaction_description||x.bank_reference||x.bank_transaction_id}</Table.Td><Table.Td>{x.amount}</Table.Td><Table.Td>{x.note||'—'}</Table.Td>{canSettle&&<Table.Td><Group align="end"><TextInput aria-label={s.reason} placeholder={s.reason} value={reason} onChange={e=>setReason(e.currentTarget.value)} maxLength={500}/><Button color="red" variant="light" onClick={()=>void remove(x.id)} disabled={!reason.trim()} loading={busy}>{s.deleteAction}</Button></Group></Table.Td>}</Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>}
      </div>
    </Stack></div>}
  </Stack></Card>;
}
