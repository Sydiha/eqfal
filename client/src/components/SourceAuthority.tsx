import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './SourceAuthority.css';

interface Range { id: string; from_date: string; to_date: string; status: 'draft' | 'active' | 'voided'; reason: string; void_reason: string | null; created_at: string }
interface Year { id: string; name: string; start_date: string; end_date: string; status: string }

const MESSAGES: Record<string, { ar: string; en: string }> = {
  CONFIRMATION_REQUIRED: { ar: 'يلزم تأكيد صريح قبل الحفظ.', en: 'Explicit confirmation is required before saving.' },
  AUTHORITY_RANGE_INVALID: { ar: 'التواريخ أو السبب غير صالحة.', en: 'The dates or the reason are not valid.' },
  AUTHORITY_RANGE_OVERLAP: { ar: 'تتداخل هذه الفترة مع إعداد آخر قائم.', en: 'This period overlaps another existing configuration.' },
  AUTHORITY_DRAFT_FISCAL_YEAR_INVALID: { ar: 'يجب أن تبدأ الفترة في أول يوم من سنة مالية مفتوحة وتنتهي قبل آخر يوم فيها.', en: 'The period must start on the first day of an open fiscal year and end before its last day.' },
  AUTHORITY_ONBOARDING_PATH_CONFLICT: { ar: 'هذه السنة تتبع مسار الأرصدة الافتتاحية بالفعل، ولا يمكن اختيار القطع لها.', en: 'This fiscal year already follows the opening-balance path, so a cutover cannot be configured for it.' },
  LEDGER_SOURCE_AUTHORITY_IMMUTABLE: { ar: 'لا يمكن تغيير هذا الإعداد بهذه الطريقة.', en: 'This configuration cannot be changed this way.' },
};

export function SourceAuthority({ canManage, onUnauthorized }: { canManage: boolean; onUnauthorized: () => void }) {
  const { i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const tx = (a: string, e: string) => (ar ? a : e);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [years, setYears] = useState<Year[]>([]);
  const [path, setPath] = useState<'opening' | 'cutover'>('opening');
  const [yearId, setYearId] = useState('');
  const [cutover, setCutover] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidConfirm, setVoidConfirm] = useState(false);

  const call = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { credentials: 'same-origin', ...init });
    if (response.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error('request'), { code: (body as { code?: string }).code ?? 'UNKNOWN' });
    return body as Record<string, unknown>;
  }, [onUnauthorized]);
  const show = (reasonValue: unknown) => {
    const code = (reasonValue as { code?: string } | null)?.code ?? 'UNKNOWN';
    const known = MESSAGES[code];
    setError(known ? tx(known.ar, known.en) : tx('تعذر تنفيذ الطلب.', 'The request could not be completed.'));
  };

  const load = useCallback(async () => {
    setLoadFailed(false);
    try { setRanges(((await call('/api/ledger-source-authority')).ranges as Range[]) ?? []); } catch { setLoadFailed(true); }
    try { setYears((((await call('/api/fiscal-years')).fiscalYears as Year[]) ?? []).filter((y) => y.status !== 'closed')); } catch { setYears([]); }
  }, [call]);
  useEffect(() => { void load(); }, [load]);

  const year = years.find((y) => y.id === yearId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!year) return;
    setBusy(true); setError(null);
    try {
      await call('/api/ledger-source-authority/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from_date: year.start_date, to_date: cutover, reason, confirm: true }) });
      setCutover(''); setReason(''); setConfirm(false); await load();
    } catch (failure) { show(failure); } finally { setBusy(false); }
  };
  const submitVoid = async (event: FormEvent) => {
    event.preventDefault();
    if (!voiding) return;
    setBusy(true); setError(null);
    try {
      await call(`/api/ledger-source-authority/${voiding}/void-draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: voidReason, confirm: true }) });
      setVoiding(null); setVoidReason(''); setVoidConfirm(false); await load();
    } catch (failure) { show(failure); } finally { setBusy(false); }
  };
  const statusLabel = (r: Range) => r.status === 'draft' ? tx('إعداد مسجّل، غير جاهز مالياً', 'Recorded, not financially ready') : r.status === 'active' ? tx('فعّال', 'Active') : tx('ملغى', 'Voided');

  return <section className="panel source-authority" aria-labelledby="sa-title" dir={ar ? 'rtl' : 'ltr'}>
    <header><h2 id="sa-title">{tx('سلطة مصدر الدفاتر', 'Ledger Source Authority')}</h2>
      <p>{tx('اختر كيف تبدأ الدفاتر داخل إقفال لكل سنة مالية. المساران يستبعد أحدهما الآخر.', 'Choose how the books start inside EQFAL for each fiscal year. The two paths exclude each other.')}</p></header>
    <div className="sa-paths">
      <div className={`sa-path${path === 'opening' ? ' is-selected' : ''}`}>
        <h3>{tx('1) أرصدة افتتاحية في أول السنة', '1) Opening balances at year start')}</h3>
        <p>{tx('تُدخل أرصدة أول السنة المالية ثم تُرحَّل بقية الحركات داخل إقفال. لا يلزم إعداد هنا؛ استخدم شاشة الأرصدة الافتتاحية.', 'Enter the balances at the start of the fiscal year, then post all transactions in EQFAL. No setup is needed here; use the Opening Balances screen.')}</p>
        <button type="button" className="secondary" onClick={() => setPath('opening')}>{tx('عرض', 'Select')}</button>
      </div>
      <div className={`sa-path${path === 'cutover' ? ' is-selected' : ''}`}>
        <h3>{tx('2) قطع في منتصف السنة', '2) Mid-year cutover')}</h3>
        <p>{tx('تبقى الفترة السابقة لتاريخ القطع مرجعاً خارجياً فقط، وتبدأ ترحيلات إقفال بعده بميزان مراجعة معتمد.', 'Activity up to the cutover date stays external reference only; EQFAL postings begin after it, from an approved trial balance.')}</p>
        <button type="button" className="secondary" onClick={() => setPath('cutover')}>{tx('عرض', 'Select')}</button>
      </div>
    </div>
    {error && <div className="sa-error" role="alert">{error}</div>}
    {loadFailed && <div className="sa-error" role="alert">{tx('تعذر تحميل الإعدادات.', 'The configurations could not be loaded.')}</div>}
    {path === 'cutover' && <div className="sa-card">
      <div className="sa-warning" role="note">{tx('تنبيه: حفظ هذا الإعداد تسجيل لنيّة القطع فقط. لا يغيّر أي ترحيل أو تقرير أو إقفال أو ضريبة، ولا يعني أن القطع جاهز مالياً. لا يمكن التفعيل قبل وجود قيد قطع معتمد ومرحّل بأرصدة متوازنة (مرحلة لاحقة).', 'Note: saving this only records the intent to cut over. It changes no posting, report, close or VAT, and does not mean the cutover is financially ready. Activation requires an approved, balanced and posted cutover journal (a later phase).')}</div>
      {canManage ? <form onSubmit={submit}>
        <label>{tx('السنة المالية', 'Fiscal year')}
          <select value={yearId} onChange={(e) => setYearId(e.target.value)} required>
            <option value="">{tx('اختر', 'Choose')}</option>
            {years.map((y) => <option key={y.id} value={y.id}>{y.name} ({y.start_date} → {y.end_date})</option>)}
          </select></label>
        <label>{tx('آخر يوم تُحفظ دفاتره خارج إقفال (تاريخ القطع)', 'Last day whose books stay outside EQFAL (cutover date)')}
          <input type="date" value={cutover} min={year?.start_date} max={year?.end_date} onChange={(e) => setCutover(e.target.value)} required /></label>
        <label>{tx('السبب (إلزامي)', 'Reason (required)')}
          <textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} required /></label>
        <label className="sa-check"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>{tx('أؤكد أنني أفهم أن هذا إعداد مسجّل فقط وغير جاهز مالياً.', 'I confirm I understand this is a recorded configuration only and is not financially ready.')}</span></label>
        <button type="submit" disabled={busy || !confirm || !year || !cutover || !reason.trim()}>{tx('حفظ الإعداد', 'Save configuration')}</button>
      </form> : <p>{tx('لا تملك صلاحية إدارة سلطة المصدر.', 'You do not have permission to manage source authority.')}</p>}
    </div>}
    <div className="sa-card">
      <h3>{tx('الإعدادات المسجّلة', 'Recorded configurations')}</h3>
      {ranges.length === 0 ? <p>{tx('لا توجد إعدادات.', 'No configurations.')}</p> :
        <table className="sa-table"><thead><tr><th>{tx('من', 'From')}</th><th>{tx('إلى', 'To')}</th><th>{tx('الحالة', 'Status')}</th><th>{tx('السبب', 'Reason')}</th><th /></tr></thead>
          <tbody>{ranges.map((r) => <tr key={r.id}><td>{r.from_date}</td><td>{r.to_date}</td>
            <td><span className={`sa-badge is-${r.status}`}>{statusLabel(r)}</span></td><td>{r.status === 'voided' ? r.void_reason : r.reason}</td>
            <td>{canManage && r.status === 'draft' && <button type="button" className="secondary" onClick={() => { setVoiding(r.id); setError(null); }}>{tx('إلغاء', 'Void')}</button>}</td></tr>)}</tbody></table>}
      {voiding && <form onSubmit={submitVoid}>
        <label>{tx('سبب الإلغاء (إلزامي)', 'Void reason (required)')}<textarea value={voidReason} maxLength={500} onChange={(e) => setVoidReason(e.target.value)} required /></label>
        <label className="sa-check"><input type="checkbox" checked={voidConfirm} onChange={(e) => setVoidConfirm(e.target.checked)} /><span>{tx('أؤكد إلغاء هذا الإعداد. يبقى في السجل ولا يُحذف.', 'I confirm voiding this configuration. It stays in the history and is not deleted.')}</span></label>
        <div><button type="submit" disabled={busy || !voidConfirm || !voidReason.trim()}>{tx('تأكيد الإلغاء', 'Confirm void')}</button>{' '}
          <button type="button" className="secondary" onClick={() => setVoiding(null)}>{tx('رجوع', 'Back')}</button></div>
      </form>}
    </div>
  </section>;
}
