import { ReactNode, useCallback, useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { formatDisplayDateTime } from '../date-format';
import { formatMoney } from '../money-format';
import { ConfirmForm, CorrectionForm, LineForm, LineRow, ReasonConfirmForm, Tx, VersionForm, VersionRow } from './HistoricalForms';
import { CONFIDENCE, Call, DIFF_STATUS, PROVENANCE, REVIEW, REVIEW_DISCLAIMER, SOURCE_TYPES, STATE, STATEMENT_TYPES, errorMessage, lookup, pick } from './historicalLabels';

interface Comparison {
  version: CompareSide; basis: CompareSide; basis_source: string;
  lines: { line_code: string; label_ar: string | null; label_en: string | null; basis_amount: string | null; version_amount: string | null; difference: string; status: string }[];
  summary: { matching: number; changed: number; only_in_basis: number; only_in_version: number; net_difference: string };
}
interface CompareSide { id: string; version_no: number; state: string; provenance: string; source_type: string | null; confidence: string | null; evidence_reference: string | null; review_status: string }

type Dialogs = null | 'edit' | 'seal' | 'void' | 'correction' | 'review' | 'approve' | { line: LineRow | 'new' } | { remove: LineRow };

export const Provenance = ({ provenance, ar, withNote }: { provenance: string; ar: boolean; withNote?: boolean }) => {
  const p = PROVENANCE[provenance];
  if (!p) return null;
  return <>
    <span className={`hr-badge is-${p.tone}`} data-provenance={provenance}>{pick(p, ar)}</span>
    {withNote && <p className={`hr-banner is-${p.tone}`} role="note">{pick(p.note, ar)}</p>}
  </>;
};

export function HistoricalVersion({ versionId, siblings, reconstructionCompleted, call, ar, tx, language, canManage, canApprove, onBack, onOpen, onChanged }: {
  versionId: string; siblings: VersionRow[]; reconstructionCompleted: boolean; call: Call; ar: boolean; tx: Tx; language: string; canManage: boolean; canApprove: boolean;
  onBack: () => void; onOpen: (id: string) => void; onChanged: () => void;
}) {
  const [version, setVersion] = useState<VersionRow | null>(null);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [history, setHistory] = useState<VersionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [against, setAgainst] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setComparison(null);
    try {
      const body = await call(`/api/historical/versions/${versionId}`);
      setVersion(body.version as VersionRow); setLines((body.lines as LineRow[]) ?? []);
      try { setHistory(((await call(`/api/historical/versions/${versionId}/history`)).versions as VersionRow[]) ?? []); } catch { setHistory([]); }
    } catch (failure) { if ((failure as Error).message !== 'unauthorized') setError(errorMessage(failure, ar)); } finally { setLoading(false); }
  }, [call, versionId, ar]);
  useEffect(() => { void load(); }, [load]);

  const refresh = () => { setDialog(null); onChanged(); void load(); };
  const compare = async () => {
    setComparing(true); setError(null);
    try { setComparison((await call(`/api/historical/versions/${versionId}/comparison${against ? `?against=${against}` : ''}`)) as unknown as Comparison); }
    catch (failure) { if ((failure as Error).message !== 'unauthorized') { setComparison(null); setError(errorMessage(failure, ar)); } } finally { setComparing(false); }
  };
  const removeLine = async (line: LineRow) => {
    setRemoving(true); setError(null);
    try { await call(`/api/historical/versions/${versionId}/lines/${line.id}`, { method: 'DELETE' }); refresh(); }
    catch (failure) { if ((failure as Error).message !== 'unauthorized') setError(errorMessage(failure, ar)); setDialog(null); } finally { setRemoving(false); }
  };

  if (loading && !version) return <p role="status" className="hr-state">{tx('جارٍ التحميل…', 'Loading…')}</p>;
  if (!version) return <div><button type="button" className="hr-ghost" onClick={onBack}>{tx('رجوع', 'Back')}</button>{error && <div className="hr-error" role="alert">{error}</div>}</div>;

  const v = version;
  const draft = v.state === 'draft';
  const money = (amount: string | null) => (amount === null ? '—' : `${formatMoney(amount)} ${v.functional_currency}`);
  const labelOf = (l: { label_ar: string | null; label_en: string | null }) => (ar ? l.label_ar ?? l.label_en : l.label_en ?? l.label_ar) ?? '—';
  const doc = (id: string | null) => (id ? <a href={`/api/documents/${id}/file`} target="_blank" rel="noreferrer">{tx('فتح المستند', 'Open document')}</a> : '—');
  const when = (value: string | null) => (value ? formatDisplayDateTime(value, language) : '—');
  const basisVersion = siblings.find((s) => s.id === v.basis_version_id);
  const comparable = siblings.filter((s) => s.id !== v.id && s.statement_type === v.statement_type && s.state !== 'voided');
  // The comparison API does not check currencies, so the UI only compares versions that are known to share one functional currency.
  const target = siblings.find((s) => s.id === (against || v.basis_version_id));
  const currencyMismatch = !!target && target.functional_currency !== v.functional_currency;
  const targetUnknown = !!(against || v.basis_version_id) && !target;
  const canCompare = !!(against || v.basis_version_id) && !currencyMismatch && !targetUnknown;
  const canEditLines = canManage && draft;
  const fact = (label: string, value: ReactNode) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>;

  return <section className="hr-card" aria-labelledby="hr-version-title">
    <div className="hr-card__head">
      <div><button type="button" className="hr-ghost" onClick={onBack}>{tx('رجوع إلى الفترة', 'Back to period')}</button>
        <h3 id="hr-version-title">{lookup(STATEMENT_TYPES, v.statement_type, ar)} · v{v.version_no}</h3></div>
      <div className="hr-badges"><span className={`hr-badge is-${v.state}`}>{lookup(STATE, v.state, ar)}</span>
        {v.state === 'sealed' && <span className={`hr-badge is-review-${v.review_status}`}>{lookup(REVIEW, v.review_status, ar)}</span>}</div>
    </div>
    <div><Provenance provenance={v.provenance} ar={ar} withNote /></div>
    {error && <div className="hr-error" role="alert">{error}</div>}

    <dl className="hr-facts" aria-label={tx('بيانات النسخة', 'Version details')}>
      {fact(tx('عملة القوائم', 'Statement currency'), <bdi dir="ltr">{v.functional_currency}</bdi>)}
      {v.kind === 'official' ? <>
        {fact(tx('الجهة المقدَّم إليها', 'Submitted to'), v.submitted_to ?? '—')}
        {fact(tx('تاريخ التقديم', 'Submission date'), <bdi dir="ltr">{v.submission_date ?? '—'}</bdi>)}
        {fact(tx('رقم المرجع', 'Reference'), v.submission_reference ?? '—')}
        {fact(tx('مستند الإثبات', 'Proof document'), v.proof_level === 'proof_attached' ? doc(v.proof_document_id) : tx('لا يوجد (غير موثّق)', 'None (unverified)'))}
      </> : <>
        {fact(tx('نوع المصدر', 'Source type'), lookup(SOURCE_TYPES, v.source_type, ar))}
        {fact(tx('درجة الثقة', 'Confidence'), lookup(CONFIDENCE, v.confidence, ar))}
        {fact(tx('مرجع الدليل', 'Evidence reference'), v.evidence_reference ?? '—')}
        {fact(tx('مستند الدليل', 'Evidence document'), doc(v.evidence_document_id))}
        {fact(tx('الأساس', 'Basis'), basisVersion ? <button type="button" className="hr-link" onClick={() => onOpen(basisVersion.id)}>v{basisVersion.version_no}</button> : '—')}
        {fact(tx('ملاحظة الطريقة', 'Method note'), v.method_note ?? '—')}
      </>}
      {v.state === 'sealed' && <>
        {fact(tx('تاريخ الختم', 'Sealed at'), when(v.sealed_at))}
        {fact(tx('البصمة', 'Fingerprint'), <bdi dir="ltr" className="hr-fingerprint">{v.fingerprint}</bdi>)}
        {fact(tx('المراجعة الداخلية', 'Internal review'), `${lookup(REVIEW, v.review_status, ar)}${v.approved_at ? ` · ${when(v.approved_at)}` : v.reviewed_at ? ` · ${when(v.reviewed_at)}` : ''}`)}
      </>}
      {v.state === 'voided' && fact(tx('سبب الإلغاء', 'Void reason'), v.void_reason ?? '—')}
    </dl>
    {v.state === 'sealed' && <p className="hr-hint">{pick(REVIEW_DISCLAIMER, ar)}</p>}

    <div className="hr-actions">
      {canManage && draft && <button type="button" className="hr-ghost" onClick={() => setDialog('edit')}>{tx('تعديل البيانات', 'Edit details')}</button>}
      {canManage && draft && <button type="button" className="hr-primary" onClick={() => setDialog('seal')}>{tx('ختم النسخة', 'Seal version')}</button>}
      {canManage && draft && <button type="button" className="hr-dark" onClick={() => setDialog('void')}>{tx('إلغاء المسودة', 'Void draft')}</button>}
      {canManage && v.state === 'sealed' && <button type="button" className="hr-ghost" disabled={reconstructionCompleted}
        title={reconstructionCompleted ? tx('إعادة البناء مكتملة؛ أعد فتحها أولاً.', 'Reconstruction is completed; reopen it first.') : undefined} onClick={() => setDialog('correction')}>{tx('إنشاء تصحيح داخلي', 'Create internal correction')}</button>}
      {canApprove && v.state === 'sealed' && v.review_status === 'none' && <button type="button" className="hr-primary" onClick={() => setDialog('review')}>{tx('تسجيل مراجعة داخلية', 'Record internal review')}</button>}
      {canApprove && v.state === 'sealed' && v.review_status === 'reviewed' && <button type="button" className="hr-primary" onClick={() => setDialog('approve')}>{tx('اعتماد داخلي', 'Approve internally')}</button>}
    </div>

    <section aria-labelledby="hr-lines-title" className="hr-section">
      <div className="hr-card__head"><h4 id="hr-lines-title">{tx('بنود القائمة', 'Statement lines')}</h4>
        {canEditLines && <button type="button" className="hr-primary" onClick={() => setDialog({ line: 'new' })}>{tx('إضافة بند', 'Add line')}</button>}</div>
      {lines.length === 0 ? <p className="hr-state">{draft ? tx('لا توجد بنود بعد. أضف بنداً واحداً على الأقل قبل الختم.', 'No lines yet. Add at least one line before sealing.') : tx('لا توجد بنود.', 'No lines.')}</p> :
        <div className="hr-table"><table><thead><tr><th>#</th><th>{tx('رمز البند', 'Line code')}</th><th>{tx('الاسم', 'Label')}</th><th className="hr-num">{tx('المبلغ', 'Amount')}</th><th>{tx('مستند داعم', 'Supporting document')}</th><th>{tx('ملاحظة', 'Note')}</th>{canEditLines && <th />}</tr></thead>
          <tbody>{lines.map((l) => <tr key={l.id}><td>{l.line_no}</td><td><bdi dir="ltr">{l.line_code}</bdi></td><td><bdi dir="auto">{labelOf(l)}</bdi></td><td className="hr-num"><bdi dir="ltr">{money(l.amount)}</bdi></td>
            <td>{doc(l.supporting_document_id)}</td><td><bdi dir="auto">{l.note ?? '—'}</bdi></td>
            {canEditLines && <td className="hr-row-actions"><button type="button" className="hr-ghost" onClick={() => setDialog({ line: l })}>{tx('تعديل', 'Edit')}</button>
              <button type="button" className="hr-ghost" onClick={() => setDialog({ remove: l })}>{tx('حذف', 'Remove')}</button></td>}</tr>)}</tbody></table></div>}
    </section>

    <section aria-labelledby="hr-compare-title" className="hr-section">
      <div className="hr-card__head"><h4 id="hr-compare-title">{tx('مقارنة مالية', 'Financial comparison')}</h4></div>
      <p className="hr-hint">{tx('للقراءة فقط: لا تغيّر المقارنة أي سجل ولا أي قيد محاسبي.', 'Read-only: a comparison changes no record and no journal.')}</p>
      <div className="hr-compare-controls">
        <label>{tx('قارن مع', 'Compare with')}
          <select value={against} onChange={(e) => { setAgainst(e.target.value); setComparison(null); }}>
            <option value="">{v.basis_version_id ? tx('الأساس المعلن لهذه النسخة', 'This version\'s declared basis') : tx('اختر نسخة', 'Choose a version')}</option>
            {comparable.map((s) => <option key={s.id} value={s.id}>{`v${s.version_no} — ${pick(PROVENANCE[s.provenance], ar)} (${lookup(STATE, s.state, ar)}) · ${s.functional_currency}`}</option>)}</select></label>
        <button type="button" className="hr-primary" disabled={!canCompare || comparing} onClick={() => { if (canCompare) void compare(); }}>{comparing ? tx('جارٍ المقارنة…', 'Comparing…') : tx('عرض المقارنة', 'Show comparison')}</button>
      </div>
      {currencyMismatch && <div className="hr-error" role="alert" data-testid="currency-mismatch">
        {tx(`لا يمكن المقارنة المباشرة: عملة هذه النسخة ${v.functional_currency} وعملة النسخة المقارَن بها ${target!.functional_currency}. لا تُعرض فروق بين عملتين مختلفتين لأنها قد تكون مضللة. حوّل القائمتين إلى عملة واحدة خارج هذا السجل أو اختر نسخة بالعملة نفسها.`,
          `Direct comparison is not possible: this version is in ${v.functional_currency} and the compared version is in ${target!.functional_currency}. Differences between two currencies are not shown because they would be misleading. Convert both statements to one currency outside this record, or choose a version in the same currency.`)}</div>}
      {targetUnknown && <div className="hr-error" role="alert" data-testid="currency-unknown">{tx('تعذر التحقق من عملة النسخة المقارَن بها، لذلك لا تُعرض المقارنة. أعد تحميل الصفحة.', 'The currency of the compared version could not be verified, so the comparison is not shown. Reload the page.')}</div>}
      {comparison && <div aria-live="polite">
        <div className="hr-sides">{[{ side: comparison.basis, title: tx('الأصل (المقارَن به)', 'Original (compared against)') }, { side: comparison.version, title: tx('هذه النسخة', 'This version') }].map(({ side, title }) =>
          <div className="hr-side" key={title}><strong>{title} · v{side.version_no}</strong><Provenance provenance={side.provenance} ar={ar} />
            <span>{tx('المصدر', 'Source')}: {lookup(SOURCE_TYPES, side.source_type, ar)}</span><span>{tx('الثقة', 'Confidence')}: {lookup(CONFIDENCE, side.confidence, ar)}</span>
            <span>{tx('المراجعة', 'Review')}: {lookup(REVIEW, side.review_status, ar)}</span></div>)}</div>
        <p className="hr-summary">{tx(`مطابق ${comparison.summary.matching} · متغيّر ${comparison.summary.changed} · في الأصل فقط ${comparison.summary.only_in_basis} · في هذه النسخة فقط ${comparison.summary.only_in_version} · صافي الفرق`, `Matching ${comparison.summary.matching} · Changed ${comparison.summary.changed} · Only in original ${comparison.summary.only_in_basis} · Only in this version ${comparison.summary.only_in_version} · Net difference`)} <bdi dir="ltr">{money(comparison.summary.net_difference)}</bdi></p>
        {comparison.lines.length === 0 ? <p className="hr-state">{tx('لا توجد بنود للمقارنة.', 'No lines to compare.')}</p> :
          <div className="hr-table"><table><thead><tr><th>{tx('البند', 'Line')}</th><th className="hr-num">{tx('المبلغ الأصلي', 'Original amount')}</th><th className="hr-num">{tx('المبلغ المقارَن', 'Compared amount')}</th><th className="hr-num">{tx('الفرق', 'Difference')}</th><th>{tx('الحالة', 'Status')}</th></tr></thead>
            <tbody>{comparison.lines.map((l) => <tr key={l.line_code} className={`is-${l.status}`}><td><bdi dir="ltr">{l.line_code}</bdi><br />{labelOf(l)}</td>
              <td className="hr-num"><bdi dir="ltr">{money(l.basis_amount)}</bdi></td><td className="hr-num"><bdi dir="ltr">{money(l.version_amount)}</bdi></td>
              <td className="hr-num"><bdi dir="ltr">{money(l.difference)}</bdi></td><td><span className={`hr-badge is-diff-${l.status}`}>{lookup(DIFF_STATUS, l.status, ar)}</span></td></tr>)}</tbody></table></div>}
      </div>}
    </section>

    <section aria-labelledby="hr-history-title" className="hr-section">
      <div className="hr-card__head"><h4 id="hr-history-title">{tx('سجل النسخ', 'Version history')}</h4></div>
      {history.length === 0 ? <p className="hr-state">—</p> :
        <div className="hr-table"><table><thead><tr><th>{tx('النسخة', 'Version')}</th><th>{tx('النوع', 'Type')}</th><th>{tx('الحالة', 'State')}</th><th>{tx('المراجعة', 'Review')}</th><th>{tx('الأساس', 'Basis')}</th><th /></tr></thead>
          <tbody>{history.map((h) => <tr key={h.id} aria-current={h.id === v.id || undefined}><td>v{h.version_no}</td><td><Provenance provenance={h.provenance} ar={ar} /></td><td>{lookup(STATE, h.state, ar)}</td>
            <td>{h.state === 'sealed' ? lookup(REVIEW, h.review_status, ar) : '—'}</td><td>{history.find((x) => x.id === h.basis_version_id) ? `v${history.find((x) => x.id === h.basis_version_id)!.version_no}` : '—'}</td>
            <td>{h.id !== v.id && <button type="button" className="hr-ghost" onClick={() => onOpen(h.id)}>{tx('فتح', 'Open')}</button>}</td></tr>)}</tbody></table></div>}
    </section>

    {dialog === 'edit' && <VersionForm mode={v.kind} periodId={v.period_id} version={v} basisChoices={siblings} call={call} ar={ar} tx={tx} onClose={() => setDialog(null)} onDone={refresh} />}
    {dialog === 'seal' && <ConfirmForm title={tx('ختم النسخة', 'Seal version')} url={`/api/historical/versions/${v.id}/seal`} call={call} ar={ar} tx={tx} onClose={() => setDialog(null)} onDone={refresh}
      lines={[tx('الختم نهائي: بعده لا تُعدَّل البنود ولا البيانات، وتُحسب بصمة للنسخة. تُصحَّح الأخطاء لاحقاً بنسخة داخلية جديدة فقط.', 'Sealing is final: afterwards the lines and details cannot change and a fingerprint is computed. Errors are fixed later only with a new internal version.'),
        tx(`عدد البنود: ${lines.length}`, `Number of lines: ${lines.length}`)]}
      confirmText={tx('أؤكد مراجعة البنود وأريد ختم هذه النسخة.', 'I confirm I reviewed the lines and want to seal this version.')} submitLabel={tx('ختم نهائي', 'Seal permanently')} />}
    {dialog === 'void' && <ReasonConfirmForm title={tx('إلغاء المسودة', 'Void draft')} url={`/api/historical/versions/${v.id}/void`} call={call} ar={ar} tx={tx} danger onClose={() => setDialog(null)} onDone={refresh}
      reasonLabel={tx('سبب الإلغاء (إلزامي)', 'Void reason (required)')} confirmText={tx('أؤكد إلغاء هذه المسودة. تبقى في السجل ولا تُحذف.', 'I confirm voiding this draft. It stays in the history and is not deleted.')} submitLabel={tx('تأكيد الإلغاء', 'Confirm void')} />}
    {dialog === 'correction' && <CorrectionForm basis={v} call={call} ar={ar} tx={tx} onClose={() => setDialog(null)} onDone={(id) => { setDialog(null); onChanged(); onOpen(id); }} />}
    {(dialog === 'review' || dialog === 'approve') && <ConfirmForm title={dialog === 'review' ? tx('تسجيل مراجعة داخلية', 'Record internal review') : tx('اعتماد داخلي', 'Approve internally')}
      url={`/api/historical/versions/${v.id}/review`} body={{ action: dialog }} call={call} ar={ar} tx={tx} onClose={() => setDialog(null)} onDone={refresh}
      lines={[pick(REVIEW_DISCLAIMER, ar), tx('هذا لا يعدّل البنود ولا يغيّر أي قيد محاسبي.', 'This does not change the lines or any journal.')]}
      confirmText={dialog === 'review' ? tx('أؤكد أنني راجعت هذه النسخة داخلياً.', 'I confirm I reviewed this version internally.') : tx('أؤكد الاعتماد الداخلي وأفهم أنه ليس قبولاً حكومياً.', 'I confirm the internal approval and understand it is not government acceptance.')}
      submitLabel={dialog === 'review' ? tx('تسجيل المراجعة', 'Record review') : tx('اعتماد داخلي', 'Approve internally')} />}
    {typeof dialog === 'object' && dialog && 'line' in dialog && <LineForm versionId={v.id} line={dialog.line === 'new' ? undefined : dialog.line} currency={v.functional_currency} call={call} ar={ar} tx={tx} onClose={() => setDialog(null)} onDone={refresh} />}
    {typeof dialog === 'object' && dialog && 'remove' in dialog && <ConfirmRemove line={dialog.remove} busy={removing} tx={tx} onCancel={() => setDialog(null)} onConfirm={() => void removeLine(dialog.remove)} />}
  </section>;
}

function ConfirmRemove({ line, busy, tx, onCancel, onConfirm }: { line: LineRow; busy: boolean; tx: Tx; onCancel: () => void; onConfirm: () => void }) {
  return <Dialog title={tx('حذف بند', 'Remove line')} busy={busy} onClose={onCancel} className="hr-dialog">
    <p className="hr-note">{tx(`سيُحذف البند ${line.line_code} من هذه المسودة.`, `Line ${line.line_code} will be removed from this draft.`)}</p>
    <div className="modal-actions"><button type="button" onClick={onCancel} disabled={busy}>{tx('رجوع', 'Back')}</button>
      <button type="button" className="danger" onClick={onConfirm} disabled={busy}>{busy ? tx('جارٍ الحذف…', 'Removing…') : tx('تأكيد الحذف', 'Confirm removal')}</button></div>
  </Dialog>;
}
