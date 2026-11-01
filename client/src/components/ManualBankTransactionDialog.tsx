import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { DateTextInput, isValidIsoDate } from './DateInput';
import { ApiError, parseApiError, screenErrorMessage, toApiError } from '../api/apiError';

type Direction = 'incoming' | 'outgoing';
type Account = { id: string; display_name: string; is_active: boolean };
type Doc = { id: string; original_filename: string; reference_number: string | null };
type Candidate = { id: string; source_kind: string };

/** Mirrors the server rules (manual-bank-transaction.ts + migration 106). The server stays authoritative. */
export const MANUAL_CATEGORIES: ReadonlyArray<{ value: string; only?: Direction; deferred?: boolean }> = [
  { value: 'customer_receipt', only: 'incoming' }, { value: 'supplier_payment', only: 'outgoing' }, { value: 'government_payment', only: 'outgoing' }, { value: 'other' },
  // Disabled until a supported accounting-resolution workflow exists (they would stay unresolved and block closing).
  { value: 'cash_deposit', deferred: true }, { value: 'cash_withdrawal', deferred: true }, { value: 'incoming_transfer', deferred: true }, { value: 'outgoing_transfer', deferred: true },
  { value: 'inter_account_transfer', deferred: true }, { value: 'bank_fees', deferred: true }, { value: 'refund', deferred: true },
];
/** The shared Dialog backdrop sits at z-index 1000, above Mantine's default popover layer (300), which hid every dropdown behind it. */
export const DIALOG_DROPDOWN_PROPS = { withinPortal: true, zIndex: 1100 } as const;
export const NON_SETTLEABLE: string[] = [];

const strings = {
  ar: {
    title: 'إضافة حركة بنكية', account: 'الحساب البنكي', date: 'تاريخ الحركة', direction: 'الاتجاه', incoming: 'وارد', outgoing: 'صادر',
    category: 'التصنيف', amount: 'المبلغ (قيمة موجبة)', description: 'البيان', reference: 'المرجع (اختياري)', counterparty: 'الطرف المقابل (اختياري)',
    document: 'المستند الداعم (اختياري)', manualNote: 'حركة يدوية: سجل داخلي أدخله مستخدم وليست من كشف البنك، ولا تُنشئ قيدًا محاسبيًا.',
    save: 'حفظ الحركة', cancel: 'إلغاء', confirmDuplicate: 'إضافة رغم التشابه', deferredNote: 'غير متاح بعد', noOptions: 'لا توجد خيارات',
    duplicateTitle: 'توجد حركة مشابهة (نفس الحساب والتاريخ والمبلغ). راجعها قبل المتابعة.',
    cats: { cash_deposit: 'إيداع نقدي', cash_withdrawal: 'سحب نقدي', incoming_transfer: 'تحويل وارد', outgoing_transfer: 'تحويل صادر', inter_account_transfer: 'تحويل بين حسابات الشركة', customer_receipt: 'تحصيل من عميل', supplier_payment: 'سداد لمورد', government_payment: 'دفعة حكومية', bank_fees: 'رسوم بنكية', refund: 'استرداد', other: 'أخرى' } as Record<string, string>,
    errors: { DIRECTION_CATEGORY_MISMATCH: 'الاتجاه لا يناسب التصنيف المختار.', PAIRED_TRANSFER_DEFERRED: 'التحويل بين حسابات الشركة غير مدعوم بعد.', MANUAL_CATEGORY_UNSUPPORTED: 'هذا التصنيف غير متاح بعد لعدم وجود مسار محاسبي معتمد لحسمه.', MANUAL_BANK_DUPLICATE: 'توجد حركة يدوية بنفس المرجع.', ACCOUNTING_PERIOD_CLOSED: 'الفترة المحاسبية مقفلة.', FISCAL_YEAR_CLOSED: 'السنة المالية مقفلة.', BANK_ACCOUNT_INACTIVE: 'الحساب البنكي غير نشط.', MANUAL_BANK_INVALID: 'تحقق من الحقول المدخلة.' } as Record<string, string>,
    required: 'هذا الحقل مطلوب', badAmount: 'أدخل مبلغًا موجبًا بخانتين عشريتين كحد أقصى', badDate: 'أدخل تاريخًا صحيحًا',
  },
  en: {
    title: 'Add bank transaction', account: 'Bank account', date: 'Transaction date', direction: 'Direction', incoming: 'Incoming', outgoing: 'Outgoing',
    category: 'Category', amount: 'Amount (positive value)', description: 'Description', reference: 'Reference (optional)', counterparty: 'Counterparty (optional)',
    document: 'Supporting document (optional)', manualNote: 'Manual entry: an internal record entered by a user. It is not from a bank statement and creates no journal entry.',
    save: 'Save transaction', cancel: 'Cancel', confirmDuplicate: 'Add anyway', deferredNote: 'not available yet', noOptions: 'No options',
    duplicateTitle: 'A similar transaction exists (same account, date and amount). Review it before continuing.',
    cats: { cash_deposit: 'Cash deposit', cash_withdrawal: 'Cash withdrawal', incoming_transfer: 'Incoming transfer', outgoing_transfer: 'Outgoing transfer', inter_account_transfer: 'Inter-account transfer', customer_receipt: 'Customer receipt', supplier_payment: 'Supplier payment', government_payment: 'Government payment', bank_fees: 'Bank fees', refund: 'Refund', other: 'Other' } as Record<string, string>,
    errors: { DIRECTION_CATEGORY_MISMATCH: 'The direction does not fit the selected category.', PAIRED_TRANSFER_DEFERRED: 'Transfers between company accounts are not supported yet.', MANUAL_CATEGORY_UNSUPPORTED: 'This category is not available yet: no supported accounting workflow can resolve it.', MANUAL_BANK_DUPLICATE: 'A manual transaction with the same reference already exists.', ACCOUNTING_PERIOD_CLOSED: 'The accounting period is closed.', FISCAL_YEAR_CLOSED: 'The fiscal year is closed.', BANK_ACCOUNT_INACTIVE: 'The bank account is inactive.', MANUAL_BANK_INVALID: 'Check the entered fields.' } as Record<string, string>,
    required: 'This field is required', badAmount: 'Enter a positive amount with at most two decimals', badDate: 'Enter a valid date',
  },
};

export function ManualBankTransactionDialog({ onClose, onCreated, onUnauthorized }: { onClose: () => void; onCreated: () => void; onUnauthorized: () => void }) {
  const { t, i18n } = useTranslation();
  const s = i18n.language === 'ar' ? strings.ar : strings.en;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [direction, setDirection] = useState<Direction>('incoming');
  const [category, setCategory] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [duplicates, setDuplicates] = useState<Candidate[] | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/bank-accounts').then(r => r.ok ? r.json() : null).then(d => { if (live && d?.accounts) { const active = (d.accounts as Account[]).filter(a => a.is_active); setAccounts(active); if (active.length === 1) setAccountId(active[0]!.id); } }).catch(() => undefined);
    fetch('/api/documents').then(r => r.ok ? r.json() : null).then(d => { if (live && Array.isArray(d?.documents)) setDocs(d.documents as Doc[]); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  const selected = MANUAL_CATEGORIES.find(c => c.value === category);
  const amountOk = /^\d{1,13}(\.\d{1,2})?$/.test(amount.trim()) && Number(amount) > 0;
  const dateOk = isValidIsoDate(date);
  const valid = Boolean(accountId && dateOk && category && !selected?.deferred && amountOk && description.trim());
  const otherNote = category === 'other';
  const docOptions = useMemo(() => docs.slice(0, 200).map(d => ({ value: d.id, label: d.reference_number ? `${d.reference_number} · ${d.original_filename}` : d.original_filename })), [docs]);

  const pickDirection = (value: string) => {
    const next = value as Direction; setDirection(next);
    const only = selected?.only; if (only && only !== next) setCategory(null);
  };
  const pickCategory = (value: string | null) => {
    setCategory(value); const only = MANUAL_CATEGORIES.find(c => c.value === value)?.only; if (only) setDirection(only);
  };

  const submit = async (confirmDuplicate: boolean) => {
    setTouched(true);
    if (!valid) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/bank-transactions/manual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank_account_id: accountId, transaction_date: date, direction, category, amount: amount.trim(), description: description.trim(), reference: reference.trim() || undefined, counterparty: counterparty.trim() || undefined, supporting_document_id: documentId || undefined, confirm_duplicate: confirmDuplicate || undefined }),
      }).catch(e => { throw toApiError(e); });
      if (response.status === 401) { onUnauthorized(); throw new ApiError({ status: 401 }); }
      if (response.status === 409) {
        const body = await response.clone().json().catch(() => ({}));
        if (body.code === 'MANUAL_BANK_POSSIBLE_DUPLICATE') { setDuplicates((body.candidates as Candidate[]) ?? []); setBusy(false); return; }
        if (s.errors[body.code]) { setError(s.errors[body.code]!); setBusy(false); return; }
      }
      if (!response.ok) {
        const body = await response.clone().json().catch(() => ({}));
        if (body?.code && s.errors[body.code]) { setError(s.errors[body.code]!); setBusy(false); return; }
        throw await parseApiError(response);
      }
      onCreated(); onClose();
    } catch (e) { setError(screenErrorMessage(e, t, s.errors.MANUAL_BANK_INVALID!)); setBusy(false); }
  };

  const showErr = (bad: boolean, message: string) => touched && bad ? message : undefined;
  return <Dialog title={s.title} busy={busy} onClose={onClose} size="wide" className="manual-bank-dialog">
    <form onSubmit={e => { e.preventDefault(); void submit(duplicates !== null); }}>
      <Stack gap="sm">
        <Alert color="gray" role="note">{s.manualNote}</Alert>
        {error && <Alert color="red" role="alert">{error}</Alert>}
        {duplicates && <Alert color="orange" role="alert" title={s.duplicateTitle}>{duplicates.map(c => <Text size="sm" key={c.id} dir="ltr">{c.id.slice(0, 8)} · {c.source_kind}</Text>)}</Alert>}
        <div className="manual-bank-grid">
          <Select label={s.account} data={accounts.map(a => ({ value: a.id, label: a.display_name }))} value={accountId} onChange={setAccountId} comboboxProps={DIALOG_DROPDOWN_PROPS} nothingFoundMessage={s.noOptions} required error={showErr(!accountId, s.required)}/>
          <DateTextInput label={s.date} value={date} onChange={setDate} required error={showErr(!dateOk, s.badDate)}/>
          <Input.Wrapper label={s.direction} className="manual-bank-direction">
            <SegmentedControl fullWidth aria-label={s.direction} value={direction} onChange={pickDirection} data={[{ value: 'incoming', label: s.incoming }, { value: 'outgoing', label: s.outgoing }]}/></Input.Wrapper>
          <Select label={s.category} value={category} onChange={pickCategory} comboboxProps={DIALOG_DROPDOWN_PROPS} required error={showErr(!category, s.required)}
            data={MANUAL_CATEGORIES.map(c => ({ value: c.value, disabled: Boolean(c.deferred), label: c.deferred ? `${s.cats[c.value]} (${s.deferredNote})` : (s.cats[c.value] ?? c.value) }))}/>
          <TextInput label={s.amount} value={amount} onChange={e => setAmount(e.currentTarget.value)} inputMode="decimal" dir="ltr" className="manual-bank-ltr" required error={showErr(!amountOk, s.badAmount)}/>
          <TextInput label={s.reference} value={reference} onChange={e => setReference(e.currentTarget.value)} maxLength={100} dir="ltr" className="manual-bank-ltr"/>
        </div>
        <TextInput label={s.description} value={description} onChange={e => setDescription(e.currentTarget.value)} maxLength={500} required error={showErr(!description.trim(), s.required)}/>
        <div className="manual-bank-grid">
          <TextInput label={s.counterparty} value={counterparty} onChange={e => setCounterparty(e.currentTarget.value)} maxLength={200}/>
          <Select label={s.document} data={docOptions} value={documentId} onChange={setDocumentId} comboboxProps={DIALOG_DROPDOWN_PROPS} nothingFoundMessage={s.noOptions} searchable clearable/>
        </div>
        {otherNote && <Alert color="yellow" role="note">{i18n.language === 'ar' ? 'تبقى غير محسومة في الإقفال حتى تُربط بمسار قائم (التزام، عهدة، حركة شريك، دفعة شخصية). لا يوجد قيد تلقائي.' : 'Stays unresolved for closing until linked through an existing workflow (obligation, custody, partner transaction, personal payment). No automatic journal.'}</Alert>}
        <div className="modal-actions">
          <Button variant="default" onClick={onClose} disabled={busy}>{s.cancel}</Button>
          <Button type="submit" loading={busy}>{duplicates ? s.confirmDuplicate : s.save}</Button>
        </div>
      </Stack>
    </form>
  </Dialog>;
}
