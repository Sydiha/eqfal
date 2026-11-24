import { EmployeeBonusBankPayment } from './EmployeeBonusBankPayment';
import { EmployeeBonusDraft } from './EmployeeBonusDraft';
import { Select } from '@mantine/core';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useOptionalCompany } from '../context/CompanyContext';

type Bonus = {
  id: string;
  display_name: string;
  award_code?: string;
  period_start: string;
  period_end: string;
  amount: string;
  approved_at: string | null;
  accounting_date: string | null;
  outstanding: string | null;
  settled: string;
  pending_payroll?: string;
  liability_line_id?: string | null;
  schedule?: { id: string; due_on: string; amount: string; channel: string }[];
};
type Account = { id: string; code: string; name: string; name_ar?: string | null; account_type: string; is_active: boolean; has_children?: boolean };

type Props = { arabic: boolean; onUnauthorized: () => void; capabilities?: string[]; employees?: { id: string; display_name: string }[] };

const sumMoney = (values: string[]) => { const cents = values.reduce((s, v) => { const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(v); if (!m) return s; const c = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0'); return m[1] ? s - c : s + c; }, 0n); return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`; };

export function EmployeeBonusBalances({ arabic, onUnauthorized, capabilities = [], employees = [] }: Props) {
  const company = useOptionalCompany();
  const companyKey = company?.activeCompanyId ?? 'active-session';
  const [bonuses, setBonuses] = useState<Bonus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [recognitionSelections, setRecognitionSelections] = useState<Record<string, string>>({});
  const [recognitionError, setRecognitionError] = useState('');
  const [scheduleFeedback, setScheduleFeedback] = useState<{ bonusId: string; type: 'success' | 'error'; message: string } | null>(null);
  const submitting = useRef(false);
  const scheduleRequests = useRef<Record<string, { signature: string; key: string }>>({});
  const label = (ar: string, en: string) => arabic ? ar : en;
  useEffect(() => {
    if (company && !company.activeCompanyId) {
      setAccounts(null);
      return;
    }
    const controller = new AbortController();
    setAccounts(null);
    setAccountsFailed(false);
    setRecognitionSelections({});
    setRecognitionError('');
    fetch('/api/accounts', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (response.status === 401) onUnauthorized();
        if (!response.ok) throw new Error('Could not load accounts');
        const data = await response.json() as { accounts?: Account[] };
        if (!Array.isArray(data.accounts)) throw new Error('Invalid account response');
        if (!controller.signal.aborted) setAccounts(data.accounts);
      })
      .catch(() => { if (!controller.signal.aborted) setAccountsFailed(true); });
    return () => controller.abort();
  }, [companyKey, company?.activeCompanyId, onUnauthorized]);
  const expenseAccounts = (accounts ?? []).filter(account => account.account_type === 'expense' && account.is_active && account.has_children === false);
  const liabilityAccounts = (accounts ?? []).filter(account => account.account_type === 'liability' && account.is_active && account.has_children === false);
  const accountOptions = (list: Account[]) => list.map(account => ({ value: account.id, label: `${account.code} — ${account.name_ar || account.name}` }));
  const selectRecognitionAccount = (key: string, value: string | null) => setRecognitionSelections(current => ({ ...current, [key]: value ?? '' }));
  async function load(): Promise<boolean> {
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch('/api/employee-bonuses', { credentials: 'same-origin' });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error('Could not load bonuses');
      const data = await response.json() as { bonuses: Bonus[] };
      setBonuses(data.bonuses);
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setLoading(false);
    }
  }
  const can = (capability: string) => capabilities.includes(capability);
  async function submit(id: string, action: 'approval' | 'schedule' | 'recognition', payload: object) {
    if (submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/employee-bonuses/${id}/${action}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) {
        let code = '';
        let detail = '';
        try {
          const body = await response.clone().json() as { code?: string; message?: string; detail?: string };
          code = String(body.code ?? '');
          detail = String(body.detail ?? body.message ?? '');
        } catch { /* use the HTTP status when the server has no JSON error body */ }
        if (action === 'schedule') {
          const codeLabel = code ? ` (${code})` : ` (HTTP ${response.status})`;
          const message = code === 'BONUS_SCHEDULE_INVALID'
            ? label('تحقق من تاريخ الدفع، وأدخل مبلغاً موجباً بصيغة رقمية حتى منزلتين عشريتين، واختر مسار صرف صحيحاً.', 'Check the due date, enter a positive numeric amount with up to two decimal places, and choose a valid payment channel.')
            : code === 'BONUS_SCHEDULE_INELIGIBLE'
              ? label('لا يمكن الجدولة: يجب أن يكون الاستحقاق معتمداً وبمبلغ موجب.', 'This entitlement cannot be scheduled: it must be approved with a positive amount.')
              : code === 'BONUS_SCHEDULE_EXCEEDS_APPROVED'
                ? label('المبلغ يتجاوز الرصيد المعتمد المتاح. خفّض المبلغ أو راجع الدفعات المجدولة.', 'The amount exceeds the approved balance available. Reduce it or review the existing installments.')
                : code === 'BONUS_SCHEDULE_CONFLICT'
                  ? label('تعارض مفتاح الطلب مع محاولة سابقة. حدّث الأرصدة قبل إعادة الجدولة.', 'This request key conflicts with a previous attempt. Refresh balances before scheduling again.')
                  : response.status === 403
                    ? label('لا تملك الصلاحية اللازمة لجدولة دفعة المكافأة.', 'You do not have permission to schedule a bonus payment.')
                    : code === 'DB_UNAVAILABLE'
                      ? label('خدمة الحفظ غير متاحة حالياً. حدّث الأرصدة ثم أعد المحاولة.', 'Saving is temporarily unavailable. Refresh balances and retry.')
                      : label('تعذر حفظ موعد الدفع. راجع البيانات وحالة الاستحقاق، ثم أعد المحاولة.', 'Could not save the payment schedule. Check the values and entitlement status, then retry.');
          setScheduleFeedback({ bonusId: id, type: 'error', message: `${message}${codeLabel}${detail ? ` — ${detail}` : ''}` });
          return;
        }
        if (action === 'recognition') setRecognitionError(code === 'BONUS_ACCOUNTS_INELIGIBLE'
          ? label('الحساب المحدد غير مؤهل أو لم يعد متاحًا لهذه الشركة. حدّث الحسابات واختر حسابًا نشطًا من النوع الصحيح.', 'The selected account is no longer eligible for this company. Refresh and choose an active account of the required type.')
          : label('تعذر ترحيل الاعتراف. تحقق من التواريخ ودليل الاستحقاق وأهلية الحسابات.', 'Could not post recognition. Check the dates, evidence, and account eligibility.'));
        throw new Error('Could not save bonus');
      }
      if (action === 'schedule') {
        const key = (payload as { request_key?: string }).request_key;
        if (scheduleRequests.current[id]?.key === key) delete scheduleRequests.current[id];
      }
      const refreshed = await load();
      if (action === 'schedule') setScheduleFeedback({
        bonusId: id, type: 'success',
        message: refreshed
          ? label('تم حفظ موعد الدفع وتحديث جدول المكافأة.', 'Payment schedule saved and bonus balances refreshed.')
          : label('تم حفظ الموعد، لكن تعذر تحديث الجدول. اضغط «تحديث الأرصدة» للتحقق من الموعد المحفوظ.', 'The schedule was saved, but the list could not refresh. Select “Refresh balances” to verify the saved installment.'),
      });
    } catch {
      if (action === 'schedule') setScheduleFeedback({
        bonusId: id, type: 'error',
        message: label('تعذر الاتصال بالخادم أثناء الحفظ. أعد المحاولة؛ سيُعاد استخدام مفتاح الطلب لتجنب تكرار الجدولة.', 'Could not reach the server while saving. Retry; the same request key will be reused to prevent a duplicate schedule.'),
      });
      else if (action !== 'recognition') setFailed(true);
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }
  function submitForm(event: FormEvent<HTMLFormElement>, id: string, action: 'schedule' | 'recognition') {
    event.preventDefault();
    if (action === 'recognition' && (!recognitionSelections[`${id}:expense`] || !recognitionSelections[`${id}:liability`])) {
      setRecognitionError(label('اختر حساب المصروف وحساب الالتزام قبل الترحيل.', 'Select both the expense and liability accounts before posting.'));
      return;
    }
    setRecognitionError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (action === 'schedule') {
      const signature = JSON.stringify(values);
      const prior = scheduleRequests.current[id];
      const key = prior?.signature === signature ? prior.key : crypto.randomUUID();
      scheduleRequests.current[id] = { signature, key };
      setScheduleFeedback(null);
      void submit(id, action, { ...values, request_key: key });
    } else void submit(id, action, values);
  }
  return <section className="ecc-card" dir={arabic ? 'rtl' : 'ltr'} aria-labelledby="employee-bonus-title">
    <div className="ecc-card-head">
      <h3 id="employee-bonus-title">{label('أرصدة المكافآت', 'Bonus balances')}</h3>
      <button type="button" disabled={loading} onClick={() => void load()}>
        {bonuses ? label('تحديث الأرصدة', 'Refresh balances') : label('عرض الأرصدة', 'Show balances')}
      </button>
    </div>
    {can('employee_cost.create') && <EmployeeBonusDraft employees={employees} arabic={arabic}
      onSaved={() => void load()} onUnauthorized={onUnauthorized} />}
    {loading && <p role="status">{label('جارٍ التحميل', 'Loading')}</p>}
    {failed && <p role="alert">{label('تعذر تحميل أرصدة المكافآت', 'Could not load bonus balances')}</p>}
    {bonuses?.length === 0 && <p>{label('لا توجد مكافآت', 'No bonuses')}</p>}
    {!!bonuses?.length && <><p className="ecc-muted">{label('إجماليات المكافآت المعروضة أدناه', 'Totals of the bonuses listed below')}</p><div className="ecc-summary ecc-summary-4">{([[label('المبلغ المعتمد','Approved amount'),bonuses.filter(b=>b.approved_at).map(b=>b.amount)],[label('المسوّى','Settled'),bonuses.map(b=>b.settled)],[label('بانتظار صرف الرواتب','Pending payroll payment'),bonuses.map(b=>b.pending_payroll??'0')],[label('المتبقي','Outstanding'),bonuses.map(b=>b.outstanding??'0')]] as [string,string[]][]).map(([name,values])=><div className="ecc-summary-card" key={name}><span>{name}</span><strong><bdi dir="ltr">{sumMoney(values)}</bdi></strong></div>)}</div></>}
    {!!bonuses?.length && <div className="ecc-table-wrap"><table>
      <thead><tr>
        <th scope="col">{label('الموظف', 'Employee')}</th>
        <th scope="col">{label('الفترة', 'Period')}</th>
        <th scope="col">{label('المبلغ المعتمد (ر.س)', 'Approved amount (SAR)')}</th>
        <th scope="col">{label('تاريخ الاعتراف', 'Recognition date')}</th>
        <th scope="col">{label('المسوّى (ر.س)', 'Settled (SAR)')}</th>
        <th scope="col">{label('بانتظار صرف الرواتب (ر.س)', 'Pending payroll payment (SAR)')}</th>
        <th scope="col">{label('المتبقي (ر.س)', 'Outstanding (SAR)')}</th>
        <th scope="col">{label('الجدول والإجراءات', 'Schedule and actions')}</th>
      </tr></thead>
      <tbody>{bonuses.map(bonus => <tr key={bonus.id}>
        <td>{bonus.display_name}{bonus.award_code && <> · <bdi>{bonus.award_code}</bdi></>} <span className={`ecc-chip ${bonus.approved_at?'ecc-chip-approved':'ecc-chip-draft'}`}>{bonus.approved_at?label('معتمدة','Approved'):label('مسودة','Draft')}</span></td>
        <td><bdi>{bonus.period_start} – {bonus.period_end}</bdi></td>
        <td><bdi>{bonus.approved_at ? bonus.amount : '—'}</bdi></td>
        <td><bdi>{bonus.accounting_date ?? '—'}</bdi></td>
        <td><bdi>{bonus.settled}</bdi></td>
        <td><bdi>{bonus.pending_payroll ?? '0.00'}</bdi></td>
        <td><bdi>{bonus.outstanding ?? '—'}</bdi></td>
        <td>
          {bonus.liability_line_id && Number(bonus.outstanding)>Number(bonus.pending_payroll ?? 0) &&
            ['payroll.view','payroll.settlement.view','payroll.settlement.create','bank.view','bank.reconcile'].every(can) &&
            <EmployeeBonusBankPayment liabilityLine={bonus.liability_line_id} arabic={arabic}
              onSaved={() => void load()} onUnauthorized={onUnauthorized} />}
          {!!bonus.schedule?.length && <ul>{bonus.schedule.map(item => <li key={item.id}>
            <bdi>{item.due_on} · {item.amount}</bdi> {item.channel === 'payroll' ? label('رواتب', 'Payroll') : label('بنك', 'Bank')}
          </li>)}</ul>}
          {!bonus.approved_at && can('employee_cost.approve') && <p>
            {label('المبلغ المحسوب للمراجعة', 'Calculated amount for review')}: <bdi>{bonus.amount}</bdi>
          </p>}
          {!bonus.approved_at && can('employee_cost.approve') && <button type="button" disabled={loading}
            onClick={() => void submit(bonus.id, 'approval', {})}>{label('اعتماد', 'Approve')}</button>}
          {bonus.approved_at && !bonus.accounting_date && Number(bonus.amount) > 0 &&
            can('employee_cost.approve') && can('accounting.journal.post') && <details>
            <summary>{label('إثبات الاستحقاق والترحيل', 'Evidence and recognition')}</summary>
            <form onSubmit={event => submitForm(event, bonus.id, 'recognition')}>
              <label>{label('تاريخ تحقق الشرط', 'Fulfillment date')} <input name="fulfilled_on" type="date" required /></label>
              <label>{label('تاريخ الاعتراف', 'Accounting date')} <input name="accounting_date" type="date" required /></label>
              <label>{label('دليل الاستحقاق', 'Supporting evidence')} <textarea name="evidence" required maxLength={4000} /></label>
              <label>{label('سبب اختلاف التاريخ', 'Reason for date difference')} <input name="date_reason" maxLength={1000} /></label>
              <label>{label('حساب المصروف', 'Expense account')}
                <Select name="expense_account_id" aria-label={label('حساب المصروف', 'Expense account')} data={accountOptions(expenseAccounts)} value={recognitionSelections[`${bonus.id}:expense`] || null}
                  onChange={value => selectRecognitionAccount(`${bonus.id}:expense`, value)} searchable required disabled={accounts === null || accountsFailed}
                  placeholder={accounts === null ? label('جارٍ تحميل الحسابات', 'Loading accounts') : expenseAccounts.length ? label('اختر حساب المصروف', 'Select an expense account') : label('لا توجد حسابات مصروف مؤهلة', 'No eligible expense accounts')}
                  nothingFoundMessage={label('لا توجد نتائج مطابقة', 'No matching accounts')} />
              </label>
              <label>{label('حساب الالتزام', 'Liability account')}
                <Select name="liability_account_id" aria-label={label('حساب الالتزام', 'Liability account')} data={accountOptions(liabilityAccounts)} value={recognitionSelections[`${bonus.id}:liability`] || null}
                  onChange={value => selectRecognitionAccount(`${bonus.id}:liability`, value)} searchable required disabled={accounts === null || accountsFailed}
                  placeholder={accounts === null ? label('جارٍ تحميل الحسابات', 'Loading accounts') : liabilityAccounts.length ? label('اختر حساب الالتزام', 'Select a liability account') : label('لا توجد حسابات التزام مؤهلة', 'No eligible liability accounts')}
                  nothingFoundMessage={label('لا توجد نتائج مطابقة', 'No matching accounts')} />
              </label>
              {accounts === null && !accountsFailed && <p role="status">{label('جارٍ تحميل حسابات الشركة', 'Loading company accounts')}</p>}
              {accountsFailed && <p role="alert">{label('تعذر تحميل الحسابات. حدّث الصفحة أو تحقق من صلاحية عرض الحسابات.', 'Could not load accounts. Refresh or check account viewing access.')}</p>}
              {accounts !== null && !accountsFailed && !expenseAccounts.length && <p role="status">{label('لا توجد حسابات مصروف نشطة وقابلة للترحيل.', 'No active, postable expense accounts are available.')}</p>}
              {accounts !== null && !accountsFailed && !liabilityAccounts.length && <p role="status">{label('لا توجد حسابات التزام نشطة وقابلة للترحيل.', 'No active, postable liability accounts are available.')}</p>}
              {recognitionError && <p role="alert">{recognitionError}</p>}
              <button disabled={loading || accounts === null || accountsFailed || !expenseAccounts.length || !liabilityAccounts.length}>{label('ترحيل الاعتراف', 'Post recognition')}</button>
            </form>
          </details>}
          {bonus.approved_at && Number(bonus.amount) > 0 && can('employee_cost.payment.allocate') && <details>
            <summary>{label('جدولة دفعة', 'Schedule payment')}</summary>
            <form onSubmit={event => submitForm(event, bonus.id, 'schedule')}>
              <label>{label('موعد الدفع', 'Due date')} <input name="due_on" type="date" required /></label>
              <label>{label('المبلغ', 'Amount')} <input name="amount" inputMode="decimal" required /></label>
              <label>{label('مسار الصرف', 'Payment channel')} <select name="channel">
                <option value="bank">{label('بنك', 'Bank')}</option>
                <option value="payroll">{label('رواتب', 'Payroll')}</option>
              </select></label>
              {scheduleFeedback?.bonusId === bonus.id && <p role={scheduleFeedback.type === 'error' ? 'alert' : 'status'}>{scheduleFeedback.message}</p>}
              <button disabled={loading}>{label('حفظ الموعد', 'Save schedule')}</button>
            </form>
          </details>}
        </td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
