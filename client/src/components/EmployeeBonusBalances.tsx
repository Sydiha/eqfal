import { EmployeeBonusBankPayment } from './EmployeeBonusBankPayment';
import { EmployeeBonusDraft } from './EmployeeBonusDraft';
import { useState, type FormEvent } from 'react';

type Bonus = {
  id: string;
  display_name: string;
  period_start: string;
  period_end: string;
  amount: string;
  approved_at: string | null;
  accounting_date: string | null;
  outstanding: string | null;
  settled: string;
  liability_line_id?: string | null;
  schedule?: { id: string; due_on: string; amount: string; channel: string }[];
};

type Props = { arabic: boolean; onUnauthorized: () => void; capabilities?: string[]; employees?: { id: string; display_name: string }[] };

export function EmployeeBonusBalances({ arabic, onUnauthorized, capabilities = [], employees = [] }: Props) {
  const [bonuses, setBonuses] = useState<Bonus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = (ar: string, en: string) => arabic ? ar : en;
  async function load() {
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch('/api/employee-bonuses', { credentials: 'same-origin' });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error('Could not load bonuses');
      const data = await response.json() as { bonuses: Bonus[] };
      setBonuses(data.bonuses);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }
  const can = (capability: string) => capabilities.includes(capability);
  async function submit(id: string, action: 'approval' | 'schedule' | 'recognition', payload: object) {
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/employee-bonuses/${id}/${action}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error('Could not save bonus');
      await load();
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }
  function submitForm(event: FormEvent<HTMLFormElement>, id: string, action: 'schedule' | 'recognition') {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    void submit(id, action, action === 'schedule' ? { ...values, request_key: crypto.randomUUID() } : values);
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
    {!!bonuses?.length && <div className="ecc-table-wrap"><table>
      <thead><tr>
        <th scope="col">{label('الموظف', 'Employee')}</th>
        <th scope="col">{label('الفترة', 'Period')}</th>
        <th scope="col">{label('المبلغ المعتمد (ر.س)', 'Approved amount (SAR)')}</th>
        <th scope="col">{label('تاريخ الاعتراف', 'Recognition date')}</th>
        <th scope="col">{label('المسوّى (ر.س)', 'Settled (SAR)')}</th>
        <th scope="col">{label('المتبقي (ر.س)', 'Outstanding (SAR)')}</th>
        <th scope="col">{label('الجدول والإجراءات', 'Schedule and actions')}</th>
      </tr></thead>
      <tbody>{bonuses.map(bonus => <tr key={bonus.id}>
        <td>{bonus.display_name}</td>
        <td><bdi>{bonus.period_start} – {bonus.period_end}</bdi></td>
        <td><bdi>{bonus.approved_at ? bonus.amount : '—'}</bdi></td>
        <td><bdi>{bonus.accounting_date ?? '—'}</bdi></td>
        <td><bdi>{bonus.settled}</bdi></td>
        <td><bdi>{bonus.outstanding ?? '—'}</bdi></td>
        <td>
          {bonus.liability_line_id && Number(bonus.outstanding)>0 &&
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
              <label>{label('معرّف حساب المصروف', 'Expense account ID')} <input name="expense_account_id" required /></label>
              <label>{label('معرّف حساب الالتزام', 'Liability account ID')} <input name="liability_account_id" required /></label>
              <button disabled={loading}>{label('ترحيل الاعتراف', 'Post recognition')}</button>
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
              <button disabled={loading}>{label('حفظ الموعد', 'Save schedule')}</button>
            </form>
          </details>}
        </td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
