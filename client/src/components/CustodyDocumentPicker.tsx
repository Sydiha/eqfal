import { useEffect, useState } from 'react';
import { Alert, Button, Loader, Text, TextInput } from '@mantine/core';
import { formatMoney } from '../money-format';
import { formatDisplayDateLtr } from '../date-format';

export type EligibleDocument = { id: string; original_filename: string; reference_number: string | null; counterparty_name: string | null; document_date: string | null; total_amount: string };
type Props = { custodyId: string; currency?: string; language: string; refreshKey: number; selected: EligibleDocument | null; onSelect: (doc: EligibleDocument | null) => void; onUnauthorized: () => void };

const strings = {
  en: { label: 'Approved document', search: 'Search by reference, supplier, file name or amount', loading: 'Searching documents…', empty: 'No eligible documents found. Only approved expense documents that are not yet linked to a custody, settlement or obligation, and that fit within the remaining custody balance, are listed.', error: 'Unable to search documents', change: 'Change', noRef: 'No reference', noSupplier: 'No supplier', noDate: 'No date' },
  ar: { label: 'المستند المعتمد', search: 'ابحث بالمرجع أو المورد أو اسم الملف أو المبلغ', loading: 'جارٍ البحث عن المستندات…', empty: 'لا توجد مستندات مؤهلة. تُعرض فقط مستندات المصروفات المعتمدة غير المرتبطة بعهدة أو تسوية أو التزام، والتي لا يتجاوز مبلغها المتبقي من العهدة.', error: 'تعذر البحث عن المستندات', change: 'تغيير', noRef: 'بلا مرجع', noSupplier: 'بلا مورد', noDate: 'بلا تاريخ' },
};

export function CustodyDocumentPicker({ custodyId, currency, language, refreshKey, selected, onSelect, onUnauthorized }: Props) {
  const s = language === 'ar' ? strings.ar : strings.en;
  const [query, setQuery] = useState('');
  const [docs, setDocs] = useState<EligibleDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (selected) return;
    let cancelled = false;
    setLoading(true); setError('');
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/custodies/${custodyId}/eligible-documents?q=${encodeURIComponent(query.trim())}`);
        if (r.status === 401) { onUnauthorized(); return; }
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof b.error === 'string' ? b.error : s.error);
        if (!cancelled) setDocs((b as { documents?: EligibleDocument[] }).documents ?? []);
      } catch (e) {
        if (!cancelled) { setDocs([]); setError(e instanceof Error ? e.message : s.error); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [custodyId, query, refreshKey, selected, onUnauthorized, s.error]);

  const money = (v: string) => `${formatMoney(v)}${currency ? ` ${currency}` : ''}`;
  const describe = (d: EligibleDocument) => (
    <>
      <strong><bdi dir="auto">{d.reference_number || d.original_filename || s.noRef}</bdi></strong>
      <span className="custody-doc-picker__meta"><bdi dir="auto">{d.counterparty_name || s.noSupplier}</bdi> · <span dir="ltr">{d.document_date ? formatDisplayDateLtr(d.document_date, language) : s.noDate}</span></span>
      <span className="fin-amount custody-doc-picker__amount" dir="ltr">{money(d.total_amount)}</span>
    </>
  );

  if (selected) {
    return (
      <div className="custody-doc-picker" role="group" aria-label={s.label}>
        <Text size="sm" fw={500} mb={4}>{s.label}</Text>
        <div className="custody-doc-picker__selected">
          <div className="custody-doc-picker__item">{describe(selected)}</div>
          <Button size="xs" variant="default" onClick={() => onSelect(null)}>{s.change}</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="custody-doc-picker">
      <TextInput label={s.label} placeholder={s.search} value={query} onChange={e => setQuery(e.currentTarget.value)} maxLength={100} rightSection={loading ? <Loader size="xs" /> : undefined} autoComplete="off" />
      <div className="custody-doc-picker__list" role="group" aria-label={s.label} aria-busy={loading}>
        {error && <Alert color="red" role="alert">{error}</Alert>}
        {loading && <Text size="sm" c="dimmed" role="status">{s.loading}</Text>}
        {!loading && !error && docs.length === 0 && <Text size="sm" c="dimmed" role="status">{s.empty}</Text>}
        {!error && docs.map(d => (
          <button type="button" key={d.id} className="custody-doc-picker__item custody-doc-picker__option" onClick={() => onSelect(d)}>{describe(d)}</button>
        ))}
      </div>
    </div>
  );
}
