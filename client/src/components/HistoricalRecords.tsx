import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDisplayDate } from '../date-format';
import { PeriodForm, PeriodStatusForm, ReasonConfirmForm, VersionForm, VersionRow } from './HistoricalForms';
import { HistoricalVersion, Provenance } from './HistoricalVersion';
import { COMPLETENESS, RECONSTRUCTION, STATE, STATEMENT_TYPES, createCall, errorMessage, lookup } from './historicalLabels';
import './HistoricalRecords.css';

interface Period { id: string; label: string; period_start: string; period_end: string; completeness: string; reconstruction_status: string; status_reason: string; version_count?: number }
type Dialog = null | 'create' | 'status' | 'reopen' | 'official' | 'internal';

// C5-P4: historical financial records. Records only: nothing here reads or writes journals, fiscal years, closes or tax. The server enforces every
// capability and rule; this screen only hides what the user cannot do and explains the rest.
export function HistoricalRecords({ canManage, canApprove, onUnauthorized }: { canManage: boolean; canApprove: boolean; onUnauthorized: () => void }) {
  const { i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const tx = (a: string, e: string) => (ar ? a : e);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const call = useMemo(() => createCall(unauthorized), []);

  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [periodId, setPeriodId] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);

  const loadPeriods = useCallback(async () => {
    setLoading(true); setLoadFailed(false);
    try { setPeriods(((await call('/api/historical/periods')).periods as Period[]) ?? []); } catch (failure) { if ((failure as Error).message !== 'unauthorized') setLoadFailed(true); } finally { setLoading(false); }
  }, [call]);
  const loadVersions = useCallback(async (id: string) => {
    try { setVersions(((await call(`/api/historical/periods/${id}`)).versions as VersionRow[]) ?? []); }
    catch (failure) { if ((failure as Error).message !== 'unauthorized') { setVersions([]); setError(errorMessage(failure, ar)); } }
  }, [call, ar]);
  useEffect(() => { void loadPeriods(); }, [loadPeriods]);
  useEffect(() => { if (periodId) void loadVersions(periodId); else setVersions([]); }, [periodId, loadVersions]);

  const period = periods.find((p) => p.id === periodId) ?? null;
  const date = (value: string) => formatDisplayDate(value, i18n.language);
  const badge = (group: Record<string, { ar: string; en: string }>, key: string) => <span className={`hr-badge is-${key}`}>{lookup(group, key, ar)}</span>;
  const afterChange = () => { setDialog(null); void loadPeriods(); if (periodId) void loadVersions(periodId); };
  const completed = period?.reconstruction_status === 'completed';

  const periodTable = <div className="hr-table"><table><thead><tr><th>{tx('الفترة', 'Period')}</th><th>{tx('من', 'From')}</th><th>{tx('إلى', 'To')}</th><th>{tx('اكتمال السجلات', 'Completeness')}</th>
    <th>{tx('إعادة البناء', 'Reconstruction')}</th><th className="hr-num">{tx('النسخ', 'Versions')}</th><th /></tr></thead>
    <tbody>{periods.map((p) => <tr key={p.id}><td><bdi dir="auto">{p.label}</bdi></td><td><bdi dir="ltr">{date(p.period_start)}</bdi></td><td><bdi dir="ltr">{date(p.period_end)}</bdi></td>
      <td>{badge(COMPLETENESS, p.completeness)}</td><td>{badge(RECONSTRUCTION, p.reconstruction_status)}</td><td className="hr-num">{p.version_count ?? 0}</td>
      <td className="hr-row-actions"><button type="button" className="hr-ghost" onClick={() => { setPeriodId(p.id); setVersionId(null); setError(null); }}>{tx('فتح', 'Open')}</button></td></tr>)}</tbody></table></div>;

  const byStatement = Object.keys(STATEMENT_TYPES).map((key) => ({ key, rows: versions.filter((v) => v.statement_type === key) })).filter((g) => g.rows.length > 0);

  return <section className="panel historical-records" aria-labelledby="hr-title" dir={ar ? 'rtl' : 'ltr'}>
    <header className="hr-header"><h2 id="hr-title">{tx('السجلات المالية التاريخية', 'Historical Financial Records')}</h2>
      <p>{tx('سجلات لقوائم فترات سابقة (تقديمات رسمية وإعادة بناء داخلية). هذه السجلات لا تغيّر القيود ولا التقارير ولا الإقفال ولا الضرائب.', 'Records of statements for earlier periods (official submissions and internal reconstructions). These records change no journals, reports, closes or taxes.')}</p></header>
    {error && <div className="hr-error" role="alert">{error}</div>}

    {versionId && period ? <HistoricalVersion key={versionId} versionId={versionId} siblings={versions} reconstructionCompleted={completed} call={call} ar={ar} tx={tx} language={i18n.language}
      canManage={canManage} canApprove={canApprove} onBack={() => setVersionId(null)} onOpen={setVersionId} onChanged={() => { void loadPeriods(); void loadVersions(period.id); }} />
    : period ? <section className="hr-card" aria-labelledby="hr-period-title">
      <div className="hr-card__head"><div><button type="button" className="hr-ghost" onClick={() => { setPeriodId(null); setError(null); }}>{tx('كل الفترات', 'All periods')}</button><h3 id="hr-period-title"><bdi dir="auto">{period.label}</bdi></h3></div>
        <div className="hr-badges">{badge(COMPLETENESS, period.completeness)}{badge(RECONSTRUCTION, period.reconstruction_status)}</div></div>
      <dl className="hr-facts"><div><dt>{tx('الفترة', 'Dates')}</dt><dd><bdi dir="ltr">{date(period.period_start)} → {date(period.period_end)}</bdi></dd></div>
        <div><dt>{tx('سبب آخر تغيير', 'Last status reason')}</dt><dd><bdi dir="auto">{period.status_reason}</bdi></dd></div></dl>
      <div className="hr-actions">
        {canManage && <button type="button" className="hr-ghost" onClick={() => setDialog('status')}>{tx('تحديث الحالة', 'Update status')}</button>}
        {canApprove && completed && <button type="button" className="hr-dark" onClick={() => setDialog('reopen')}>{tx('إعادة فتح إعادة البناء', 'Reopen reconstruction')}</button>}
        {canManage && <button type="button" className="hr-primary" onClick={() => setDialog('official')}>{tx('تسجيل تقديم رسمي', 'Record official submission')}</button>}
        {canManage && <button type="button" className="hr-primary" disabled={completed} title={completed ? tx('إعادة البناء مكتملة؛ أعد فتحها أولاً.', 'Reconstruction is completed; reopen it first.') : undefined}
          onClick={() => setDialog('internal')}>{tx('مسودة إعادة بناء داخلية', 'New internal reconstruction')}</button>}
      </div>
      {byStatement.length === 0 ? <p className="hr-state">{tx('لا توجد نسخ لهذه الفترة بعد.', 'No versions for this period yet.')}</p> : byStatement.map(({ key, rows }) =>
        <section key={key} className="hr-section" aria-label={lookup(STATEMENT_TYPES, key, ar)}><h4>{lookup(STATEMENT_TYPES, key, ar)}</h4>
          <div className="hr-table"><table><thead><tr><th>{tx('النسخة', 'Version')}</th><th>{tx('النوع', 'Type')}</th><th>{tx('الحالة', 'State')}</th><th>{tx('العملة', 'Currency')}</th><th /></tr></thead>
            <tbody>{rows.map((v) => <tr key={v.id}><td>v{v.version_no}</td><td><Provenance provenance={v.provenance} ar={ar} /></td><td>{lookup(STATE, v.state, ar)}</td><td><bdi dir="ltr">{v.functional_currency}</bdi></td>
              <td className="hr-row-actions"><button type="button" className="hr-ghost" onClick={() => setVersionId(v.id)}>{tx('فتح', 'Open')}</button></td></tr>)}</tbody></table></div></section>)}
    </section>
    : <section className="hr-card" aria-labelledby="hr-list-title">
      <div className="hr-card__head"><h3 id="hr-list-title">{tx('الفترات التاريخية', 'Historical periods')}</h3>
        {canManage && <button type="button" className="hr-primary" onClick={() => setDialog('create')}>{tx('فترة جديدة', 'New period')}</button>}</div>
      {loading ? <p role="status" className="hr-state">{tx('جارٍ التحميل…', 'Loading…')}</p>
        : loadFailed ? <div className="hr-error" role="alert">{tx('تعذر تحميل الفترات.', 'The periods could not be loaded.')} <button type="button" className="hr-ghost" onClick={() => void loadPeriods()}>{tx('إعادة المحاولة', 'Retry')}</button></div>
        : periods.length === 0 ? <p className="hr-state">{tx('لا توجد فترات تاريخية بعد.', 'No historical periods yet.')}</p> : periodTable}
    </section>}

    {dialog === 'create' && <PeriodForm call={call} ar={ar} tx={tx} onClose={() => setDialog(null)} onDone={afterChange} />}
    {dialog === 'status' && period && <PeriodStatusForm call={call} ar={ar} tx={tx} period={period} onClose={() => setDialog(null)} onDone={afterChange} />}
    {dialog === 'reopen' && period && <ReasonConfirmForm title={tx('إعادة فتح إعادة البناء', 'Reopen reconstruction')} url={`/api/historical/periods/${period.id}/reopen-reconstruction`} call={call} ar={ar} tx={tx} danger
      reasonLabel={tx('سبب إعادة الفتح (إلزامي)', 'Reason for reopening (required)')} onClose={() => setDialog(null)} onDone={afterChange}
      confirmText={tx('أؤكد إعادة فتح إعادة البناء لهذه الفترة. تبقى النسخ المختومة كما هي.', 'I confirm reopening reconstruction for this period. Sealed versions stay as they are.')} submitLabel={tx('إعادة الفتح', 'Reopen')} />}
    {(dialog === 'official' || dialog === 'internal') && period && <VersionForm mode={dialog} periodId={period.id} basisChoices={versions} call={call} ar={ar} tx={tx} onClose={() => setDialog(null)}
      onDone={(id) => { setDialog(null); void loadPeriods(); void loadVersions(period.id); setVersionId(id); }} />}
  </section>;
}
