import { formatMoney } from '../money-format';
import { formatDisplayDateLtr } from '../date-format';

// Unicode isolates keep each part of the mixed-direction option text in its own run, so an Arabic or English
// description can never reorder the date or move the minus sign of the amount. Characters are invisible; text is unchanged.
const LRI = '⁦', FSI = '⁨', PDI = '⁩';

// The date is shown as a calendar date (the API may send a full timestamp); with a language it uses the app's display format.
export function transactionOptionLabel(t: { transaction_date: string; description: string | null; bank_reference: string | null; id: string; amount: string }, language?: string): string {
  const text = t.description || t.bank_reference || t.id;
  const date = language ? formatDisplayDateLtr(t.transaction_date, language) : t.transaction_date.slice(0, 10);
  return `${LRI}${date}${PDI} · ${FSI}${text}${PDI} · ${LRI}${formatMoney(t.amount)}${PDI}`;
}
