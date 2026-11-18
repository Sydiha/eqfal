import { useEffect, useState, type FormEvent } from 'react';
import { formatMinorUnits } from '../money-format';

const gates = ['B0', 'B3', 'B4', 'B7', 'B9'] as const;
type Gate = typeof gates[number];
type Decision = {
  id: string;
  gate: Gate;
  status: 'pending' | 'verified' | 'stale' | 'ended';
  evidence_document_id: string;
  authority_reference: string;
  facts: Record<string, unknown>;
  can_approve?: boolean;
  can_end?: boolean;
  reviewed_by: string | null;
  approved_at: string | null;
  end_reason: string | null;
};
export type RegulatoryState = {
  regulatory_decisions?: Decision[];
  regulatory_reviewers?: { id: string; name: string }[];
  finalization?: { status: 'BLOCKED' | 'READY' | 'EXEMPT'; blockers: string[]; payable_amount_halalas: string | null };
};
type Props = {
  data: RegulatoryState;
  ar: boolean;
  busy: boolean;
  reviewed: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canViewDocuments: boolean;
  canManageReviewers?: boolean;
  version: number | undefined;
  documents: { id: string; original_filename: string; status?: string }[];
  write: (path: string, method: string, body?: object) => Promise<boolean>;
  blockerLabel: (code: string) => string;
};
const requirements: Record<Gate, readonly [string, string]> = {
  B0: ['قرار تطبيق التعديل 1248 على الفترة ونشاط الشركة، مع تقييم المشروعات وتوزيع الأصول.', 'Decision 1248 period applicability, project assessment, and supporting asset allocations.'],
  B3: ['مرجع طريقة التقريب وإثبات نوع الفترة. لفترة التوقف، أرفق مستند التوقف الفعلي وتاريخه.', 'Authority for rounding and verified period type. For cessation, attach official cessation evidence and date.'],
  B4: ['مرجع ترتيب حدود الالتزامات ومعالجة الفائض، مع تسويات التصنيف والخسائر المدعومة.', 'Authority for liability cap ordering and surplus treatment, with evidenced reclassifications and loss reconciliations.'],
  B7: ['القوائم النهائية وتسوية الربح المعدل مع القيود الفعلية للزكاة والضريبة، أو مرجع معتمد لحالة عدم وجودها.', 'Final accounts and adjusted profit reconciliation to recorded Zakat and tax charges, or an authoritative decision addressing their absence.'],
  B9: ['اعتماد المحاسب المخوّل لكامل الحالات المرجعية الرقمية للإصدار الحالي.', 'Authorized accountant sign-off on the complete numerical reference suite for this version.'],
};
const examples: Record<Exclude<Gate, 'B3'>, string> = {
  B0: '{"projects":[],"deductibleAssets":[],"undeductedAssets":[{"accountId":"…","amountSar":"0.00"}]}',
  B4: '{"liabilityReclassifications":[],"lossReconciliations":[]}',
  B7: '{"charges":[],"adjustments":[]}',
  B9: '{}',
};

export function ZakatRegulatoryReview(p: Props) {
  const [formGate, setFormGate] = useState<Gate | null>(null);
  const [ending, setEnding] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const { finalization, regulatory_decisions: decisions = [], regulatory_reviewers: reviewers = [] } = p.data;
  if (!finalization) return null;
  const label = (ar: string, en: string) => p.ar ? ar : en;
  const reviewer = (id: string) => reviewers.find((row) => row.id === id)?.name ?? id;
  const submit = async (event: FormEvent<HTMLFormElement>, gate: Gate) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let facts: unknown;
    try {
      if (gate === 'B3') {
        const activityDate = form.get('activity_date');
        facts = { activityPeriod: form.get('activity_period'), rounding: form.get('rounding'), ...(activityDate ? { activityDate } : {}) };
      } else {
        facts = gate === 'B9' ? {} : JSON.parse(String(form.get('facts')));
      }
    } catch {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (await p.write('/regulatory-decisions', 'POST', {
      gate, version: p.version, evidence_document_id: form.get('document'), authority_reference: form.get('reference'), facts,
    })) setFormGate(null);
  };

  return <section className="zw-card" id="zakat-regulatory-review" dir={p.ar ? 'rtl' : 'ltr'} aria-labelledby="zakat-regulatory-title">
    <h4 id="zakat-regulatory-title">{label('المراجعة النظامية واعتماد الزكاة', 'Regulatory review and Zakat approval')}</h4>
    {p.canManageReviewers && <ReviewerAdministration ar={p.ar} />}
    <div role="status">
      {finalization.status === 'READY' && finalization.payable_amount_halalas !== null
        ? <p>{label('الزكاة المستحقة', 'Zakat payable')} <strong><bdi>{formatMinorUnits(finalization.payable_amount_halalas)}</bdi> {label('ر.س', 'SAR')}</strong></p>
        : <p>{finalization.status === 'EXEMPT' ? label('إعفاء فترة التوقف المثبتة بموجب المادة 15', 'Verified Article 15 cessation exemption')
          : label('المبلغ المستحق محجوب حتى اكتمال الاعتماد.', 'Payable amount withheld pending approval.')}</p>}
    </div>
    {finalization.blockers.length > 0 && <ul>{finalization.blockers.filter((code) => !gates.some((gate) => code.startsWith(`${gate}_`) && !code.startsWith('B4_AGGREGATE'))).map((code) => <li key={code}>{p.blockerLabel(code)}</li>)}</ul>}
    <p>{label('المراجعون المعيّنون', 'Appointed reviewers')} · {reviewers.length
      ? reviewers.map(({ name }) => name).join(label('، ', ', '))
      : label('يلزم تعيين مراجع مخوّل من مسؤول النظام.', 'A trusted operator must appoint a qualified reviewer.')}</p>
    {gates.map((gate) => {
      const history = decisions.filter((row) => row.gate === gate);
      const active = history.find((row) => row.status !== 'ended');
      const status = active?.status === 'verified' ? label('معتمد', 'Approved')
        : active?.status === 'pending' ? label('بانتظار مراجعة مستقلة', 'Awaiting independent review')
          : active?.status === 'stale' ? label('الأدلة أو بيانات المصدر تغيّرت. ألغِ القرار وقدّم الأدلة مجددًا.', 'Evidence or source changed. End this decision and resubmit evidence.')
            : label('أرفق الأدلة المطلوبة بعد إقفال الفترة ومراجعة الورقة.', 'Submit the required evidence after closing the period and reviewing the worksheet.');
      return <div key={gate} className="zw-card">
        <h5><bdi>{gate}</bdi> · {status}</h5>
        <p>{requirements[gate][p.ar ? 0 : 1]}</p>
        {active?.approved_at && active.reviewed_by && <p>{label('اعتمد بواسطة', 'Approved by')} {reviewer(active.reviewed_by)} · <bdi>{active.approved_at}</bdi></p>}
        {active && p.canViewDocuments && <details>
          <summary>{label('الأدلة والبيانات المقدّمة', 'Submitted evidence and facts')}</summary>
          <p>{active.authority_reference} · <a href={`/api/documents/${active.evidence_document_id}/file`} target="_blank" rel="noreferrer">{label('فتح مستند الإثبات', 'Open evidence document')}</a></p>
          <pre dir="ltr" className="zw-decision-facts">{JSON.stringify(active.facts, null, 2)}</pre>
        </details>}
        {active?.can_approve && p.canApprove && p.canViewDocuments && <button className="ac-btn" type="button" disabled={p.busy} onClick={() => void p.write(`/regulatory-decisions/${active.id}/approve`, 'POST', {})}>{label('اعتماد الأدلة بعد التحقق', 'Approve after verifying evidence')}</button>}
        {active?.can_end && <button className="ac-btn" type="button" disabled={p.busy} onClick={() => setEnding(active.id)}>{label('إنهاء القرار', 'End decision')}</button>}
        {active && ending === active.id && <form onSubmit={async (event) => {
          event.preventDefault();
          const reason = new FormData(event.currentTarget).get('reason');
          if (await p.write(`/regulatory-decisions/${active.id}/end`, 'POST', { reason })) setEnding(null);
        }}>
          <label>{label('سبب الإنهاء', 'Reason for ending')} <input name="reason" required maxLength={2000} /></label>
          <button className="ac-btn" disabled={p.busy}>{label('تأكيد الإنهاء', 'Confirm ending')}</button>
          <button className="ac-btn" type="button" onClick={() => setEnding(null)}>{label('إلغاء', 'Cancel')}</button>
        </form>}
        {history.some((row) => row.status === 'ended') && <details>
          <summary>{label('سجل القرارات المنتهية', 'Ended decision history')}</summary>
          <ul>{history.filter((row) => row.status === 'ended').map((row) => <li key={row.id}>{row.end_reason}{row.approved_at && row.reviewed_by && <> · {reviewer(row.reviewed_by)} · <bdi>{row.approved_at}</bdi></>}</li>)}</ul>
        </details>}
        {!active && p.reviewed && p.canSubmit && p.canViewDocuments && (formGate !== gate
          ? <button className="ac-btn" type="button" disabled={p.busy} onClick={() => { setFormGate(gate); setInvalid(false); }}>{label('تقديم الأدلة للمراجعة', 'Submit evidence for review')}</button>
          : <form onSubmit={(event) => void submit(event, gate)}>
            <label>{label('مستند إثبات معتمد', 'Approved evidence document')} <select name="document" required defaultValue="">
              <option value="">{label('اختر المستند', 'Select document')}</option>
              {p.documents.filter((d) => d.status === 'approved').map((d) => <option value={d.id} key={d.id}>{d.original_filename}</option>)}
            </select></label>
            <label>{label('مرجع الجهة وموضع الإثبات في المستند', 'Authority and evidence location')} <input name="reference" required maxLength={2000} /></label>
            {gate === 'B3' ? <>
              <label>{label('نوع الفترة', 'Period type')} <select name="activity_period" required>
                <option value="regular">{label('عادية', 'Regular')}</option>
                <option value="commencement">{label('بداية النشاط', 'Commencement')}</option>
                <option value="cessation">{label('توقف النشاط', 'Cessation')}</option>
              </select></label>
              <label>{label('تاريخ بداية النشاط أو توقفه عند الاقتضاء', 'Activity start or cessation date when applicable')} <input type="date" name="activity_date" /></label>
              <label>{label('التقريب وفق الإثبات', 'Rounding supported by evidence')} <select name="rounding" required defaultValue="">
                <option value="">{label('اختر الطريقة', 'Select method')}</option>
                <option>HALF_UP</option><option>HALF_EVEN</option><option>DOWN</option>
              </select></label>
            </> : gate !== 'B9' && <label>{label('بيانات التسوية المرتبطة بالأدلة (JSON)', 'Evidence-backed reconciliation facts (JSON)')}
              <textarea name="facts" required dir="ltr" rows={4} placeholder={examples[gate]} />
            </label>}
            {invalid && <p role="alert">{label('صيغة JSON غير صالحة.', 'Invalid JSON.')}</p>}
            <button className="ac-btn" disabled={p.busy}>{label('إرسال للمراجعة', 'Send for review')}</button>
            <button className="ac-btn" type="button" onClick={() => setFormGate(null)}>{label('إلغاء', 'Cancel')}</button>
          </form>)}
      </div>;
    })}
  </section>;
}

type AdminAppointment = { appointment_id: string; user_id: string; reviewer_name: string; reviewer_email: string; appointment_reference: string; appointed_by_user_id: string | null; identity_verified_at: string | null; revoked_by_user_id: string | null; revoked_at: string | null; revocation_reason: string | null };
type ReviewerCandidate = { user_id: string; name: string; email: string };

export function ReviewerAdministration({ ar }: { ar: boolean }) {
  const [appointments, setAppointments] = useState<AdminAppointment[]>([]);
  const [candidates, setCandidates] = useState<ReviewerCandidate[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = (arabic: string, english: string) => ar ? arabic : english;
  const load = async () => {
    const response = await fetch('/api/zakat-reviewers');
    if (response.status === 401) return;
    if (!response.ok) throw new Error();
    const data = await response.json() as { appointments: AdminAppointment[]; candidates: ReviewerCandidate[] };
    setAppointments(data.appointments); setCandidates(data.candidates);
  };
  useEffect(() => { void load().catch(() => setError(true)); }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(false);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const response = await fetch('/api/zakat-reviewers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: form.get('user_id'), appointment_reference: form.get('appointment_reference'), identity_verified: form.get('identity_verified') === 'on' }) });
      if (!response.ok) throw new Error();
      formElement.reset(); await load();
    } catch { setError(true); } finally { setBusy(false); }
  };
  const revoke = async (event: FormEvent<HTMLFormElement>, appointmentId: string) => {
    event.preventDefault(); setBusy(true); setError(false);
    const reason = new FormData(event.currentTarget).get('reason');
    try {
      const response = await fetch(`/api/zakat-reviewers/${appointmentId}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
      if (!response.ok) throw new Error();
      await load();
    } catch { setError(true); } finally { setBusy(false); }
  };
  return <section className="zw-card" aria-labelledby="zakat-reviewer-admin-title">
    <h5 id="zakat-reviewer-admin-title">{label('إدارة المراجعين المخوّلين', 'Manage authorized reviewers')}</h5>
    <p>{label('لا يُفعّل التعيين إلا بعد تحقق المسؤول من هوية المراجع ومرجع تعيينه. لكل تعيين هوية مستقلة؛ إعادة التعيين لا تعيد صلاحية اعتماد سابق.', 'Appointments require administrator verification of reviewer identity and reference. Each appointment has a unique identity; reappointment never restores earlier approvals.')}</p>
    <ul>{appointments.map((item) => <li key={item.appointment_id}>
      <bdi>{item.reviewer_name} · {item.reviewer_email}</bdi> · <bdi>{item.appointment_reference}</bdi> · <bdi>{item.appointment_id}</bdi>
      {item.identity_verified_at && <span> · {label('تحقق من الهوية بواسطة', 'Identity verified by')} <bdi>{item.appointed_by_user_id ?? '—'}</bdi> · <bdi>{item.identity_verified_at}</bdi></span>}
      {item.revoked_at ? <span> · {label('ملغى بواسطة', 'Revoked by')} <bdi>{item.revoked_by_user_id ?? label('النظام أثناء الترحيل', 'system migration')}</bdi> · <bdi>{item.revoked_at}</bdi>{item.revocation_reason ? ` · ${item.revocation_reason}` : ''}</span> : <span> · {label('فعّال', 'Active')}</span>}
      {!item.revoked_at && <form onSubmit={(event) => void revoke(event, item.appointment_id)}>
        <label>{label('سبب الإلغاء', 'Revocation reason')} <input name="reason" required maxLength={2000} /></label>
        <button className="ac-btn" disabled={busy}>{label('إلغاء التعيين', 'Revoke appointment')}</button>
      </form>}
    </li>)}</ul>
    {candidates.length > 0 && <form onSubmit={(event) => void submit(event)}>
      <label>{label('عضو الشركة', 'Company member')} <select name="user_id" required defaultValue=""><option value="">{label('اختر مستخدماً', 'Select a user')}</option>{candidates.map((candidate) => <option key={candidate.user_id} value={candidate.user_id}>{candidate.name} · {candidate.email}</option>)}</select></label>
      <label>{label('مرجع التعيين المهني', 'Professional appointment reference')} <input name="appointment_reference" required maxLength={500} /></label>
      <label><input type="checkbox" name="identity_verified" required /> {label('أؤكد أنني تحققت من هوية المراجع ومؤهلاته خارج النظام.', 'I verified the reviewer’s identity and qualifications outside the system.')}</label>
      <button className="ac-btn" disabled={busy}>{label('تعيين المراجع', 'Appoint reviewer')}</button>
    </form>}
    {candidates.length === 0 && <p>{label('لا يوجد أعضاء نشطون مؤهلون للتعيين حالياً.', 'No eligible active company members are available.')}</p>}
    {error && <p role="alert">{label('تعذر تحديث قائمة المراجعين. تحقق من الصلاحية وحاول مجدداً.', 'Could not update the reviewer registry. Check authorization and retry.')}</p>}
  </section>;
}
