import { useRef, useState, type FormEvent } from 'react';

type Props = {
  bonusId: string;
  recognizedAmount: string;
  settled: string;
  outstanding: string;
  recognitionDate: string;
  arabic: boolean;
  onSaved: () => Promise<unknown> | void;
  onUnauthorized: () => void;
};
type Draft = { kind: 'increase' | 'decrease'; amount: string; accounting_date: string; reason: string };

const money = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const cents = (value: string) => {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
};
const format = (value: bigint) => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};

export function EmployeeBonusAdjustment({ bonusId, recognizedAmount, settled, outstanding, recognitionDate, arabic, onSaved, onUnauthorized }: Props) {
  const label = (ar: string, en: string) => arabic ? ar : en;
  const today = new Date().toISOString().slice(0, 10);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ type: 'error' | 'status'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const submitting = useRef(false);
  const adjustments = cents(outstanding) - cents(recognizedAmount) + cents(settled);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const next: Draft = {
      kind: values.kind === 'decrease' ? 'decrease' : 'increase',
      amount: (values.amount ?? '').trim(), accounting_date: values.accounting_date ?? '', reason: (values.reason ?? '').trim(),
    };
    setMessage(null);
    if (!money.test(next.amount) || cents(next.amount) <= 0n) {
      setMessage({ type: 'error', text: label('أدخل مبلغاً موجباً بحد أقصى منزلتين عشريتين.', 'Enter a positive amount with at most two decimal places.') });
      return;
    }
    if (!next.accounting_date || next.accounting_date < recognitionDate || next.accounting_date > today) {
      setMessage({ type: 'error', text: label('تاريخ التسوية يجب أن يكون بين تاريخ الاعتراف واليوم.', 'The accounting date must be between the recognition date and today.') });
      return;
    }
    if (!next.reason || next.reason.length > 1000) {
      setMessage({ type: 'error', text: label('اكتب السبب والمستند المؤيد (حتى 1000 حرف).', 'Enter the reason and supporting evidence (up to 1000 characters).') });
      return;
    }
    if (next.kind === 'decrease' && cents(next.amount) > cents(outstanding)) {
      setMessage({ type: 'error', text: label('لا يمكن تخفيض مبلغ أكبر من الرصيد المتبقي.', 'A decrease cannot exceed the outstanding balance.') });
      return;
    }
    setDraft(next);
  }

  function explain(status: number, code: string) {
    if (status === 403) return code === 'BONUS_ADJUSTMENT_SEPARATION_REQUIRED'
      ? label('لا يمكنك تعديل مكافأة شاركتَ في إنشائها أو اعتمادها أو الاعتراف بها. يلزم مستخدم مستقل.', 'You cannot adjust a bonus you created, approved or recognized. An independent user is required.')
      : label('لا تملك الصلاحية اللازمة لتعديل المكافأة.', 'You do not have permission to adjust this bonus.');
    if (status === 404) return label('لم يُعثر على اعتراف مرحَّل لهذه المكافأة بهذا التاريخ.', 'No posted recognition was found for this bonus on or before that date.');
    if (code === 'BONUS_PERIOD_INELIGIBLE') return label('التاريخ خارج سنة مالية صالحة أو في المستقبل.', 'The date is outside a valid fiscal year or is in the future.');
    if (code === 'BONUS_ADJUSTMENT_CONFLICT') return label('مفتاح الطلب استُخدم سابقاً ببيانات مختلفة. حدّث الأرصدة ثم أعد المحاولة.', 'This request key was already used with different data. Refresh balances and retry.');
    if (code === 'BONUS_ADJUSTMENT_BLOCKED') return label('رُفض التعديل: الفترة أو السنة مقفلة، أو التخفيض يتجاوز الرصيد المتبقي، أو الحسابات غير صالحة. لم يُسجَّل شيء.', 'Adjustment rejected: the period or year is closed, a decrease exceeds the outstanding balance, or the accounts are not valid. Nothing was recorded.');
    if (code === 'BONUS_ADJUSTMENT_INVALID') return label('بيانات غير صالحة. راجع النوع والمبلغ والتاريخ والسبب.', 'Invalid data. Check the type, amount, date and reason.');
    return label('تعذر تسجيل التعديل. حدّث الأرصدة وأعد المحاولة.', 'Could not record the adjustment. Refresh balances and retry.');
  }

  async function confirm() {
    if (!draft || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage(null);
    const signature = JSON.stringify(draft);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    try {
      const response = await fetch(`/api/employee-bonuses/${bonusId}/adjustments`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, idempotency_key: attempt.current.key }),
      });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) {
        let code = '';
        try { code = String((await response.json() as { code?: string }).code ?? ''); } catch { /* status only */ }
        setMessage({ type: 'error', text: explain(response.status, code) });
        if (code === 'BONUS_ADJUSTMENT_CONFLICT') attempt.current = null;
        setDraft(null);
        return;
      }
      attempt.current = null;
      setDraft(null);
      setMessage({ type: 'status', text: label('سُجّل التعديل وتم تحديث الأرصدة. الاعتراف الأصلي لم يُلغَ.', 'Adjustment recorded and balances refreshed. The original recognition is unchanged.') });
      await onSaved();
    } catch {
      setMessage({ type: 'error', text: label('تعذر الاتصال. أعد التأكيد بالقيم نفسها؛ سيُعاد استخدام مفتاح الطلب لمنع التكرار.', 'Connection failed. Confirm again with the same values; the same request key is reused to prevent a duplicate.') });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const kindLabel = (kind: Draft['kind']) => kind === 'increase' ? label('زيادة', 'Increase') : label('تخفيض', 'Decrease');
  return <details>
    <summary>{label('تعديل مكافأة معتمدة', 'Adjust approved bonus')}</summary>
    <dl className="ecc-detail-grid">
      <div><dt>{label('المبلغ المعترف به (ر.س)', 'Recognized amount (SAR)')}</dt><dd><bdi dir="ltr">{recognizedAmount}</bdi></dd></div>
      <div><dt>{label('صافي التعديلات (ر.س)', 'Net adjustments (SAR)')}</dt><dd><bdi dir="ltr">{format(adjustments)}</bdi></dd></div>
      <div><dt>{label('المسوّى (ر.س)', 'Settled (SAR)')}</dt><dd><bdi dir="ltr">{settled}</bdi></dd></div>
      <div><dt>{label('المتبقي (ر.س)', 'Outstanding (SAR)')}</dt><dd><bdi dir="ltr">{outstanding}</bdi></dd></div>
    </dl>
    <p className="ecc-muted">{label('التعديل قيد محاسبي مستقل يغيّر الرصيد المتبقي فقط. تخفيض المتبقي إلى صفر لا يلغي الاعتراف الأصلي ولا يعكس قيده.', 'An adjustment is a separate journal entry that changes the outstanding balance only. Reducing the outstanding to zero does not cancel or reverse the original recognition.')}</p>
    {!draft && <form onSubmit={review}>
      <fieldset disabled={busy}>
        <label>{label('نوع التعديل', 'Adjustment type')} <select name="kind" defaultValue="increase">
          <option value="increase">{label('زيادة', 'Increase')}</option>
          <option value="decrease">{label('تخفيض', 'Decrease')}</option>
        </select></label>
        <label>{label('المبلغ (ر.س)', 'Amount (SAR)')} <input name="amount" inputMode="decimal" required /></label>
        <label>{label('تاريخ القيد', 'Accounting date')} <input name="accounting_date" type="date" min={recognitionDate} max={today} required /></label>
        <label>{label('السبب والمستند المؤيد', 'Reason and supporting evidence')} <textarea name="reason" required maxLength={1000} /></label>
        <button>{label('مراجعة التعديل', 'Review adjustment')}</button>
      </fieldset>
    </form>}
    {draft && <div role="group" aria-label={label('تأكيد التعديل', 'Confirm adjustment')}>
      <p>{label('تأكيد: ', 'Confirm: ')}{kindLabel(draft.kind)} <bdi dir="ltr">{draft.amount}</bdi> SAR · <bdi dir="ltr">{draft.accounting_date}</bdi></p>
      <p>{draft.reason}</p>
      <p>{label('سيُرحَّل قيد محاسبي ولا يمكن حذفه. هل تريد المتابعة؟', 'A journal entry will be posted and cannot be deleted. Continue?')}</p>
      <button type="button" disabled={busy} onClick={() => void confirm()}>{label('تأكيد وترحيل', 'Confirm and post')}</button>
      <button type="button" disabled={busy} onClick={() => setDraft(null)}>{label('رجوع', 'Back')}</button>
    </div>}
    {message && <p role={message.type === 'error' ? 'alert' : 'status'}>{message.text}</p>}
  </details>;
}
