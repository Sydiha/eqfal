import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../money-format';
import { SectionCard, WorkspaceState } from './SharedUI';

type Liability={liability_line_id:string;period_month:string;category:string;original_amount:string;settled_amount:string;remaining_amount:string};
type Bank={id:string;transaction_date:string;bank_reference:string|null;remaining_amount:string};
type History={id:string;bank_transaction_id:string;bank_reference:string|null;journal_entry_id:string;journal_reference:string|null;category:string;amount:string;transaction_date:string;reconciliation_status:string;bank_amount:string;bank_allocated_amount:string};
const cents=(s:string):bigint|null=>{if(!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(s))return null;const [a,b='']=s.split('.');return BigInt(a)*100n+BigInt(b.padEnd(2,'0'));};
const money=(s:string)=><bdi className="payroll-amount" dir="ltr">{formatMoney(s,'0.00')} SAR</bdi>;
export function PayrollSettlement({capabilities,onUnauthorized}:{capabilities:string[];onUnauthorized:()=>void}){
 const {t}=useTranslation();const l=(key:string)=>t(`payrollSettlement.${key}`);
 const visible=capabilities.includes('payroll.view')&&capabilities.includes('payroll.settlement.view');
 const bankVisible=visible&&capabilities.includes('bank.view');
 const canCreate=bankVisible&&capabilities.includes('payroll.settlement.create');
 const [liabilities,setLiabilities]=useState<Liability[]>([]),[banks,setBanks]=useState<Bank[]>([]),[history,setHistory]=useState<History[]>([]);
 const [liability,setLiability]=useState(''),[bank,setBank]=useState(''),[amount,setAmount]=useState(''),[error,setError]=useState(''),[success,setSuccess]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const key=useRef<string|null>(null), sequence=useRef(0);
 const load=useCallback(async()=>{if(!visible)return;const n=++sequence.current;setLoading(true);setError('');try{
  const urls=['/api/payroll/settlements/liabilities',...(bankVisible?['/api/payroll/settlements/bank-transactions','/api/payroll/settlements']:[])];
  const responses=await Promise.all(urls.map(url=>fetch(url,{credentials:'same-origin'})));
  if(responses.some(r=>r.status===401)){onUnauthorized();return;}if(responses.some(r=>!r.ok))throw Error();
  const data=await Promise.all(responses.map(r=>r.json()));if(n!==sequence.current)return;
  setLiabilities(data[0].liabilities);if(bankVisible){setBanks(data[1].bank_transactions);setHistory(data[2].settlements);}
 }catch{if(n===sequence.current)setError('loadError');}finally{if(n===sequence.current)setLoading(false);}},[visible,bankVisible,onUnauthorized]);
 useEffect(()=>{void load();return()=>{sequence.current++;};},[load]);
 const change=(fn:()=>void)=>{key.current=null;setError('');setSuccess('');fn();};
 const chosenLiability=liabilities.find(x=>x.liability_line_id===liability),chosenBank=banks.find(x=>x.id===bank);
 const submit=async(e:FormEvent)=>{e.preventDefault();if(busy)return;setError('');setSuccess('');
  if(!chosenLiability){setError('chooseLiability');return;}if(!chosenBank){setError('chooseBank');return;}
  const value=cents(amount),remaining=cents(chosenLiability.remaining_amount),available=cents(chosenBank.remaining_amount);
  if(value===null||value<=0n){setError('invalidAmount');return;}
  if(remaining===null||value>remaining){setError('liabilityLimit');return;}if(available===null||value>available){setError('bankLimit');return;}
  key.current??=crypto.randomUUID();setBusy(true);
  try{const response=await fetch('/api/payroll/settlements',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({bank_transaction_id:bank,liability_line_id:liability,amount,idempotency_key:key.current})});
   if(response.status===401){onUnauthorized();return;}if(!response.ok){const body=await response.json().catch(()=>({}));throw Error(body.code||'server');}
   key.current=null;setSuccess('created');setAmount('');await load();
  }catch(e){const code=(e as Error).message;setError(({PAYROLL_SETTLEMENT_CONFLICT:'conflict',PAYROLL_SETTLEMENT_BANK_CLAIMED:'bankClaimed',PAYROLL_SETTLEMENT_BANK_INELIGIBLE:'bankIneligible',PAYROLL_SETTLEMENT_BANK_UNLINKED:'bankUnlinked',PAYROLL_SETTLEMENT_PERIOD_INELIGIBLE:'periodClosed',PAYROLL_SETTLEMENT_POST_BLOCKED:'periodClosed',PAYROLL_SETTLEMENT_IDEMPOTENCY_CONFLICT:'conflict',PAYROLL_SETTLEMENT_NOT_FOUND:'notFound'} as Record<string,string>)[code]??'saveError');}finally{setBusy(false);}
 };
 if(!visible)return null;
 return <SectionCard className="payroll-settlement"><h3>{l('title')}</h3><p>{l('intro')}</p>
 {loading?<WorkspaceState>{l('loading')}</WorkspaceState>:<>
 {error&&<p id="payroll-settlement-error" role="alert" className="form-validation-error">{l(error)} {['loadError','conflict','bankClaimed','bankIneligible','notFound'].includes(error)&&<button type="button" onClick={()=>void load()}>{l('retry')}</button>}</p>}{success&&<p role="status">{l(success)}</p>}
 {liabilities.length===0?<WorkspaceState kind="empty">{l('noLiabilities')}</WorkspaceState>:<div className="payroll-settlement-list">{liabilities.map(x=><article className="payroll-settlement-item" key={x.liability_line_id}><strong>{l(x.category)} · <bdi>{x.period_month.slice(0,7)}</bdi></strong><div>{l('original')} {money(x.original_amount)}</div><div>{l('settled')} {money(x.settled_amount)}</div><div>{l('remaining')} {money(x.remaining_amount)}</div></article>)}</div>}
 {!bankVisible&&<p>{l('bankPermission')}</p>}
 {canCreate&&<form className="payroll-settlement-form" onSubmit={e=>void submit(e)}>
  <label>{l('liability')}<select value={liability} aria-invalid={error==='chooseLiability'||undefined} aria-describedby={error==='chooseLiability'?'payroll-settlement-error':undefined} onChange={e=>change(()=>setLiability(e.target.value))}><option value="">{l('select')}</option>{liabilities.filter(x=>(cents(x.remaining_amount)??0n)>0n).map(x=><option key={x.liability_line_id} value={x.liability_line_id}>{l(x.category)} · {x.period_month.slice(0,7)} · {x.remaining_amount} SAR</option>)}</select></label>
  <label>{l('bank')}<select value={bank} aria-invalid={error==='chooseBank'||undefined} aria-describedby={error==='chooseBank'?'payroll-settlement-error':undefined} onChange={e=>change(()=>setBank(e.target.value))}><option value="">{l('select')}</option>{banks.filter(x=>(cents(x.remaining_amount)??0n)>0n).map(x=><option key={x.id} value={x.id}>{x.transaction_date} · {x.bank_reference||x.id} · {x.remaining_amount} SAR</option>)}</select></label>
  {!banks.some(x=>(cents(x.remaining_amount)??0n)>0n)&&<p>{l('noBanks')}</p>}
  <label>{l('amount')}<input value={amount} onChange={e=>change(()=>setAmount(e.target.value))} inputMode="decimal" dir="ltr" aria-invalid={['invalidAmount','liabilityLimit','bankLimit'].includes(error)||undefined} aria-describedby={['invalidAmount','liabilityLimit','bankLimit'].includes(error)?'payroll-settlement-error':undefined}/></label>
  <button className="primary" disabled={busy}>{busy?l('saving'):l('submit')}</button>
 </form>}
 {bankVisible&&<><h4>{l('history')}</h4>{history.length===0?<p>{l('noHistory')}</p>:<div className="payroll-settlement-list">{history.map(x=><article className="payroll-settlement-item" key={x.id}><strong>{l(x.category)} · {money(x.amount)}</strong><div>{l('bankReference')}: <bdi>{x.bank_reference||x.bank_transaction_id}</bdi> · <bdi>{x.transaction_date}</bdi></div><div>{l('journalReference')}: <bdi>{x.journal_reference||x.journal_entry_id}</bdi></div><div>{l('status')}: {l((cents(x.bank_allocated_amount)??0n)<(cents(x.bank_amount.replace(/^-/,''))??0n)?'partial':x.reconciliation_status==='reconciled'?'reconciled':'fullyAllocated')}</div></article>)}</div>}</>}
 </>}</SectionCard>;
}
