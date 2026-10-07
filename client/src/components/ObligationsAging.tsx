import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkspaceState } from './SharedUI';
import { ExportButtons } from './ExportButtons';
import { useActiveCompanyName } from '../context/CompanyContext';
import { agingExport, generatedStamp } from '../export/reportExport';
import './ObligationsAging.css';

type Bucket = 'current' | 'days_1_30' | 'days_31_60' | 'days_61_90' | 'days_over_90';
type AgingItem = { obligation_id: string; counterparty_name: string; source_type: string; recognized_on: string; due_on: string | null; original_amount: string; settled_amount: string; outstanding_amount: string; days_overdue: number; bucket: Bucket };
type AgingSide = { buckets: Array<{ bucket: Bucket; amount: string; count: number }>; total_outstanding: string; item_count: number; items: AgingItem[] };
export type AgingReport = { as_of_date: string; receivables: AgingSide; payables: AgingSide };

const labels = {
  ar: {
    title: 'تقرير أعمار الذمم', asOf: 'كما في تاريخ', run: 'تحديث التقرير', receivables: 'الذمم المدينة', payables: 'الذمم الدائنة',
    sides: 'جهة التقرير', total: 'إجمالي المستحق', count: (n: number) => `${n} التزام`, loading: 'جارٍ تحميل التقرير…',
    error: 'تعذّر تحميل تقرير الأعمار.', retry: 'إعادة المحاولة', empty: 'لا توجد التزامات مؤكدة مستحقة في هذا التاريخ.',
    note: 'يشمل الالتزامات المؤكدة غير الملغاة بالرصيد المتبقي كما في التاريخ المحدد.',
    counterparty: 'الطرف', dueOn: 'تاريخ الاستحقاق', daysOverdue: 'أيام التأخير', outstanding: 'المبلغ المستحق', bucket: 'الفئة', noDue: 'بدون تاريخ',
    buckets: { current: 'جاري / غير مستحق', days_1_30: '1–30 يوماً', days_31_60: '31–60 يوماً', days_61_90: '61–90 يوماً', days_over_90: 'أكثر من 90 يوماً' } as Record<Bucket, string>,
  },
  en: {
    title: 'AR/AP aging report', asOf: 'As of', run: 'Run report', receivables: 'Receivables (AR)', payables: 'Payables (AP)',
    sides: 'Report side', total: 'Total outstanding', count: (n: number) => `${n} ${n === 1 ? 'obligation' : 'obligations'}`, loading: 'Loading report…',
    error: 'Unable to load the aging report.', retry: 'Retry', empty: 'No confirmed obligations are outstanding on this date.',
    note: 'Includes confirmed, non-cancelled obligations at their remaining balance as of the selected date.',
    counterparty: 'Counterparty', dueOn: 'Due date', daysOverdue: 'Days overdue', outstanding: 'Outstanding', bucket: 'Bucket', noDue: 'No due date',
    buckets: { current: 'Current / not due', days_1_30: '1–30 days', days_31_60: '31–60 days', days_61_90: '61–90 days', days_over_90: '90+ days' } as Record<Bucket, string>,
  },
};
const fmt = (value: string) => Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function ObligationsAging({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { i18n } = useTranslation();
  const L = i18n.language === 'ar' ? labels.ar : labels.en;
  const [report, setReport] = useState<AgingReport | null>(null);
  const [asOf, setAsOf] = useState('');
  const [side, setSide] = useState<'receivables' | 'payables'>('receivables');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // With no date the server picks the operational (Riyadh) date and echoes it back, so the
  // browser clock never decides how an obligation is classified.
  const load = async (date?: string) => {
    setState('loading');
    try {
      const response = await fetch(`/api/obligations/aging${date ? `?as_of_date=${encodeURIComponent(date)}` : ''}`, { credentials: 'same-origin' });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error();
      const next = (await response.json()) as AgingReport;
      setReport(next);
      setAsOf(next.as_of_date);
      setState('ready');
    } catch {
      setState('error');
    }
  };
  useEffect(() => { void load(); }, []);
  const submit = (e: FormEvent) => { e.preventDefault(); if (asOf) void load(asOf); };
  const data = report?.[side];
  const company = useActiveCompanyName() ?? '';
  const ar = i18n.language === 'ar';
  const exportDoc = state === 'ready' && report && data ? agingExport({ ar, company, generatedAt: generatedStamp(), labels: { ...L, title: L.title }, side, asOf: report.as_of_date, data }) : null;

  return <section className="ob-aging" aria-labelledby="ob-aging-title">
    <div className="ob-aging__head">
      <h2 id="ob-aging-title">{L.title}</h2>
      <form className="ob-aging__form" onSubmit={submit}>
        <label><span>{L.asOf}</span><input type="date" required value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        <button className="primary" disabled={state === 'loading' || !asOf}>{L.run}</button>
      </form>
    </div>
    <p className="ob-aging__note">{L.note}</p>
    <ExportButtons language={i18n.language} document={exportDoc} landscape />
    <div className="workspace-tabs ob-aging__sides" role="tablist" aria-label={L.sides}>
      {(['receivables', 'payables'] as const).map((key) => <button key={key} role="tab" aria-selected={side === key} className={side === key ? 'active' : ''} onClick={() => setSide(key)}>{L[key]}</button>)}
    </div>
    {state === 'loading' && <WorkspaceState>{L.loading}</WorkspaceState>}
    {state === 'error' && <WorkspaceState tone="error" action={<button onClick={() => void load(asOf || undefined)}>{L.retry}</button>}>{L.error}</WorkspaceState>}
    {state === 'ready' && data && <>
      <dl className="ob-aging__buckets" aria-label={L[side]}>
        {data.buckets.map((b) => <div key={b.bucket} className={`ob-aging__bucket ob-aging__bucket--${b.bucket}`}><dt>{L.buckets[b.bucket]}</dt><dd><span dir="ltr">{fmt(b.amount)}</span><small>{L.count(b.count)}</small></dd></div>)}
        <div className="ob-aging__bucket ob-aging__bucket--total"><dt>{L.total}</dt><dd><span dir="ltr">{fmt(data.total_outstanding)}</span><small>{L.count(data.item_count)}</small></dd></div>
      </dl>
      {data.items.length === 0
        ? <WorkspaceState kind="empty">{L.empty}</WorkspaceState>
        : <div className="table-wrap ob-aging__table"><table>
          <thead><tr><th>{L.counterparty}</th><th>{L.dueOn}</th><th>{L.daysOverdue}</th><th>{L.bucket}</th><th>{L.outstanding}</th></tr></thead>
          <tbody>{data.items.map((item) => <tr key={item.obligation_id}>
            <td dir="auto">{item.counterparty_name}</td>
            <td><span dir="ltr">{item.due_on ?? L.noDue}</span></td>
            <td><span dir="ltr">{item.days_overdue}</span></td>
            <td>{L.buckets[item.bucket]}</td>
            <td><span dir="ltr">{fmt(item.outstanding_amount)}</span></td>
          </tr>)}</tbody>
          <tfoot><tr><th scope="row" colSpan={4}>{L.total}</th><th><span dir="ltr">{fmt(data.total_outstanding)}</span></th></tr></tfoot>
        </table></div>}
    </>}
  </section>;
}
