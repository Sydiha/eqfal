import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { CONFIDENCE, Call, PROVENANCE, SOURCE_TYPES, STATEMENT_TYPES, errorMessage, isValidAmount, isValidCurrency, isValidLineCode, jsonInit, normalizeAmount, pick } from './historicalLabels';

export type Tx = (a: string, e: string) => string;
export interface DocOption { id: string; original_filename: string }
export interface VersionRow {
  id: string; period_id: string; kind: 'official' | 'internal'; statement_type: string; version_no: number; state: 'draft' | 'sealed' | 'voided'; functional_currency: string;
  submitted_to: string | null; submission_date: string | null; submission_reference: string | null; proof_level: string | null; proof_document_id: string | null;
  internal_purpose: string | null; basis_version_id: string | null; source_type: string | null; confidence: string | null; evidence_reference: string | null;
  evidence_document_id: string | null; method_note: string | null; fingerprint: string | null; sealed_at: string | null; review_status: 'none' | 'reviewed' | 'approved';
  reviewed_at: string | null; approved_at: string | null; void_reason: string | null; created_at: string; provenance: string;
}
export interface LineRow { id: string; line_no: number; line_code: string; label_ar: string | null; label_en: string | null; amount: string; supporting_document_id: string | null; note: string | null }

/** Existing company-owned documents, loaded once when a form needs them. Without document.view the list stays empty and the form says so. */
export function useDocuments(call: Call) {
  const [docs, setDocs] = useState<DocOption[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    call('/api/documents').then((body) => { if (live) setDocs(((body.documents as DocOption[]) ?? []).map((d) => ({ id: d.id, original_filename: d.original_filename }))); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [call]);
  return { docs, failed };
}

function DocSelect({ label, value, onChange, docs, failed, required, tx }: { label: string; value: string; onChange: (id: string) => void; docs: DocOption[]; failed: boolean; required?: boolean; tx: Tx }) {
  return <label>{label}
    <select value={value} required={required} onChange={(e) => onChange(e.target.value)}>
      <option value="">{required ? tx('اختر مستنداً', 'Choose a document') : tx('بدون مستند', 'No document')}</option>
      {docs.map((d) => <option key={d.id} value={d.id}>{d.original_filename}</option>)}
    </select>
    {failed && <span className="hr-hint">{tx('تعذر تحميل المستندات (قد لا تملك صلاحية عرضها).', 'Documents could not be loaded (you may lack permission to view them).')}</span>}
    {!failed && docs.length === 0 && <span className="hr-hint">{tx('لا توجد مستندات مرفوعة. ارفع المستند من شاشة المستندات أولاً.', 'No uploaded documents. Upload the document from the Documents screen first.')}</span>}
  </label>;
}

function FormShell({ title, busy, error, onClose, onSubmit, submitLabel, canSubmit, tx, children, danger }: { title: string; busy: boolean; error: string | null; onClose: () => void; onSubmit: (e: FormEvent) => void;
  submitLabel: string; canSubmit: boolean; tx: Tx; children: ReactNode; danger?: boolean }) {
  return <Dialog title={title} busy={busy} onClose={onClose} size="wide" className="hr-dialog">
    {error && <div className="hr-error" role="alert">{error}</div>}
    <form onSubmit={onSubmit} className="hr-form">
      {children}
      <div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>{tx('رجوع', 'Back')}</button>
        <button type="submit" className={danger ? 'danger' : 'primary'} disabled={busy || !canSubmit}>{busy ? tx('جارٍ التنفيذ…', 'Working…') : submitLabel}</button></div>
    </form>
  </Dialog>;
}

function useSubmit(ar: boolean, run: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try { await run(); } catch (failure) { if ((failure as Error).message !== 'unauthorized') setError(errorMessage(failure, ar)); } finally { setBusy(false); }
  };
  return { busy, error, submit };
}

const ConfirmCheck = ({ checked, onChange, text }: { checked: boolean; onChange: (v: boolean) => void; text: string }) =>
  <label className="hr-check"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span>{text}</span></label>;

// ------------------------------------------------------------------ period

export function PeriodForm({ call, ar, tx, onClose, onDone }: { call: Call; ar: boolean; tx: Tx; onClose: () => void; onDone: () => void }) {
  const [label, setLabel] = useState(''); const [start, setStart] = useState(''); const [end, setEnd] = useState('');
  const [completeness, setCompleteness] = useState('incomplete'); const [reason, setReason] = useState('');
  const { busy, error, submit } = useSubmit(ar, async () => {
    await call('/api/historical/periods', jsonInit('POST', { label: label.trim(), period_start: start, period_end: end, completeness, reason: reason.trim() })); onDone();
  });
  const rangeBad = !!start && !!end && start >= end;
  return <FormShell title={tx('فترة تاريخية جديدة', 'New historical period')} busy={busy} error={error} onClose={onClose} onSubmit={submit} tx={tx} submitLabel={tx('إنشاء الفترة', 'Create period')}
    canSubmit={!!label.trim() && !!start && !!end && !rangeBad && !!reason.trim()}>
    <label>{tx('اسم الفترة', 'Period label')}<input value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} required /></label>
    <div className="hr-grid">
      <label>{tx('من تاريخ', 'From')}<input type="date" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
      <label>{tx('إلى تاريخ', 'To')}<input type="date" value={end} aria-invalid={rangeBad || undefined} onChange={(e) => setEnd(e.target.value)} required /></label>
    </div>
    {rangeBad && <p className="hr-error" role="alert">{tx('تاريخ البداية يجب أن يسبق تاريخ النهاية.', 'The start date must be before the end date.')}</p>}
    <label>{tx('اكتمال السجلات', 'Record completeness')}
      <select value={completeness} onChange={(e) => setCompleteness(e.target.value)}>
        <option value="incomplete">{tx('غير مكتملة', 'Incomplete')}</option><option value="complete">{tx('مكتملة', 'Complete')}</option></select></label>
    <label>{tx('السبب (إلزامي)', 'Reason (required)')}<textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} required /></label>
    <p className="hr-hint">{tx('قد تتزامن الفترة التاريخية مع سنة مالية. لا يغيّر هذا السجل أي قيد أو تقرير أو إقفال.', 'A historical period may coexist with a fiscal year. This record changes no journal, report or close.')}</p>
  </FormShell>;
}

export function PeriodStatusForm({ call, ar, tx, period, onClose, onDone }: { call: Call; ar: boolean; tx: Tx; period: { id: string; completeness: string; reconstruction_status: string }; onClose: () => void; onDone: () => void }) {
  const next = period.reconstruction_status === 'not_started' ? 'in_progress' : period.reconstruction_status === 'in_progress' ? 'completed' : null;
  const [completeness, setCompleteness] = useState(period.completeness); const [advance, setAdvance] = useState(false); const [reason, setReason] = useState('');
  const changed = completeness !== period.completeness || advance;
  const { busy, error, submit } = useSubmit(ar, async () => {
    const body: Record<string, unknown> = { reason: reason.trim() };
    if (completeness !== period.completeness) body['completeness'] = completeness;
    if (advance && next) body['reconstruction_status'] = next;
    await call(`/api/historical/periods/${period.id}/status`, jsonInit('PATCH', body)); onDone();
  });
  return <FormShell title={tx('تحديث حالة الفترة', 'Update period status')} busy={busy} error={error} onClose={onClose} onSubmit={submit} tx={tx} submitLabel={tx('حفظ الحالة', 'Save status')} canSubmit={changed && !!reason.trim()}>
    <label>{tx('اكتمال السجلات', 'Record completeness')}
      <select value={completeness} onChange={(e) => setCompleteness(e.target.value)}>
        <option value="incomplete">{tx('غير مكتملة', 'Incomplete')}</option><option value="complete">{tx('مكتملة', 'Complete')}</option></select></label>
    {next ? <ConfirmCheck checked={advance} onChange={setAdvance} text={next === 'in_progress' ? tx('بدء إعادة البناء (الانتقال إلى «قيد الإعداد»).', 'Start reconstruction (move to "In progress").') : tx('إكمال إعادة البناء. بعد ذلك لا تُنشأ نسخ داخلية جديدة قبل إعادة الفتح بسبب وصلاحية اعتماد.', 'Complete reconstruction. After this no new internal versions can be made until it is reopened with a reason and approval permission.')} />
      : <p className="hr-hint">{tx('إعادة البناء مكتملة. لإعادة فتحها استخدم «إعادة فتح» (يتطلب صلاحية الاعتماد).', 'Reconstruction is completed. Use "Reopen" to reopen it (needs approval permission).')}</p>}
    <label>{tx('السبب (إلزامي)', 'Reason (required)')}<textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} required /></label>
  </FormShell>;
}

export function ReasonConfirmForm({ title, reasonLabel, confirmText, submitLabel, url, method = 'POST', ar, tx, call, danger, onClose, onDone, extraBody }: { title: string; reasonLabel: string; confirmText: string;
  submitLabel: string; url: string; method?: string; ar: boolean; tx: Tx; call: Call; danger?: boolean; onClose: () => void; onDone: () => void; extraBody?: Record<string, unknown> }) {
  const [reason, setReason] = useState(''); const [ok, setOk] = useState(false);
  const { busy, error, submit } = useSubmit(ar, async () => { await call(url, jsonInit(method, { ...extraBody, reason: reason.trim(), confirm: true })); onDone(); });
  return <FormShell title={title} busy={busy} error={error} onClose={onClose} onSubmit={submit} tx={tx} submitLabel={submitLabel} canSubmit={ok && !!reason.trim()} danger={danger}>
    <label>{reasonLabel}<textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} required /></label>
    <ConfirmCheck checked={ok} onChange={setOk} text={confirmText} />
  </FormShell>;
}

/** Confirm-only action (seal, review, approve): no reason field, explicit tick, `confirm: true` goes to the API. */
export function ConfirmForm({ title, lines, confirmText, submitLabel, url, body, ar, tx, call, onClose, onDone }: { title: string; lines: string[]; confirmText: string; submitLabel: string; url: string;
  body?: Record<string, unknown>; ar: boolean; tx: Tx; call: Call; onClose: () => void; onDone: () => void }) {
  const [ok, setOk] = useState(false);
  const { busy, error, submit } = useSubmit(ar, async () => { await call(url, jsonInit('POST', { ...body, confirm: true })); onDone(); });
  return <FormShell title={title} busy={busy} error={error} onClose={onClose} onSubmit={submit} tx={tx} submitLabel={submitLabel} canSubmit={ok}>
    {lines.map((l) => <p key={l} className="hr-note">{l}</p>)}
    <ConfirmCheck checked={ok} onChange={setOk} text={confirmText} />
  </FormShell>;
}

// ----------------------------------------------------------------- version

const emptyToNull = (v: string): string | null => (v.trim() ? v.trim() : null);

/** Creates an official or an internal-reconstruction draft, or edits the metadata of an existing draft. */
export function VersionForm({ mode, periodId, version, basisChoices, call, ar, tx, onClose, onDone }: { mode: 'official' | 'internal'; periodId: string; version?: VersionRow;
  basisChoices: VersionRow[]; call: Call; ar: boolean; tx: Tx; onClose: () => void; onDone: (id: string) => void }) {
  const editing = !!version;
  const { docs, failed } = useDocuments(call);
  const [statement, setStatement] = useState(version?.statement_type ?? 'financial_position');
  const [currency, setCurrency] = useState(version?.functional_currency ?? '');
  const [to, setTo] = useState(version?.submitted_to ?? ''); const [date, setDate] = useState(version?.submission_date ?? ''); const [ref, setRef] = useState(version?.submission_reference ?? '');
  const [proof, setProof] = useState(version?.proof_level ?? 'declared_unverified'); const [proofDoc, setProofDoc] = useState(version?.proof_document_id ?? '');
  const [source, setSource] = useState(version?.source_type ?? 'management_reconciliation'); const [confidence, setConfidence] = useState(version?.confidence ?? 'medium');
  const [evidenceRef, setEvidenceRef] = useState(version?.evidence_reference ?? ''); const [evidenceDoc, setEvidenceDoc] = useState(version?.evidence_document_id ?? '');
  const [note, setNote] = useState(version?.method_note ?? ''); const [basis, setBasis] = useState(version?.basis_version_id ?? '');
  const [ackUnverified, setAckUnverified] = useState(editing);
  const official = mode === 'official';
  const unverified = official && proof === 'declared_unverified';
  const { busy, error, submit } = useSubmit(ar, async () => {
    let body: Record<string, unknown>;
    if (official) {
      body = { functional_currency: currency, submitted_to: to.trim(), submission_date: date, submission_reference: emptyToNull(ref), proof_level: proof, proof_document_id: proof === 'proof_attached' ? proofDoc : null };
    } else {
      body = { functional_currency: currency, source_type: source, confidence, evidence_reference: emptyToNull(evidenceRef), evidence_document_id: evidenceDoc || null, method_note: emptyToNull(note) };
      if (!editing || version?.internal_purpose === 'reconstruction') body['basis_version_id'] = basis || null;
    }
    if (editing) {
      await call(`/api/historical/versions/${version!.id}`, jsonInit('PATCH', body)); onDone(version!.id);
    } else {
      const created = await call(`/api/historical/periods/${periodId}/versions`, jsonInit('POST', { kind: mode, statement_type: statement, ...(official ? {} : { internal_purpose: 'reconstruction' }), ...body }));
      onDone((created.version as VersionRow).id);
    }
  });
  const valid = isValidCurrency(currency) && (!official || (!!to.trim() && !!date && (proof === 'declared_unverified' ? ackUnverified : !!proofDoc)));
  const title = editing ? tx('تعديل بيانات المسودة', 'Edit draft details') : official ? tx('سجل تقديم رسمي', 'Official submission record') : tx('مسودة إعادة بناء داخلية', 'Internal reconstruction draft');
  return <FormShell title={title} busy={busy} error={error} onClose={onClose} onSubmit={submit} tx={tx} canSubmit={valid} submitLabel={editing ? tx('حفظ', 'Save') : tx('إنشاء المسودة', 'Create draft')}>
    <div className="hr-grid">
      <label>{tx('نوع القائمة', 'Statement type')}
        <select value={statement} disabled={editing} onChange={(e) => setStatement(e.target.value)}>{Object.entries(STATEMENT_TYPES).map(([k, v]) => <option key={k} value={k}>{pick(v, ar)}</option>)}</select></label>
      <label>{tx('عملة القوائم (رمز من 3 أحرف)', 'Statement currency (3-letter code)')}
        <input value={currency} maxLength={3} dir="ltr" placeholder="SAR" aria-invalid={(!!currency && !isValidCurrency(currency)) || undefined} onChange={(e) => setCurrency(e.target.value.toUpperCase())} required /></label>
    </div>
    {official ? <>
      <div className="hr-grid">
        <label>{tx('الجهة المقدَّم إليها', 'Submitted to')}<input value={to} maxLength={200} onChange={(e) => setTo(e.target.value)} required /></label>
        <label>{tx('تاريخ التقديم', 'Submission date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
      </div>
      <label>{tx('رقم المرجع (اختياري)', 'Reference number (optional)')}<input value={ref} maxLength={200} dir="ltr" onChange={(e) => setRef(e.target.value)} /></label>
      <fieldset className="hr-fieldset"><legend>{tx('مستوى الإثبات', 'Level of proof')}</legend>
        <label className="hr-check"><input type="radio" name="proof" checked={proof === 'proof_attached'} onChange={() => setProof('proof_attached')} /><span>{tx('مع إثبات: أرفق مستنداً موجوداً من مستندات الشركة', 'With proof: attach an existing company document')}</span></label>
        <label className="hr-check"><input type="radio" name="proof" checked={proof === 'declared_unverified'} onChange={() => setProof('declared_unverified')} /><span>{tx('إقرار المستخدم دون إثبات (غير موثّق)', 'User declaration without proof (unverified)')}</span></label>
      </fieldset>
      {proof === 'proof_attached' && <DocSelect label={tx('مستند الإثبات', 'Proof document')} value={proofDoc} onChange={setProofDoc} docs={docs} failed={failed} required tx={tx} />}
      {unverified && <div className="hr-unverified" role="note"><strong>{pick(PROVENANCE['official_declared_unverified']!, ar)}</strong><p>{pick(PROVENANCE['official_declared_unverified']!.note, ar)}</p>
        {!editing && <ConfirmCheck checked={ackUnverified} onChange={setAckUnverified} text={tx('أقرّ بأنني أسجّل هذا التقديم دون إثبات وأنه سيظهر دائماً بوصف «غير موثّق».', 'I acknowledge I am recording this submission without proof and that it will always be shown as "unverified".')} />}</div>}
    </> : <>
      <div className="hr-grid">
        <label>{tx('نوع المصدر', 'Source type')}<select value={source} onChange={(e) => setSource(e.target.value)}>{Object.entries(SOURCE_TYPES).map(([k, v]) => <option key={k} value={k}>{pick(v, ar)}</option>)}</select></label>
        <label>{tx('درجة الثقة', 'Confidence')}<select value={confidence} onChange={(e) => setConfidence(e.target.value)}>{Object.entries(CONFIDENCE).map(([k, v]) => <option key={k} value={k}>{pick(v, ar)}</option>)}</select></label>
      </div>
      <label>{tx('مرجع الدليل (اختياري)', 'Evidence reference (optional)')}<input value={evidenceRef} maxLength={500} onChange={(e) => setEvidenceRef(e.target.value)} /></label>
      <DocSelect label={tx('مستند الدليل (اختياري)', 'Evidence document (optional)')} value={evidenceDoc} onChange={setEvidenceDoc} docs={docs} failed={failed} tx={tx} />
      {(!editing || version?.internal_purpose === 'reconstruction') && <label>{tx('نسخة أساس للمقارنة (اختياري، مختومة فقط)', 'Basis version to compare with (optional, sealed only)')}
        <select value={basis} onChange={(e) => setBasis(e.target.value)}><option value="">{tx('بدون أساس', 'No basis')}</option>
          {basisChoices.filter((v) => v.state === 'sealed' && v.statement_type === statement).map((v) => <option key={v.id} value={v.id}>{`v${v.version_no} — ${pick(PROVENANCE[v.provenance], ar)}`}</option>)}</select></label>}
      <label>{tx('ملاحظة عن الطريقة (اختياري)', 'Method note (optional)')}<textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></label>
      <p className="hr-hint">{pick(PROVENANCE['internal_reconstruction']!.note, ar)}</p>
    </>}
  </FormShell>;
}

export function CorrectionForm({ basis, call, ar, tx, onClose, onDone }: { basis: VersionRow; call: Call; ar: boolean; tx: Tx; onClose: () => void; onDone: (id: string) => void }) {
  const { docs, failed } = useDocuments(call);
  const [source, setSource] = useState('management_reconciliation'); const [confidence, setConfidence] = useState('medium');
  const [evidenceRef, setEvidenceRef] = useState(''); const [evidenceDoc, setEvidenceDoc] = useState(''); const [note, setNote] = useState(''); const [ok, setOk] = useState(false);
  const { busy, error, submit } = useSubmit(ar, async () => {
    const created = await call(`/api/historical/versions/${basis.id}/corrections`, jsonInit('POST', { source_type: source, confidence, evidence_reference: emptyToNull(evidenceRef), evidence_document_id: evidenceDoc || null, method_note: emptyToNull(note), confirm: true }));
    onDone((created.version as VersionRow).id);
  });
  return <FormShell title={tx('إنشاء تصحيح داخلي', 'Create internal correction')} busy={busy} error={error} onClose={onClose} onSubmit={submit} tx={tx} submitLabel={tx('إنشاء مسودة التصحيح', 'Create correction draft')} canSubmit={ok}>
    <p className="hr-note">{tx(`ستُنشأ مسودة داخلية جديدة منسوخة من بنود النسخة v${basis.version_no}. النسخة الأصلية المختومة تبقى كما هي دون أي تعديل.`, `A new internal draft is created, copied from the lines of v${basis.version_no}. The sealed original stays exactly as it is.`)}</p>
    <div className="hr-grid">
      <label>{tx('نوع المصدر', 'Source type')}<select value={source} onChange={(e) => setSource(e.target.value)}>{Object.entries(SOURCE_TYPES).map(([k, v]) => <option key={k} value={k}>{pick(v, ar)}</option>)}</select></label>
      <label>{tx('درجة الثقة', 'Confidence')}<select value={confidence} onChange={(e) => setConfidence(e.target.value)}>{Object.entries(CONFIDENCE).map(([k, v]) => <option key={k} value={k}>{pick(v, ar)}</option>)}</select></label>
    </div>
    <label>{tx('مرجع الدليل (اختياري)', 'Evidence reference (optional)')}<input value={evidenceRef} maxLength={500} onChange={(e) => setEvidenceRef(e.target.value)} /></label>
    <DocSelect label={tx('مستند الدليل (اختياري)', 'Evidence document (optional)')} value={evidenceDoc} onChange={setEvidenceDoc} docs={docs} failed={failed} tx={tx} />
    <label>{tx('سبب التصحيح وطريقته (اختياري)', 'Why and how it is corrected (optional)')}<textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></label>
    <ConfirmCheck checked={ok} onChange={setOk} text={tx('أؤكد أن هذا تصحيح داخلي وليس تقديماً رسمياً جديداً.', 'I confirm this is an internal correction, not a new official submission.')} />
  </FormShell>;
}

export function LineForm({ versionId, line, currency, call, ar, tx, onClose, onDone }: { versionId: string; line?: LineRow; currency: string; call: Call; ar: boolean; tx: Tx; onClose: () => void; onDone: () => void }) {
  const { docs, failed } = useDocuments(call);
  const [code, setCode] = useState(line?.line_code ?? ''); const [labelAr, setLabelAr] = useState(line?.label_ar ?? ''); const [labelEn, setLabelEn] = useState(line?.label_en ?? '');
  const [amount, setAmount] = useState(line?.amount ?? ''); const [doc, setDoc] = useState(line?.supporting_document_id ?? ''); const [note, setNote] = useState(line?.note ?? '');
  const normalized = normalizeAmount(amount);
  const amountBad = !!amount && !isValidAmount(normalized);
  const { busy, error, submit } = useSubmit(ar, async () => {
    const body = { line_code: code.trim(), label_ar: emptyToNull(labelAr), label_en: emptyToNull(labelEn), amount: normalized, supporting_document_id: doc || null, note: emptyToNull(note) };
    if (line) await call(`/api/historical/versions/${versionId}/lines/${line.id}`, jsonInit('PATCH', body));
    else await call(`/api/historical/versions/${versionId}/lines`, jsonInit('POST', { ...body, label_ar: body.label_ar ?? undefined, label_en: body.label_en ?? undefined, supporting_document_id: body.supporting_document_id ?? undefined, note: body.note ?? undefined }));
    onDone();
  });
  return <FormShell title={line ? tx('تعديل بند', 'Edit line') : tx('إضافة بند', 'Add line')} busy={busy} error={error} onClose={onClose} onSubmit={submit} tx={tx} submitLabel={tx('حفظ البند', 'Save line')}
    canSubmit={isValidLineCode(code) && isValidAmount(normalized) && (!!labelAr.trim() || !!labelEn.trim())}>
    <label>{tx('رمز البند', 'Line code')}<input value={code} maxLength={100} dir="ltr" onChange={(e) => setCode(e.target.value)} required />
      <span className="hr-hint">{tx('لا يوجد كتالوج معتمد لرموز البنود حالياً؛ أدخل الرمز كما يرد في القائمة المصدر. يجب ألا يتكرر داخل النسخة.', 'There is no approved line-code catalog yet; enter the code as it appears in the source statement. It must be unique within the version.')}</span></label>
    <div className="hr-grid">
      <label>{tx('الاسم بالعربية', 'Arabic label')}<input value={labelAr} maxLength={300} dir="rtl" onChange={(e) => setLabelAr(e.target.value)} /></label>
      <label>{tx('الاسم بالإنجليزية', 'English label')}<input value={labelEn} maxLength={300} dir="ltr" onChange={(e) => setLabelEn(e.target.value)} /></label>
    </div>
    <p className="hr-hint">{tx('يلزم اسم بلغة واحدة على الأقل.', 'At least one label is required.')}</p>
    <label>{tx(`المبلغ (${currency})`, `Amount (${currency})`)}<input value={amount} inputMode="decimal" dir="ltr" aria-invalid={amountBad || undefined} onChange={(e) => setAmount(e.target.value)} required />
      {amountBad && <span className="hr-error" role="alert">{tx('أدخل رقماً عشرياً بحد أقصى منزلتين، ويمكن أن يكون سالباً.', 'Enter a decimal number with at most 2 decimals; it may be negative.')}</span>}</label>
    <DocSelect label={tx('مستند داعم (اختياري)', 'Supporting document (optional)')} value={doc} onChange={setDoc} docs={docs} failed={failed} tx={tx} />
    <label>{tx('ملاحظة (اختياري)', 'Note (optional)')}<textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></label>
  </FormShell>;
}
