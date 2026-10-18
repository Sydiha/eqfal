import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusBadge, WorkspaceState } from './SharedUI';
import './PersonalPayments.css';

// Personal expense payments made on behalf of the company: draft -> submit -> approve/reject -> reimbursement.
// Presentation only: payer mapping, balanced journals, closed periods, duplicate prevention and permissions are all enforced by the server.

type Status = 'draft' | 'submitted' | 'approved' | 'rejected';
type Treatment = 'new_expense' | 'existing_obligation';
type Payment = {
  id: string; payer_id: string; payer_name?: string; payer_kind?: 'partner' | 'employee'; treatment: Treatment; payment_date: string; accounting_date: string; amount: string;
  purpose: string; document_id: string | null; obligation_id: string | null; expense_account_id: string | null; counterparty_id: string | null; status: Status;
  rejection_reason: string | null; version: number; reimbursed_amount?: string; outstanding_amount?: string; settlement_status?: 'none' | 'partial' | 'full';
};
type Payer = { id: string; display_name: string; partner_id: string | null; partner_name: string | null; payable_account_code: string | null; is_active: boolean; version: number; mapping_valid: boolean; user_email: string | null };
type Lookups = {
  payers: Array<{ id: string; display_name: string; is_partner: boolean }>;
  documents?: Array<{ id: string; original_filename: string; total_amount: string; document_date: string }>;
  obligations?: Array<{ id: string; counterparty_name: string; recognized_on: string; outstanding: string }>;
  expense_accounts?: Array<{ id: string; code: string; name: string }>;
};
type PayerExtras = { accounts?: Array<{ id: string; code: string; name: string }>; partners?: Array<{ id: string; name: string }>; members?: Array<{ id: string; email: string }> };
type BankTx = { id: string; bank_account_name: string; transaction_date: string; amount: string; description: string | null };
type Payables = { as_of: string; payers: Array<{ payer_id: string; payer_name: string; payer_kind: string; approved_amount: string; reimbursed_amount: string; outstanding_amount: string }> };

export type PersonalPaymentsProps = { capabilities: string[]; onUnauthorized: () => void };

const TEXT = {
  en: {
    title: 'Personal payments', intro: 'Expenses paid personally by a manager, employee or partner on behalf of the company.',
    tabs: { payments: 'Payments', payables: 'Amounts owed', payers: 'Payers' }, newPayment: 'New personal payment', edit: 'Edit', save: 'Save draft', cancel: 'Cancel',
    payer: 'Payer', treatment: 'Treatment', newExpense: 'New expense (document)', existingObligation: 'Existing payable (reclassify)', date: 'Payment date', amount: 'Amount (SAR)', purpose: 'Purpose',
    document: 'Expense document', obligation: 'Payable obligation', expenseAccount: 'Expense account', select: 'Select…', status: 'Status', outstanding: 'Outstanding', reimbursed: 'Reimbursed', actions: 'Actions',
    submit: 'Submit', approve: 'Approve', reject: 'Reject', reopen: 'Reopen as draft', remove: 'Delete', reimburse: 'Reimburse', reason: 'Rejection reason', confirmReject: 'Confirm rejection',
    bankTx: 'Company bank outflow', record: 'Record reimbursement', noBank: 'No eligible bank outflow.', empty: 'No personal payments yet.', loading: 'Loading…', error: 'Unable to load personal payments.',
    forbidden: 'You do not have permission to view personal payments.', employee: 'Employee / manager', partner: 'Partner (current account)', owed: 'Owed to payer', approvedTotal: 'Approved',
    asOf: 'As of', payersEmpty: 'No payers registered.', displayName: 'Display name', payableAccount: 'Payable account (liability)', partnerLink: 'Partner (uses current account)', member: 'Company member (optional)',
    addPayer: 'Add payer', mappingMissing: 'Mapping missing', active: 'Active', inactive: 'Inactive', deactivate: 'Deactivate', activate: 'Activate', none: 'None',
    statuses: { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected' } as Record<Status, string>,
    settle: { none: 'Not reimbursed', partial: 'Partly reimbursed', full: 'Fully reimbursed' } as Record<string, string>,
    errors: {
      PERSONAL_PAYMENT_MAPPING_MISSING: 'The payer has no valid account mapping. Fix the mapping before approving.',
      PERSONAL_PAYMENT_PERIOD_CLOSED: 'The accounting period is closed.', PERSONAL_PAYMENT_FISCAL_YEAR_CLOSED: 'The fiscal year is closed.',
      PERSONAL_PAYMENT_DOCUMENT_ALREADY_RECOGNIZED: 'This document is already recognized by another workflow.', PERSONAL_PAYMENT_VAT_UNSUPPORTED: 'Documents with VAT must go through the invoice or obligation path.',
      PERSONAL_PAYMENT_DOCUMENT_AMOUNT_MISMATCH: 'The amount must equal the document total.', PERSONAL_PAYMENT_EXCEEDS_OUTSTANDING: 'The amount exceeds the obligation outstanding balance.',
      PERSONAL_PAYMENT_OVER_REIMBURSEMENT: 'The reimbursement exceeds the remaining balance.', PERSONAL_BANK_TRANSACTION_ALREADY_EXPLAINED: 'This bank transaction is already explained elsewhere.',
      PERSONAL_PAYMENT_BANK_LEDGER_UNMAPPED: 'The bank account is not linked to a ledger account.', PERSONAL_PAYMENT_VERSION_CONFLICT: 'The record changed. Reload and try again.',
      PERSONAL_PAYER_INACTIVE: 'The payer is inactive.', PERSONAL_PAYER_DUPLICATE: 'This payer is already registered.',
    } as Record<string, string>, generic: 'The action could not be completed.',
  },
  ar: {
    title: 'المدفوعات الشخصية', intro: 'مصروفات دفعها مدير أو موظف أو شريك من ماله الخاص نيابةً عن الشركة.',
    tabs: { payments: 'المدفوعات', payables: 'المبالغ المستحقة', payers: 'الدافعون' }, newPayment: 'دفعة شخصية جديدة', edit: 'تعديل', save: 'حفظ المسودة', cancel: 'إلغاء',
    payer: 'الدافع', treatment: 'المعالجة', newExpense: 'مصروف جديد (مستند)', existingObligation: 'ذمة دائنة قائمة (إعادة تصنيف)', date: 'تاريخ الدفع', amount: 'المبلغ (ر.س)', purpose: 'الغرض',
    document: 'مستند المصروف', obligation: 'الذمة الدائنة', expenseAccount: 'حساب المصروف', select: 'اختر…', status: 'الحالة', outstanding: 'المتبقي', reimbursed: 'المسترد', actions: 'الإجراءات',
    submit: 'إرسال للمراجعة', approve: 'اعتماد', reject: 'رفض', reopen: 'إعادة فتحها كمسودة', remove: 'حذف', reimburse: 'استرداد', reason: 'سبب الرفض', confirmReject: 'تأكيد الرفض',
    bankTx: 'حركة صرف من بنك الشركة', record: 'تسجيل الاسترداد', noBank: 'لا توجد حركة بنكية مؤهلة.', empty: 'لا توجد مدفوعات شخصية بعد.', loading: 'جارٍ التحميل…', error: 'تعذّر تحميل المدفوعات الشخصية.',
    forbidden: 'لا تملك صلاحية عرض المدفوعات الشخصية.', employee: 'موظف / مدير', partner: 'شريك (الحساب الجاري)', owed: 'مستحق للدافع', approvedTotal: 'المعتمد',
    asOf: 'كما في', payersEmpty: 'لا يوجد دافعون مسجلون.', displayName: 'الاسم', payableAccount: 'حساب الذمة (التزامات)', partnerLink: 'الشريك (يستخدم حسابه الجاري)', member: 'عضو في الشركة (اختياري)',
    addPayer: 'إضافة دافع', mappingMissing: 'الربط المحاسبي ناقص', active: 'نشط', inactive: 'غير نشط', deactivate: 'إيقاف', activate: 'تفعيل', none: 'لا يوجد',
    statuses: { draft: 'مسودة', submitted: 'مرسلة', approved: 'معتمدة', rejected: 'مرفوضة' } as Record<Status, string>,
    settle: { none: 'غير مستردة', partial: 'مستردة جزئياً', full: 'مستردة بالكامل' } as Record<string, string>,
    errors: {
      PERSONAL_PAYMENT_MAPPING_MISSING: 'لا يوجد ربط محاسبي صالح للدافع. أصلح الربط قبل الاعتماد.',
      PERSONAL_PAYMENT_PERIOD_CLOSED: 'الفترة المحاسبية مغلقة.', PERSONAL_PAYMENT_FISCAL_YEAR_CLOSED: 'السنة المالية مغلقة.',
      PERSONAL_PAYMENT_DOCUMENT_ALREADY_RECOGNIZED: 'هذا المستند مثبت بالفعل في مسار آخر.', PERSONAL_PAYMENT_VAT_UNSUPPORTED: 'المستندات التي تتضمن ضريبة قيمة مضافة تمر عبر مسار الفواتير أو الذمم.',
      PERSONAL_PAYMENT_DOCUMENT_AMOUNT_MISMATCH: 'يجب أن يساوي المبلغ إجمالي المستند.', PERSONAL_PAYMENT_EXCEEDS_OUTSTANDING: 'المبلغ يتجاوز المتبقي من الذمة.',
      PERSONAL_PAYMENT_OVER_REIMBURSEMENT: 'الاسترداد يتجاوز الرصيد المتبقي.', PERSONAL_BANK_TRANSACTION_ALREADY_EXPLAINED: 'هذه الحركة البنكية مفسَّرة بالفعل في مسار آخر.',
      PERSONAL_PAYMENT_BANK_LEDGER_UNMAPPED: 'الحساب البنكي غير مربوط بحساب دفتري.', PERSONAL_PAYMENT_VERSION_CONFLICT: 'تغيّر السجل. أعد التحميل وحاول مجدداً.',
      PERSONAL_PAYER_INACTIVE: 'الدافع غير نشط.', PERSONAL_PAYER_DUPLICATE: 'هذا الدافع مسجل بالفعل.',
    } as Record<string, string>, generic: 'تعذّر تنفيذ الإجراء.',
  },
};

class ApiError extends Error { constructor(public status: number, public code: string | null) { super(code ?? String(status)); } }
async function api<T>(url: string, options: RequestInit, onUnauthorized: () => void): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  if (response.status === 401) onUnauthorized();
  if (response.status === 204) return undefined as T;
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, json && typeof json.code === 'string' ? json.code : null);
  return json as T;
}
const send = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const money = (v: string | undefined) => Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const emptyForm = { payer_id: '', treatment: 'new_expense' as Treatment, payment_date: '', amount: '', purpose: '', document_id: '', obligation_id: '', expense_account_id: '' };

export function PersonalPayments({ capabilities, onUnauthorized }: PersonalPaymentsProps) {
  const { i18n } = useTranslation();
  const L = i18n.language === 'ar' ? TEXT.ar : TEXT.en;
  const can = (c: string) => capabilities.includes(c);
  const canView = can('personal_payment.view');
  const [tab, setTab] = useState<'payments' | 'payables' | 'payers'>('payments');
  const [payments, setPayments] = useState<Payment[]>([]);
  const [payables, setPayables] = useState<Payables | null>(null);
  const [payers, setPayers] = useState<{ payers: Payer[] } & PayerExtras | null>(null);
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [loading, setLoading] = useState(canView);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<(typeof emptyForm & { id?: string; version?: number }) | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  const [reimbursing, setReimbursing] = useState<{ payment: Payment; options: BankTx[]; chosen: string } | null>(null);
  const [payerForm, setPayerForm] = useState({ display_name: '', partner_id: '', payable_account_id: '', user_id: '' });
  const [busy, setBusy] = useState(false);

  const fail = useCallback((e: unknown) => setMessage((e instanceof ApiError && e.code && L.errors[e.code]) || L.generic), [L]);
  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true); setFailed(false);
    try {
      const [list, pay, py] = await Promise.all([
        api<{ payments: Payment[] }>('/api/personal-payments', {}, onUnauthorized),
        api<Payables>(`/api/personal-payments/payables?as_of=${new Date().toISOString().slice(0, 10)}`, {}, onUnauthorized),
        api<{ payers: Payer[] } & PayerExtras>('/api/personal-payments/payers', {}, onUnauthorized),
      ]);
      setPayments(list.payments); setPayables(pay); setPayers(py);
    } catch { setFailed(true); } finally { setLoading(false); }
  }, [canView, onUnauthorized]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMessage(null);
    try { await fn(); await load(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const openForm = async (p?: Payment) => {
    setMessage(null);
    try {
      setLookups(await api<Lookups>('/api/personal-payments/lookups', {}, onUnauthorized));
      setForm(p ? { id: p.id, version: p.version, payer_id: p.payer_id, treatment: p.treatment, payment_date: p.payment_date, amount: p.amount, purpose: p.purpose, document_id: p.document_id ?? '', obligation_id: p.obligation_id ?? '', expense_account_id: p.expense_account_id ?? '' } : { ...emptyForm });
    } catch (e) { fail(e); }
  };
  const saveForm = (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const body: Record<string, unknown> = { payer_id: form.payer_id, treatment: form.treatment, payment_date: form.payment_date, amount: form.amount, purpose: form.purpose };
    if (form.treatment === 'new_expense') { body['document_id'] = form.document_id; body['expense_account_id'] = form.expense_account_id; } else body['obligation_id'] = form.obligation_id;
    void act(async () => {
      if (form.id) await api(`/api/personal-payments/${form.id}`, send('PATCH', { ...body, version: form.version }), onUnauthorized);
      else await api('/api/personal-payments', send('POST', body), onUnauthorized);
      setForm(null);
    });
  };
  const post = (id: string, action: string, body: unknown = {}) => act(() => api(`/api/personal-payments/${id}/${action}`, send('POST', body), onUnauthorized));
  const startReimburse = async (payment: Payment) => {
    setMessage(null);
    try {
      const r = await api<{ transactions: BankTx[] }>(`/api/personal-payments/${payment.id}/reimbursable-bank-transactions`, {}, onUnauthorized);
      setReimbursing({ payment, options: r.transactions, chosen: '' });
    } catch (e) { fail(e); }
  };
  const addPayer = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { display_name: payerForm.display_name };
    if (payerForm.partner_id) body['partner_id'] = payerForm.partner_id; else if (payerForm.payable_account_id) body['payable_account_id'] = payerForm.payable_account_id;
    if (payerForm.user_id) body['user_id'] = payerForm.user_id;
    void act(async () => { await api('/api/personal-payments/payers', send('POST', body), onUnauthorized); setPayerForm({ display_name: '', partner_id: '', payable_account_id: '', user_id: '' }); });
  };

  if (!canView) return <WorkspaceState tone="error">{L.forbidden}</WorkspaceState>;
  if (loading) return <WorkspaceState>{L.loading}</WorkspaceState>;
  if (failed) return <WorkspaceState tone="error">{L.error}</WorkspaceState>;

  const set = (k: keyof typeof emptyForm, v: string) => setForm(f => f && ({ ...f, [k]: v }));
  const tabs = (['payments', 'payables', 'payers'] as const).map(k => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{L.tabs[k]}</button>);

  return (
    <section className="personal-payments" aria-labelledby="pp-title">
      <header><h2 id="pp-title">{L.title}</h2><p>{L.intro}</p></header>
      <div className="workspace-tabs" role="tablist">{tabs}</div>
      {message && <div className="pp-message" role="alert">{message}</div>}

      {tab === 'payments' && <>
        {can('personal_payment.create') && !form && <button type="button" className="pp-primary" onClick={() => void openForm()}>{L.newPayment}</button>}
        {form && lookups && <form className="pp-form" onSubmit={saveForm}>
          <label>{L.payer}<select required value={form.payer_id} onChange={e => set('payer_id', e.target.value)}><option value="">{L.select}</option>{lookups.payers.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label>
          <label>{L.treatment}<select value={form.treatment} onChange={e => set('treatment', e.target.value)}><option value="new_expense">{L.newExpense}</option><option value="existing_obligation">{L.existingObligation}</option></select></label>
          {form.treatment === 'new_expense'
            ? <>
              <label>{L.document}<select required value={form.document_id} onChange={e => { const d = lookups.documents?.find(x => x.id === e.target.value); setForm(f => f && ({ ...f, document_id: e.target.value, amount: d?.total_amount ?? f.amount })); }}><option value="">{L.select}</option>{lookups.documents?.map(d => <option key={d.id} value={d.id}>{d.original_filename} — {money(d.total_amount)} ({d.document_date})</option>)}</select></label>
              <label>{L.expenseAccount}<select required value={form.expense_account_id} onChange={e => set('expense_account_id', e.target.value)}><option value="">{L.select}</option>{lookups.expense_accounts?.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
            </>
            : <label>{L.obligation}<select required value={form.obligation_id} onChange={e => set('obligation_id', e.target.value)}><option value="">{L.select}</option>{lookups.obligations?.map(o => <option key={o.id} value={o.id}>{o.counterparty_name} — {money(o.outstanding)} ({o.recognized_on})</option>)}</select></label>}
          <label>{L.date}<input required type="date" value={form.payment_date} onChange={e => set('payment_date', e.target.value)} /></label>
          <label>{L.amount}<input required inputMode="decimal" value={form.amount} onChange={e => set('amount', e.target.value)} /></label>
          <label>{L.purpose}<input required maxLength={500} value={form.purpose} onChange={e => set('purpose', e.target.value)} /></label>
          <div className="pp-actions"><button type="submit" className="pp-primary" disabled={busy}>{L.save}</button><button type="button" onClick={() => setForm(null)}>{L.cancel}</button></div>
        </form>}
        {payments.length === 0 ? <WorkspaceState kind="empty">{L.empty}</WorkspaceState> : <div className="responsive-table"><table>
          <thead><tr><th>{L.payer}</th><th>{L.purpose}</th><th>{L.date}</th><th>{L.amount}</th><th>{L.status}</th><th>{L.outstanding}</th><th>{L.actions}</th></tr></thead>
          <tbody>{payments.map(p => <tr key={p.id}>
            <td>{p.payer_name}<small> {p.payer_kind === 'partner' ? L.partner : L.employee}</small></td><td>{p.purpose}{p.rejection_reason && <small> — {p.rejection_reason}</small>}</td><td>{p.payment_date}</td><td>{money(p.amount)}</td>
            <td><StatusBadge status={p.status}>{L.statuses[p.status]}</StatusBadge>{p.status === 'approved' && <small> {L.settle[p.settlement_status ?? 'none']}</small>}</td>
            <td>{p.status === 'approved' ? money(p.outstanding_amount) : '—'}</td>
            <td className="pp-actions">
              {p.status === 'draft' && can('personal_payment.create') && <><button type="button" onClick={() => void openForm(p)}>{L.edit}</button><button type="button" disabled={busy} onClick={() => void act(() => api(`/api/personal-payments/${p.id}?version=${p.version}`, { method: 'DELETE' }, onUnauthorized))}>{L.remove}</button></>}
              {p.status === 'draft' && can('personal_payment.submit') && <button type="button" disabled={busy} onClick={() => void post(p.id, 'submit')}>{L.submit}</button>}
              {p.status === 'submitted' && can('personal_payment.review') && <><button type="button" disabled={busy} onClick={() => void post(p.id, 'approve')}>{L.approve}</button><button type="button" onClick={() => setRejecting({ id: p.id, reason: '' })}>{L.reject}</button></>}
              {p.status === 'rejected' && can('personal_payment.create') && <button type="button" disabled={busy} onClick={() => void post(p.id, 'reopen')}>{L.reopen}</button>}
              {p.status === 'approved' && p.settlement_status !== 'full' && can('personal_payment.reimburse') && <button type="button" onClick={() => void startReimburse(p)}>{L.reimburse}</button>}
            </td></tr>)}</tbody></table></div>}
        {rejecting && <form className="pp-form" onSubmit={e => { e.preventDefault(); void post(rejecting.id, 'reject', { reason: rejecting.reason }).then(() => setRejecting(null)); }}>
          <label>{L.reason}<input required maxLength={500} value={rejecting.reason} onChange={e => setRejecting({ ...rejecting, reason: e.target.value })} /></label>
          <div className="pp-actions"><button type="submit" className="pp-primary" disabled={busy}>{L.confirmReject}</button><button type="button" onClick={() => setRejecting(null)}>{L.cancel}</button></div></form>}
        {reimbursing && <form className="pp-form" onSubmit={e => { e.preventDefault(); void post(reimbursing.payment.id, 'reimbursements', { bank_transaction_id: reimbursing.chosen }).then(() => setReimbursing(null)); }}>
          {reimbursing.options.length === 0 ? <p>{L.noBank}</p> : <label>{L.bankTx}<select required value={reimbursing.chosen} onChange={e => setReimbursing({ ...reimbursing, chosen: e.target.value })}><option value="">{L.select}</option>{reimbursing.options.map(t => <option key={t.id} value={t.id}>{t.transaction_date} — {money(t.amount)} — {t.bank_account_name}</option>)}</select></label>}
          <div className="pp-actions"><button type="submit" className="pp-primary" disabled={busy || !reimbursing.chosen}>{L.record}</button><button type="button" onClick={() => setReimbursing(null)}>{L.cancel}</button></div></form>}
      </>}

      {tab === 'payables' && (!payables || payables.payers.length === 0 ? <WorkspaceState kind="empty">{L.empty}</WorkspaceState> : <div className="responsive-table"><table>
        <caption>{L.asOf} {payables.as_of}</caption>
        <thead><tr><th>{L.payer}</th><th>{L.approvedTotal}</th><th>{L.reimbursed}</th><th>{L.owed}</th></tr></thead>
        <tbody>{payables.payers.map(p => <tr key={p.payer_id}><td>{p.payer_name}<small> {p.payer_kind === 'partner' ? L.partner : L.employee}</small></td><td>{money(p.approved_amount)}</td><td>{money(p.reimbursed_amount)}</td><td>{money(p.outstanding_amount)}</td></tr>)}</tbody></table></div>)}

      {tab === 'payers' && <>
        {can('personal_payment.payer.manage') && <form className="pp-form" onSubmit={addPayer}>
          <label>{L.displayName}<input required maxLength={200} value={payerForm.display_name} onChange={e => setPayerForm({ ...payerForm, display_name: e.target.value })} /></label>
          <label>{L.partnerLink}<select value={payerForm.partner_id} onChange={e => setPayerForm({ ...payerForm, partner_id: e.target.value, payable_account_id: '' })}><option value="">{L.none}</option>{payers?.partners?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          {!payerForm.partner_id && <label>{L.payableAccount}<select required value={payerForm.payable_account_id} onChange={e => setPayerForm({ ...payerForm, payable_account_id: e.target.value })}><option value="">{L.select}</option>{payers?.accounts?.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>}
          <label>{L.member}<select value={payerForm.user_id} onChange={e => setPayerForm({ ...payerForm, user_id: e.target.value })}><option value="">{L.none}</option>{payers?.members?.map(m => <option key={m.id} value={m.id}>{m.email}</option>)}</select></label>
          <div className="pp-actions"><button type="submit" className="pp-primary" disabled={busy}>{L.addPayer}</button></div>
        </form>}
        {!payers || payers.payers.length === 0 ? <WorkspaceState kind="empty">{L.payersEmpty}</WorkspaceState> : <div className="responsive-table"><table>
          <thead><tr><th>{L.displayName}</th><th>{L.treatment}</th><th>{L.status}</th><th>{L.actions}</th></tr></thead>
          <tbody>{payers.payers.map(p => <tr key={p.id}><td>{p.display_name}</td>
            <td>{p.partner_id ? `${L.partner}: ${p.partner_name ?? ''}` : `${L.employee}: ${p.payable_account_code ?? ''}`}{!p.mapping_valid && <small> — {L.mappingMissing}</small>}</td>
            <td>{p.is_active ? L.active : L.inactive}</td>
            <td>{can('personal_payment.payer.manage') && <button type="button" disabled={busy} onClick={() => void act(() => api(`/api/personal-payments/payers/${p.id}`, send('PATCH', { is_active: !p.is_active, version: p.version }), onUnauthorized))}>{p.is_active ? L.deactivate : L.activate}</button>}</td></tr>)}</tbody></table></div>}
      </>}
    </section>
  );
}
