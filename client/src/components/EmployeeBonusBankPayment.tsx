import { useState, type FormEvent } from 'react';

type Bank = { id: string; transaction_date: string; bank_reference: string | null; remaining_amount: string };
type Props = { liabilityLine: string; arabic: boolean; onSaved: () => void; onUnauthorized: () => void };

export function EmployeeBonusBankPayment({ liabilityLine, arabic, onSaved, onUnauthorized }: Props) {
  const [banks, setBanks] = useState<Bank[] | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const label = (ar: string, en: string) => arabic ? ar : en;
  async function load() {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/payroll/settlements/bank-transactions', { credentials: 'same-origin' });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error();
      const data = await response.json() as { bank_transactions: Bank[] };
      setBanks(data.bank_transactions.filter(bank => Number(bank.remaining_amount) > 0));
    } catch { setMessage(label('تعذر تحميل الحركات. تحقق من صلاحية عرض التسويات والبنك.', 'Check bank and settlement viewing permissions.')); }
    finally { setBusy(false); }
  }
  async function settle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/payroll/settlements', {
        credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bank_transaction_id: fields.get('bank_transaction_id'), liability_line_id: liabilityLine,
          amount: fields.get('amount'), idempotency_key: requestKey,
        }),
      });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) {
        setMessage(response.status === 403
          ? label('تحتاج إلى صلاحية التسوية البنكية.', 'Bank settlement permission is required.')
          : label('راجع الرصيد المتبقي وحالة الحركة والفترة، وتحقق من فصل الصلاحيات.', 'Check the outstanding balance, transaction, accounting period, and separation of duties.'));
        return;
      }
      setRequestKey(crypto.randomUUID());
      setBanks(null);
      setMessage(label('سُجّلت التسوية البنكية.', 'Bank settlement recorded.'));
      onSaved();
    } catch {
      setMessage(label('تعذر الاتصال. أعد المحاولة بالقيم نفسها للتحقق من التسجيل.', 'Connection failed. Retry with the same values to check whether the payment was recorded.'));
    } finally { setBusy(false); }
  }
  return <details>
    <summary>{label('تسوية بنكية مباشرة', 'Direct bank settlement')}</summary>
    <button type="button" disabled={busy} onClick={() => void load()}>{label('تحميل الحركات المتاحة', 'Load eligible transactions')}</button>
    {banks?.length === 0 && <p>{label('لا توجد حركات متاحة', 'No eligible transactions')}</p>}
    {!!banks?.length && <form onSubmit={event => void settle(event)}>
      <fieldset disabled={busy}>
        <label>{label('حركة البنك', 'Bank transaction')} <select name="bank_transaction_id" required>
          <option value="">{label('اختر الحركة', 'Select transaction')}</option>
          {banks.map(bank => <option key={bank.id} value={bank.id}>{bank.transaction_date} · {bank.bank_reference ?? bank.id} · {bank.remaining_amount}</option>)}
        </select></label>
        <label>{label('مبلغ التسوية', 'Settlement amount')} <input name="amount" inputMode="decimal" required /></label>
        <button>{label('تسجيل التسوية', 'Record settlement')}</button>
      </fieldset>
    </form>}
    {message && <p role="status">{message}</p>}
  </details>;
}
