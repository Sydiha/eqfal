import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Option = {
  entitlement_id: string; display_name: string; period_start: string; period_end: string; maximum: string;
};
export type BonusAllocation = { entitlement_id: string; amount: string };

export function PayrollBonusSelection({ draftId, disabled, onUnauthorized, onSelect }:
  { draftId: string; disabled: boolean; onUnauthorized: () => void; onSelect: (allocations: BonusAllocation[]) => void }) {
  const { i18n } = useTranslation();
  const ar = i18n.language.startsWith('ar');
  const [options, setOptions] = useState<Option[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/payroll/drafts/${draftId}/bonus-options`, {
          credentials: 'same-origin', signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) { onUnauthorized(); return; }
        if (!response.ok) throw new Error();
        const data = await response.json() as { options: Option[] };
        if (!controller.signal.aborted) setOptions(data.options);
      } catch { if (!controller.signal.aborted) setError(true); }
    })();
    return () => controller.abort();
  }, [draftId, onUnauthorized]);
  return <fieldset disabled={disabled} dir={ar ? 'rtl' : 'ltr'}>
    <legend>{ar ? 'تسوية مكافآت معترف بها' : 'Settle recognized bonuses'}</legend>
    {error ? <p role="alert">{ar ? 'تعذر تحميل الاستحقاقات. أغلق النافذة وأعد المحاولة.' : 'Could not load entitlements. Close and reopen this dialog.'}</p>
      : options === null ? <p role="status">{ar ? 'جارٍ تحميل الاستحقاقات' : 'Loading entitlements'}</p>
        : options.length === 0 ? <p>{ar ? 'لا توجد مكافآت مؤهلة للتسوية' : 'No eligible bonus entitlements'}</p>
          : <p>{ar ? 'أدخل الجزء المشمول بالفعل في حقل المكافأة للموظف.' : 'Enter the portion already included in the employee’s payroll bonus field.'}</p>}
    {options?.map(option => <label key={option.entitlement_id}>
      {option.display_name} <bdi>{option.period_start} – {option.period_end} · {option.maximum} SAR</bdi>
      <input type="number" inputMode="decimal" min="0" max={option.maximum} step="0.01" dir="ltr"
        value={amounts[option.entitlement_id] ?? ''} onChange={event => {
          const value = event.target.value;
          const next = { ...amounts, [option.entitlement_id]: value };
          setAmounts(next);
          onSelect(Object.entries(next).filter(([, amount]) => amount !== '' && Number(amount) !== 0)
            .map(([entitlement_id, amount]) => ({ entitlement_id, amount })));
        }} />
    </label>)}
  </fieldset>;
}
