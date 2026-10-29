import { formatMoney } from '../money-format';

// Unicode isolates keep each part of the mixed-direction option text in its own run, so an Arabic or English
// description can never reorder the date or move the minus sign of the amount. Characters are invisible; text is unchanged.
const LRI = '⁦', FSI = '⁨', PDI = '⁩';

export function transactionOptionLabel(t: { transaction_date: string; description: string | null; bank_reference: string | null; id: string; amount: string }): string {
  const text = t.description || t.bank_reference || t.id;
  return `${LRI}${t.transaction_date}${PDI} · ${FSI}${text}${PDI} · ${LRI}${formatMoney(t.amount)}${PDI}`;
}
