import { useState, type FormEvent } from 'react';

type Employee = { id: string; display_name: string };
type Props = { employees: Employee[]; arabic: boolean; onSaved: () => void; onUnauthorized: () => void };

export function EmployeeBonusDraft({ employees, arabic, onSaved, onUnauthorized }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [method, setMethod] = useState('fixed');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const label = (ar: string, en: string) => arabic ? ar : en;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/employee-bonuses', {
        credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_key: requestKey, award_code: fields.get('award_code'), frequency: fields.get('frequency'),
          period_start: fields.get('period_start'), period_end: fields.get('period_end'),
          eligibility_condition: fields.get('eligibility_condition'), recognition_condition: fields.get('recognition_condition'),
          employees: selected.map(id => ({
            employee_id: id, method, basis: method === 'percentage' ? fields.get('basis') : null,
            value: fields.get(`value:${id}`), basic_salary: fields.get(`salary:${id}`) ?? '0',
            allowances: fields.get(`allowances:${id}`) ?? '0',
          })),
        }),
      });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) {
        setMessage(response.status === 403
          ? label('تحتاج إلى صلاحية إنشاء المكافآت.', 'Bonus creation permission is required.')
          : label('راجع تواريخ الفترة والمبالغ والموظفين، ثم أعد المحاولة.', 'Check the period dates, amounts, and employees, then retry.'));
        return;
      }
      form.reset();
      setSelected([]);
      setMethod('fixed');
      setRequestKey(crypto.randomUUID());
      setMessage(label('حُفظت المسودات. راجع المبالغ قبل الاعتماد.', 'Drafts saved. Review the amounts before approval.'));
      onSaved();
    } catch {
      setMessage(label('تعذر الاتصال. حدّث الأرصدة للتحقق من الحفظ قبل المحاولة مجددًا.', 'Connection failed. Refresh balances to check whether the drafts were saved before retrying.'));
    } finally { setBusy(false); }
  }

  return <details>
    <summary>{label('إعداد مكافأة', 'Prepare bonus')}</summary>
    <form onSubmit={event => void save(event)}>
      <fieldset disabled={busy}>
        <legend>{label('الفترة وشروط الاستحقاق', 'Period and entitlement conditions')}</legend>
        <label>{label('رمز المكافأة', 'Award code')} <input name="award_code" defaultValue="standard"
          pattern="[a-z0-9][a-z0-9_\-]{0,49}" maxLength={50} required /></label>
        <label>{label('الدورية', 'Frequency')} <select name="frequency">
          <option value="monthly">{label('شهرية', 'Monthly')}</option>
          <option value="quarterly">{label('ربع سنوية', 'Quarterly')}</option>
          <option value="annual">{label('سنوية', 'Annual')}</option>
          <option value="one_time">{label('لمرة واحدة', 'One time')}</option>
        </select></label>
        <label>{label('بداية الفترة', 'Period start')} <input name="period_start" type="date" required /></label>
        <label>{label('نهاية الفترة', 'Period end')} <input name="period_end" type="date" required /></label>
        <label>{label('شرط الأهلية', 'Eligibility condition')} <input name="eligibility_condition" maxLength={1000} required /></label>
        <label>{label('شرط الاعتراف', 'Recognition condition')} <input name="recognition_condition" maxLength={1000} required /></label>
        <label>{label('طريقة الحساب', 'Calculation method')} <select value={method} onChange={event => setMethod(event.target.value)}>
          <option value="fixed">{label('مبلغ ثابت', 'Fixed amount')}</option>
          <option value="basic_multiplier">{label('مضاعف الراتب الأساسي', 'Basic salary multiplier')}</option>
          <option value="total_multiplier">{label('مضاعف الراتب الإجمالي', 'Total salary multiplier')}</option>
          <option value="percentage">{label('نسبة مئوية', 'Percentage')}</option>
        </select></label>
        {method === 'percentage' && <label>{label('أساس النسبة', 'Percentage basis')} <select name="basis">
          <option value="basic">{label('الأساسي', 'Basic')}</option>
          <option value="total">{label('الإجمالي', 'Total')}</option>
        </select></label>}
        {employees.map(employee => <fieldset key={employee.id}>
          <legend>{employee.display_name}</legend>
          <label><input type="checkbox" checked={selected.includes(employee.id)} onChange={event => {
            const checked = event.target.checked;
            setSelected(previous => checked ? [...previous, employee.id] : previous.filter(id => id !== employee.id));
          }} /> {label('تخصيص مكافأة', 'Allocate bonus')}</label>
          {selected.includes(employee.id) && <>
            <label>{label('قيمة الحساب', 'Calculation value')} <input name={`value:${employee.id}`} inputMode="decimal" required /></label>
            {method !== 'fixed' && <>
              <label>{label('الراتب الأساسي', 'Basic salary')} <input name={`salary:${employee.id}`} inputMode="decimal" required /></label>
              <label>{label('البدلات المشمولة', 'Applicable allowances')} <input name={`allowances:${employee.id}`} defaultValue="0" inputMode="decimal" required /></label>
            </>}
          </>}
        </fieldset>)}
        <button disabled={!selected.length}>{label('حفظ للمراجعة', 'Save for review')}</button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </form>
  </details>;
}
