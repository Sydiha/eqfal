import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';

type Transaction = { id:string; transaction_date:string; description:string|null; bank_reference:string|null; amount:string; reconciliation_status:'unmatched'|'matched'|'reconciled' };
type MatchResponse = { match:{document_id:string}|null };
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
  en:{title:'Payment settlements',description:'Record how much of an approved document is settled by an already-matched bank transaction.',transaction:'Matched bank transaction',document:'Document',total:'Total',settled:'Settled',remaining:'Remaining',status:'Payment status',unpaid:'Unpaid',partially_paid:'Partially paid',paid:'Paid',amount:'Settlement amount',note:'Note',create:'Record settlement',history:'Settlement history',none:'No settlement records',delete:'Delete',reason:'Deletion reason',deleteAction:'Delete settlement',error:'Unable to load payment settlements',select:'Select a matched bank transaction'},
  ar:{title:'تسويات المدفوعات',description:'تسجيل الجزء المسدد من مستند معتمد بواسطة حركة بنكية تمت مطابقتها مسبقًا.',transaction:'الحركة البنكية المطابقة',document:'المستند',total:'الإجمالي',settled:'المسدد',remaining:'المتبقي',status:'حالة السداد',unpaid:'غير مسدد',partially_paid:'مسدد جزئيًا',paid:'مسدد',amount:'مبلغ التسوية',note:'ملاحظة',create:'تسجيل تسوية',history:'سجل التسويات',none:'لا توجد تسويات',delete:'حذف',reason:'سبب الحذف',deleteAction:'حذف التسوية',error:'تعذر تحميل تسويات المدفوعات',select:'اختر حركة بنكية مطابقة'}
};

export function SettlementPanel({canView,canSettle,onUnauthorized}:Props){
  const {i18n}=useTranslation(); const s=i18n.language==='ar'?strings.ar:strings.en;
  const [transactions,setTransactions]=useState<Transaction[]>([]); const [selectedTx,setSelectedTx]=useState<string|null>(null); const [documentId,setDocumentId]=useState<string|null>(null); const [summary,setSummary]=useState<Summary|null>(null);
  const [amount,setAmount]=useState<number|string>(''); const [note,setNote]=useState(''); const [reason,setReason]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState('');

  useEffect(()=>{if(!canView)return;void api<{transactions:Transaction[]}>('/api/bank-transactions',undefined,onUnauthorized).then(x=>setTransactions(x.transactions.filter(t=>t.reconciliation_status!=='unmatched'))).catch(e=>setError(e instanceof Error?e.message:s.error));},[canView]);

  const options=useMemo(()=>transactions.map(t=>({value:t.id,label:`${t.transaction_date} · ${t.description||t.bank_reference||t.id} · ${t.amount}`})),[transactions]);

  const choose=async(value:string|null)=>{setSelectedTx(value);setDocumentId(null);setSummary(null);setError('');if(!value)return;setBusy(true);try{const match=await api<MatchResponse>(`/api/bank-transactions/${value}/match-candidates`,undefined,onUnauthorized);if(!match.match)throw new Error(s.select);setDocumentId(match.match.document_id);const data=await api<Summary>(`/api/documents/${match.match.document_id}/settlements`,undefined,onUnauthorized);setSummary(data);const tx=transactions.find(t=>t.id===value);if(tx&&data.remaining_amount!==null)setAmount(Math.min(Math.abs(Number(tx.amount)),Number(data.remaining_amount)));}catch(e){setError(e instanceof Error?e.message:s.error);}finally{setBusy(false);}};
  const refresh=async()=>{if(!documentId)return;setSummary(await api<Summary>(`/api/documents/${documentId}/settlements`,undefined,onUnauthorized));};

  const create=async(event:FormEvent)=>{event.preventDefault();if(!documentId||!selectedTx||!amount)return;setBusy(true);setError('');try{await api(`/api/documents/${documentId}/settlements`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bank_transaction_id:selectedTx,amount:String(amount),note:note||undefined})},onUnauthorized);setNote('');await refresh();}catch(e){setError(e instanceof Error?e.message:s.error);}finally{setBusy(false);}};
  const remove=async(id:string)=>{if(!documentId||!reason.trim())return;setBusy(true);setError('');try{await api(`/api/documents/${documentId}/settlements/${id}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:reason.trim()})},onUnauthorized);setReason('');await refresh();}catch(e){setError(e instanceof Error?e.message:s.error);}finally{setBusy(false);}};

  if(!canView)return null;
  return <Card withBorder padding="lg"><Stack gap="md">
    <div><Title order={2} size="h3">{s.title}</Title><Text c="dimmed">{s.description}</Text></div>
    {error&&<Alert color="red" role="alert">{error}</Alert>}
    <Select label={s.transaction} placeholder={s.select} data={options} value={selectedTx} onChange={v=>void choose(v)} searchable clearable disabled={busy}/>
    {summary&&<>
      <Group><Badge>{s.document}: {summary.document.original_filename}</Badge><Badge>{s.status}: {s[summary.payment_status]}</Badge><Badge>{s.total}: {summary.document.total_amount??'—'}</Badge><Badge>{s.settled}: {summary.settled_amount}</Badge><Badge>{s.remaining}: {summary.remaining_amount??'—'}</Badge></Group>
      {canSettle&&summary.document.status==='approved'&&summary.remaining_amount!==null&&Number(summary.remaining_amount)>0&&<form onSubmit={create}><Group align="end"><NumberInput label={s.amount} value={amount} onChange={setAmount} min={0.01} decimalScale={2} required/><TextInput label={s.note} value={note} onChange={e=>setNote(e.currentTarget.value)} maxLength={500}/><Button type="submit" loading={busy}>{s.create}</Button></Group></form>}
      <Title order={3} size="h4">{s.history}</Title>
      {summary.settlements.length===0?<Text c="dimmed">{s.none}</Text>:<Table.ScrollContainer minWidth={700}><Table><Table.Thead><Table.Tr><Table.Th>{s.transaction}</Table.Th><Table.Th>{s.amount}</Table.Th><Table.Th>{s.note}</Table.Th>{canSettle&&<Table.Th>{s.delete}</Table.Th>}</Table.Tr></Table.Thead><Table.Tbody>{summary.settlements.map(x=><Table.Tr key={x.id}><Table.Td>{x.transaction_date} · {x.transaction_description||x.bank_reference||x.bank_transaction_id}</Table.Td><Table.Td>{x.amount}</Table.Td><Table.Td>{x.note||'—'}</Table.Td>{canSettle&&<Table.Td><Group align="end"><TextInput aria-label={s.reason} placeholder={s.reason} value={reason} onChange={e=>setReason(e.currentTarget.value)} maxLength={500}/><Button color="red" variant="light" onClick={()=>void remove(x.id)} disabled={!reason.trim()} loading={busy}>{s.deleteAction}</Button></Group></Table.Td>}</Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>}
    </>}
  </Stack></Card>;
}
