import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CUTOVER_MESSAGES, CutoverAccount, CutoverActivation } from './CutoverActivation';
import './SourceAuthority.css';

interface Range { id: string; from_date: string; to_date: string; status: 'draft' | 'active' | 'voided'; reason: string; void_reason: string | null; created_at: string;
  cutover_journal_id?: string | null; activated_at?: string | null; activated_by?: string | null; tb_reference?: string | null; tb_prepared_by?: string | null; acknowledgements?: Record<string, boolean> | null }
interface Year { id: string; name: string; start_date: string; end_date: string; status: string }

const MESSAGES: Record<string, { ar: string; en: string }> = {
  CONFIRMATION_REQUIRED: { ar: 'يلزم تأكيد صريح قبل الحفظ.', en: 'Explicit confirmation is required before saving.' },
  AUTHORITY_RANGE_INVALID: { ar: 'التواريخ أو السبب غير صالحة.', en: 'The dates or the reason are not valid.' },
  AUTHORITY_RANGE_OVERLAP: { ar: 'تتداخل هذه الفترة مع إعداد آخر قائم.', en: 'This period overlaps another existing configuration.' },
  AUTHORITY_DRAFT_FISCAL_YEAR_INVALID: { ar: 'يجب أن تبدأ الفترة في أول يوم من سنة مالية مفتوحة وتنتهي قبل آخر يوم فيها.', en: 'The period must start on the first day of an open fiscal year and end before its last day.' },
  AUTHORITY_ONBOARDING_PATH_CONFLICT: { ar: 'هذه السنة تتبع مسار الأرصدة الافتتاحية بالفعل، ولا يمكن اختيار القطع لها.', en: 'This fiscal year already follows the opening-balance path, so a cutover cannot be configured for it.' },
  LEDGER_SOURCE_AUTHORITY_IMMUTABLE: { ar: 'لا يمكن تغيير هذا الإعداد بهذه الطريقة.', en: 'This configuration cannot be changed this way.' },
};

export function SourceAuthority({ canManage, canActivate = false, onUnauthorized }: { canManage: boolean; canActivate?: boolean; onUnauthorized: () => void }) {
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
  const [loading, setLoading] = useState(true);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidConfirm, setVoidConfirm] = useState(false);
  const [activating, setActivating] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<CutoverAccount[]>([]);
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);

  const unauthorized = useRef(onUnauthorized); // keep `call`/`load` stable even if the parent passes a new handler each render
  unauthorized.current = onUnauthorized;
  const call = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { credentials: 'same-origin', ...init });
    if (response.status === 401) { unauthorized.current(); throw new Error('unauthorized'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error('request'), { code: (body as { code?: string }).code ?? 'UNKNOWN' });
    return body as Record<string, unknown>;
  }, []);
  const show = (reasonValue: unknown) => {
    const code = (reasonValue as { code?: string } | null)?.code ?? 'UNKNOWN';
    const known = MESSAGES[code] ?? CUTOVER_MESSAGES[code];
    setError(known ? tx(known.ar, known.en) : tx('تعذر تنفيذ الطلب.', 'The request could not be completed.'));
  };

  const load = useCallback(async () => {
    setLoadFailed(false);
    setLoading(true);
    try { setRanges(((await call('/api/ledger-source-authority')).ranges as Range[]) ?? []); } catch { setLoadFailed(true); }
    try { setYears((((await call('/api/fiscal-years')).fiscalYears as Year[]) ?? []).filter((y) => y.status !== 'closed')); } catch { setYears([]); }
    setLoading(false);
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
  const openActivation = async (id: string) => {
    setError(null); setAccountsFailed(false);
    try { setAccounts(((await call('/api/accounts')).accounts as CutoverAccount[]) ?? []); } catch { setAccounts([]); setAccountsFailed(true); }
    setActivating(id);
  };
  const statusLabel = (r: Range) => r.status === 'draft' ? tx('إعداد مسجّل، غير جاهز مالياً', 'Recorded, not financially ready') : r.status === 'active' ? tx('فعّال', 'Active') : tx('ملغى', 'Voided');

  const CheckIcon = () => <svg className="sa-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  const InfoIcon = () => <svg className="sa-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 7.2v3.6M8 5.2v.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;
  const pathCard = (key: 'opening' | 'cutover', title: string, text: string) => <div className={`sa-path${path === key ? ' is-selected' : ''}`}>
    <div className="sa-path__body"><h3>{title}{path === key && <span className="sa-path__mark"><CheckIcon /></span>}</h3><p>{text}</p></div>
    <button type="button" className="sa-ghost" aria-pressed={path === key} onClick={() => setPath(key)}>{tx('عرض', 'Select')}</button>
  </div>;

  return <section className="panel source-authority" aria-labelledby="sa-title" dir={ar ? 'rtl' : 'ltr'}>
    <header className="sa-header"><h2 id="sa-title">{tx('سلطة مصدر الدفاتر', 'Ledger Source Authority')}</h2>
      <p>{tx('اختر كيف تبدأ الدفاتر داخل إقفال لكل سنة مالية. المساران يستبعد أحدهما الآخر.', 'Choose how the books start inside EQFAL for each fiscal year. The two paths exclude each other.')}</p></header>
    <div className="sa-paths">
      {pathCard('opening', tx('1) أرصدة افتتاحية في أول السنة', '1) Opening balances at year start'), tx('تُدخل أرصدة أول السنة المالية ثم تُرحَّل بقية الحركات داخل إقفال. لا يلزم إعداد هنا؛ استخدم شاشة الأرصدة الافتتاحية.', 'Enter the balances at the start of the fiscal year, then post all transactions in EQFAL. No setup is needed here; use the Opening Balances screen.'))}
      {pathCard('cutover', tx('2) قطع في منتصف السنة', '2) Mid-year cutover'), tx('تبقى الفترة السابقة لتاريخ القطع مرجعاً خارجياً فقط، وتبدأ ترحيلات إقفال بعده بميزان مراجعة معتمد.', 'Activity up to the cutover date stays external reference only; EQFAL postings begin after it, from an approved trial balance.'))}
    </div>
    {error && <div className="sa-error" role="alert">{error}</div>}
    {loadFailed && <div className="sa-error" role="alert">{tx('تعذر تحميل الإعدادات.', 'The configurations could not be loaded.')}</div>}
    {activating && (() => { const r = ranges.find((x) => x.id === activating); return r ? <CutoverActivation range={r} accounts={accounts} accountsFailed={accountsFailed} call={call} tx={tx} ar={ar} onCancel={() => setActivating(null)} onDone={() => { setActivating(null); void load(); }} /> : null; })()}
    {path === 'cutover' && <section className="sa-card" aria-labelledby="sa-form-title">
      <div className="sa-card__head"><h3 id="sa-form-title">{tx('إعداد القطع في منتصف السنة', 'Mid-year cutover setup')}</h3></div>
      <div className="sa-warning" role="note"><InfoIcon /><div>{tx('تنبيه: حفظ هذا الإعداد تسجيل لنيّة القطع فقط. لا يغيّر أي ترحيل أو تقرير أو إقفال أو ضريبة، ولا يعني أن القطع جاهز مالياً. يتم التفعيل لاحقاً من زر «تفعيل» في السجل أدناه عبر مسار إرشادي، لمن يملك الصلاحية.', 'Note: saving this only records the intent to cut over. It changes no posting, report, close or VAT, and does not mean the cutover is financially ready. Activation is done later with the Activate button in the register below, through a guided workflow, by users who hold the permission.')}</div></div>
      {canManage ? <form onSubmit={submit} className="sa-form">
        <div className="sa-fields">
          <label>{tx('السنة المالية', 'Fiscal year')}
            <select value={yearId} onChange={(e) => setYearId(e.target.value)} required>
              <option value="">{tx('اختر', 'Choose')}</option>
              {years.map((y) => <option key={y.id} value={y.id}>{y.name} ({y.start_date} → {y.end_date})</option>)}
            </select></label>
          <label>{tx('آخر يوم تُحفظ دفاتره خارج إقفال (تاريخ القطع)', 'Last day whose books stay outside EQFAL (cutover date)')}
            <input type="date" value={cutover} min={year?.start_date} max={year?.end_date} onChange={(e) => setCutover(e.target.value)} required /></label>
        </div>
        <label>{tx('السبب (إلزامي)', 'Reason (required)')}
          <textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} required /></label>
        <label className="sa-check"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>{tx('أؤكد أنني أفهم أن هذا إعداد مسجّل فقط وغير جاهز مالياً.', 'I confirm I understand this is a recorded configuration only and is not financially ready.')}</span></label>
        <div className="sa-actions"><button type="submit" className="sa-primary" disabled={busy || !confirm || !year || !cutover || !reason.trim()}>{busy ? tx('جارٍ الحفظ…', 'Saving…') : tx('حفظ الإعداد', 'Save configuration')}</button></div>
      </form> : <p className="sa-muted">{tx('لا تملك صلاحية إدارة سلطة المصدر.', 'You do not have permission to manage source authority.')}</p>}
    </section>}
    <section className="sa-card" aria-labelledby="sa-register-title">
      <div className="sa-card__head"><h3 id="sa-register-title">{tx('الإعدادات المسجّلة', 'Recorded configurations')}</h3>{!loading && ranges.length > 0 && <span className="sa-muted">{ranges.length}</span>}</div>
      {loading ? <p role="status" className="sa-state">{tx('جارٍ التحميل…', 'Loading…')}</p> : ranges.length === 0 ? <p className="sa-state">{tx('لا توجد إعدادات.', 'No configurations.')}</p> :
        <div className="sa-table"><table><thead><tr><th>{tx('من', 'From')}</th><th>{tx('إلى', 'To')}</th><th>{tx('الحالة', 'Status')}</th><th>{tx('السبب', 'Reason')}</th><th /></tr></thead>
          <tbody>{ranges.map((r) => <tr key={r.id}><td className="sa-date">{r.from_date}</td><td className="sa-date">{r.to_date}</td>
            <td><span className={`sa-badge is-${r.status}`}>{statusLabel(r)}</span></td><td className="sa-reason">{r.status === 'voided' ? r.void_reason : r.reason}</td>
            <td>{canActivate && r.status === 'draft' && <button type="button" className="sa-primary" onClick={() => void openActivation(r.id)}>{tx('تفعيل', 'Activate')}</button>} {canManage && r.status === 'draft' && <button type="button" className="sa-ghost" onClick={() => { setVoiding(r.id); setError(null); }}>{tx('إلغاء', 'Void')}</button>}{r.status === 'active' && <button type="button" className="sa-ghost" aria-expanded={detail === r.id} onClick={() => setDetail(detail === r.id ? null : r.id)}>{tx('تفاصيل', 'Details')}</button>}</td></tr>)}</tbody></table></div>}
      {detail && (() => { const r = ranges.find((x) => x.id === detail); if (!r) return null; const a = r.acknowledgements ?? {};
        return <dl className="ca-totals ca-audit" aria-label={tx('تفاصيل التفعيل (للقراءة فقط)', 'Activation details (read-only)')}>
          <div><dt>{tx('تاريخ السريان', 'Effective date')}</dt><dd className="sa-date">{r.to_date}</dd></div>
          <div><dt>{tx('قيد القطع', 'Cutover journal')}</dt><dd className="sa-date">{r.cutover_journal_id ?? '—'}</dd></div>
          <div><dt>{tx('وقت التفعيل', 'Activated at')}</dt><dd className="sa-date">{r.activated_at ?? '—'}</dd></div>
          <div><dt>{tx('مرجع الميزان', 'Trial balance reference')}</dt><dd>{r.tb_reference ?? '—'}</dd></div>
          <div><dt>{tx('أعدّه', 'Prepared by')}</dt><dd>{r.tb_prepared_by ?? '—'}</dd></div>
          <div><dt>{tx('الإقرارات', 'Acknowledgements')}</dt><dd>{Object.keys(a).length ? Object.keys(a).filter((k) => a[k]).length + '/4' : '—'}</dd></div>
        </dl>; })()}
      {voiding && <form onSubmit={submitVoid} className="sa-form sa-void">
        <label>{tx('سبب الإلغاء (إلزامي)', 'Void reason (required)')}<textarea value={voidReason} maxLength={500} onChange={(e) => setVoidReason(e.target.value)} required /></label>
        <label className="sa-check"><input type="checkbox" checked={voidConfirm} onChange={(e) => setVoidConfirm(e.target.checked)} /><span>{tx('أؤكد إلغاء هذا الإعداد. يبقى في السجل ولا يُحذف.', 'I confirm voiding this configuration. It stays in the history and is not deleted.')}</span></label>
        <div className="sa-actions"><button type="button" className="sa-ghost" onClick={() => setVoiding(null)}>{tx('رجوع', 'Back')}</button>
          <button type="submit" className="sa-dark" disabled={busy || !voidConfirm || !voidReason.trim()}>{busy ? tx('جارٍ الإلغاء…', 'Voiding…') : tx('تأكيد الإلغاء', 'Confirm void')}</button></div>
      </form>}
    </section>
  </section>;
}
