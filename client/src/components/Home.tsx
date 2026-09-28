import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDisplayDate } from '../date-format';

type HomePage = 'monthlyClose' | 'vat' | 'documents' | 'banks' | 'obligations' | 'accounting';
type DiscoveryPage = 'documents' | 'banks' | 'obligations' | 'vat' | 'accounting';
type BlockerKey = 'documents' | 'obligations' | 'bank_transactions' | 'vat' | 'ledger' | 'assets' | 'opening_balances' | 'periodic_adjustments';
type Period = {
  period_start: string; period_end: string; status: 'open' | 'closed'; ready: boolean;
  disclosed_total: number; has_hidden_blockers: boolean; blockers: Record<BlockerKey, number>;
};
type HomeAlert = {
  key: string; class: 'needs_action_now' | 'upcoming_due' | 'needs_review_completion';
  ownership: 'current_user' | 'waiting_for_accountant' | 'waiting_for_team' | 'upcoming';
  count: number; amount?: string; destination: DiscoveryPage; parameters: Record<string, string>;
};
type Metric = { state: 'available'; amount: string } | { state: 'hidden' } | { state: 'unavailable' };
type FinancialSnapshot = { metrics: {
  bank_balances: { state: 'hidden' } | { state: 'available'; accounts: Array<{ id: string; display_name: string; currency_code: string; balance: { state: 'available'; amount: string } | { state: 'unavailable' } }> };
  amounts_to_collect: Metric; amounts_to_pay: Metric; total_assets: Metric;
} };
type Props = {
  capabilities: readonly string[]; navigate: (page: HomePage) => void;
  navigateToDiscovery: (page: DiscoveryPage, parameters: Record<string, string>) => void;
  startPurchaseEntry: (type: 'purchase' | 'expense') => void; startSalesEntry: () => void; onUnauthorized: () => void;
};

const stripMarks = (value: string) => value.replace(/[\u061c\u200e\u200f]/g, '');
const typeForAlert = (key: string) => key.startsWith('documents_') ? 'document' : key.startsWith('bank_') ? 'bank' : 'obligation';

export function Home({ capabilities, navigate, navigateToDiscovery, onUnauthorized }: Props) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language.startsWith('ar');
  const can = (capability: string) => capabilities.includes(capability);
  const canViewClose = can('monthly_close.view');
  const canViewAlerts = ['obligation.view', 'document.view', 'bank.view'].some(can);
  const canViewSnapshot = ['bank.view', 'obligation.view', 'accounting.view'].some(can);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [alerts, setAlerts] = useState<HomeAlert[]>([]);
  const [snapshot, setSnapshot] = useState<FinancialSnapshot | null>(null);
  const [closeState, setCloseState] = useState<'loading'|'ready'|'error'>(canViewClose ? 'loading' : 'ready');
  const [alertsState, setAlertsState] = useState<'loading'|'ready'|'error'>(canViewAlerts ? 'loading' : 'ready');
  const [snapshotState, setSnapshotState] = useState<'loading'|'ready'|'error'>(canViewSnapshot ? 'loading' : 'ready');

  const labels = ar ? {
    title: 'نظرة عامة مالية', context: 'ملخص مالي وتشغيلي محدث من بيانات إقفال', summary: 'الملخص المالي',
    cash: 'النقد وما في حكمه', receivables: 'الذمم المدينة', payables: 'الذمم الدائنة', assets: 'إجمالي الأصول',
    followup: 'قائمة المهام التي تتطلب متابعة', type: 'النوع', description: 'الوصف', count: 'العدد', amount: 'المبلغ', owner: 'المسؤول', status: 'الحالة', action: 'الإجراء',
    types: { obligation: 'التزامات', document: 'مستندات', bank: 'بنوك' },
    ownership: { current_user: 'أنت', waiting_for_accountant: 'المحاسب', waiting_for_team: 'الفريق', upcoming: 'قادم' },
    classes: { needs_action_now: 'يتطلب إجراء', upcoming_due: 'قادم', needs_review_completion: 'تحت المتابعة' },
    open: 'فتح', empty: 'لا توجد مهام معلقة.', unavailable: 'غير متاح', restricted: 'مقيّد حسب الصلاحيات', retry: 'إعادة المحاولة',
    close: 'جاهزية الإقفال الشهري', checklist: 'قائمة تحقق الإقفال', ready: 'مكتمل', blocked: (n:number) => `${n} معوقات`, hidden: 'توجد معوقات تتطلب مستخدماً مخولاً', period: 'الفترة', closePage: 'فتح الإقفال الشهري', loading: 'جارٍ التحميل…', error: 'تعذر تحميل البيانات.', noAccounts: 'لا توجد حسابات بنكية متاحة.',
  } : {
    title: 'Financial overview', context: 'Financial and operational summary from current EQFAL data', summary: 'Financial summary',
    cash: 'Cash and cash equivalents', receivables: 'Receivables', payables: 'Payables', assets: 'Total assets',
    followup: 'Tasks requiring follow-up', type: 'Type', description: 'Description', count: 'Count', amount: 'Amount', owner: 'Responsible', status: 'Status', action: 'Action',
    types: { obligation: 'Obligations', document: 'Documents', bank: 'Banking' },
    ownership: { current_user: 'You', waiting_for_accountant: 'Accountant', waiting_for_team: 'Team', upcoming: 'Upcoming' },
    classes: { needs_action_now: 'Action required', upcoming_due: 'Upcoming', needs_review_completion: 'In progress' },
    open: 'Open', empty: 'No outstanding tasks.', unavailable: 'Unavailable', restricted: 'Restricted by permissions', retry: 'Try again',
    close: 'Monthly close readiness', checklist: 'Close checklist', ready: 'Ready', blocked: (n:number) => `${n} blockers`, hidden: 'There are blockers that require an authorized user.', period: 'Period', closePage: 'Open monthly close', loading: 'Loading…', error: 'Unable to load data.', noAccounts: 'No bank accounts available.',
  };
  const alertNames: Record<string,string> = ar ? {
    overdue_obligations:'التزامات متأخرة', upcoming_obligations:'التزامات مستحقة خلال 30 يوماً', unconfirmed_obligations:'التزامات غير مؤكدة', documents_uploaded:'مستندات مرفوعة للمراجعة', documents_needs_review:'مستندات تحتاج مراجعة', documents_incomplete:'مستندات غير مكتملة', bank_transactions_unmatched:'حركات بنكية غير مطابقة', bank_transactions_matched:'حركات بنكية بانتظار التسوية',
  } : {
    overdue_obligations:'Overdue obligations', upcoming_obligations:'Obligations due within 30 days', unconfirmed_obligations:'Unconfirmed obligations', documents_uploaded:'Uploaded documents to review', documents_needs_review:'Documents needing review', documents_incomplete:'Incomplete documents', bank_transactions_unmatched:'Unmatched bank transactions', bank_transactions_matched:'Bank transactions awaiting reconciliation',
  };

  const request = async <T,>(url:string, setter:(value:T)=>void, state:(value:'ready'|'error')=>void) => {
    try { const response=await fetch(url,{credentials:'same-origin'}); if(response.status===401)onUnauthorized(); if(!response.ok)throw new Error(); setter(await response.json() as T); state('ready'); } catch { state('error'); }
  };
  const loadClose=()=>request<{periods?:Period[]}>('/api/monthly-close-periods',p=>setPeriods(Array.isArray(p.periods)?p.periods:[]),setCloseState);
  const loadAlerts=()=>request<{alerts?:HomeAlert[]}>('/api/home-alerts',p=>setAlerts(Array.isArray(p.alerts)?p.alerts.filter(a=>a.count>0):[]),setAlertsState);
  const loadSnapshot=()=>request<FinancialSnapshot>('/api/manager-financial-snapshot',setSnapshot,setSnapshotState);
  useEffect(()=>{if(canViewClose)void loadClose();},[canViewClose]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{if(canViewAlerts)void loadAlerts();},[canViewAlerts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{if(canViewSnapshot)void loadSnapshot();},[canViewSnapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected=periods[0]??null;
  const formatMetric=(metric:Metric|undefined)=>!metric||metric.state==='hidden'?labels.restricted:metric.state==='unavailable'?labels.unavailable:metric.amount;
  const bankContent=()=>{
    const metric=snapshot?.metrics.bank_balances;
    if(!metric||metric.state==='hidden')return <strong>{labels.restricted}</strong>;
    if(!metric.accounts.length)return <strong>{labels.noAccounts}</strong>;
    return <div className="home-financial__accounts">{metric.accounts.map(a=><span key={a.id}>{a.display_name}<strong dir="ltr">{a.balance.state==='available'?`${a.balance.amount} ${a.currency_code}`:labels.unavailable}</strong></span>)}</div>;
  };
  const blockerLabels:Record<BlockerKey,string>=ar?{documents:'المستندات',obligations:'الالتزامات',bank_transactions:'التسوية البنكية',vat:'جاهزية ضريبة القيمة المضافة',ledger:'المحاسبة والترحيل',assets:'الأصول والإهلاك',opening_balances:'الأرصدة الافتتاحية',periodic_adjustments:'التسويات الدورية'}:{documents:'Documents',obligations:'Obligations',bank_transactions:'Bank reconciliation',vat:'VAT readiness',ledger:'Accounting and posting',assets:'Assets and depreciation',opening_balances:'Opening balances',periodic_adjustments:'Periodic adjustments'};
  const blockerKeys=Object.keys(blockerLabels) as BlockerKey[];
  const openBlocker=(key:BlockerKey)=>{
    if(!selected)return;
    const range={from:selected.period_start,to:selected.period_end};
    if(key==='documents'&&can('document.view'))navigateToDiscovery('documents',range);
    else if(key==='obligations'&&can('obligation.view'))navigateToDiscovery('obligations',{confirmation:'unconfirmed'});
    else if(key==='bank_transactions'&&can('bank.view'))navigateToDiscovery('banks',{section:'transactions',...range});
    else if(key==='vat'&&can('vat.view'))navigateToDiscovery('vat',{vatFrom:selected.period_start,vatTo:selected.period_end});
    else if(key==='ledger'&&can('accounting.view'))navigateToDiscovery('accounting',{accountingTab:'sources',sourceFrom:selected.period_start,sourceTo:selected.period_end});
    else navigate('monthlyClose');
  };
  const range=selected?<span dir="ltr">{stripMarks(formatDisplayDate(selected.period_start,i18n.language))} — {stripMarks(formatDisplayDate(selected.period_end,i18n.language))}</span>:null;

  return <section className="home-overview" aria-labelledby="home-title">
    <header className="home-overview__heading"><div><h1 id="home-title">{labels.title}</h1><p>{labels.context}</p></div></header>
    {canViewSnapshot&&<section className="home-financial" aria-labelledby="financial-title">
      <h2 id="financial-title" className="sr-only">{labels.summary}</h2>
      {snapshotState==='loading'?<p role="status">{labels.loading}</p>:snapshotState==='error'?<p role="alert">{labels.error} <button onClick={()=>void loadSnapshot()}>{labels.retry}</button></p>:<div className="home-financial__grid">
        <article><h3>{labels.cash}</h3>{bankContent()}</article>
        <article><h3>{labels.receivables}</h3><strong dir="ltr">{formatMetric(snapshot?.metrics.amounts_to_collect)}</strong></article>
        <article><h3>{labels.payables}</h3><strong dir="ltr">{formatMetric(snapshot?.metrics.amounts_to_pay)}</strong></article>
        <article><h3>{labels.assets}</h3><strong dir="ltr">{formatMetric(snapshot?.metrics.total_assets)}</strong></article>
      </div>}
    </section>}
    {canViewAlerts&&<section className="home-followup" aria-labelledby="followup-title"><div className="home-section-title"><h2 id="followup-title">{labels.followup}</h2></div>
      {alertsState==='loading'?<p role="status">{labels.loading}</p>:alertsState==='error'?<p role="alert">{labels.error} <button onClick={()=>void loadAlerts()}>{labels.retry}</button></p>:alerts.length===0?<p className="home-empty">{labels.empty}</p>:<div className="home-table-wrap"><table><thead><tr><th>{labels.type}</th><th>{labels.description}</th><th>{labels.count}</th><th>{labels.amount}</th><th>{labels.owner}</th><th>{labels.status}</th><th>{labels.action}</th></tr></thead><tbody>{alerts.map(a=><tr key={a.key}><td>{labels.types[typeForAlert(a.key) as keyof typeof labels.types]}</td><td><strong>{alertNames[a.key]??a.key}</strong></td><td>{a.count}</td><td dir="ltr">{a.amount??'—'}</td><td>{labels.ownership[a.ownership]}</td><td><span className={`home-pill home-pill--${a.class}`}>{labels.classes[a.class]}</span></td><td><button className="home-table-action" onClick={()=>navigateToDiscovery(a.destination,a.parameters)}>{labels.open}</button></td></tr>)}</tbody></table></div>}
    </section>}
    {canViewClose&&<section className="home-close" aria-labelledby="close-title"><div className="home-section-title"><div><h2 id="close-title">{labels.close}</h2>{selected&&<p>{labels.period}: {range}</p>}</div>{selected&&<span className={`home-pill ${selected.status==='closed'||selected.ready?'is-ready':'is-blocked'}`}>{selected.has_hidden_blockers?labels.hidden:selected.status==='closed'||selected.ready?labels.ready:labels.blocked(selected.disclosed_total)}</span>}</div>
      {closeState==='loading'?<p role="status">{labels.loading}</p>:closeState==='error'?<p role="alert">{labels.error} <button onClick={()=>void loadClose()}>{labels.retry}</button></p>:selected?<><h3 className="home-close__checklist-title">{labels.checklist}</h3><div className="home-close__checklist">{blockerKeys.map(key=>{const count=selected.blockers[key]??0;return <button key={key} onClick={()=>openBlocker(key)}><span className={`home-close__mark ${count?'is-blocked':'is-ready'}`} aria-hidden="true">{count?'!':'✓'}</span><span>{blockerLabels[key]}</span><strong>{count?labels.blocked(count):labels.ready}</strong></button>})}</div><button className="home-close__open" onClick={()=>navigate('monthlyClose')}>{labels.closePage}</button></>:<p className="home-empty">{t('monthlyClose.empty')}</p>}
    </section>}
  </section>;
}
