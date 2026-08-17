const financialLocaleFor = (language: string) => language.startsWith('ar')
  ? 'ar-SA-u-nu-latn'
  : 'en-GB';

export function formatFinancialAmount(
  value: string | number | null | undefined,
  currencyCode: string | null | undefined,
  language: string,
) {
  if (value === null || value === undefined || value === '') return '—';
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return String(value);
  const formatted = new Intl.NumberFormat(financialLocaleFor(language), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(amount).replace(/[\u061c\u200e\u200f]/g, '');
  return currencyCode ? `${formatted} ${currencyCode}` : formatted;
}

export function financialStatusColor(status: string) {
  switch (status) {
    case 'reconciled':
    case 'paid':
    case 'closed':
    case 'confirmed':
    case 'valid':
      return 'green';
    case 'matched':
    case 'partially_paid':
    case 'partially_settled':
      return 'blue';
    case 'mapping_required':
    case 'possible_duplicate':
      return 'orange';
    case 'duplicate':
    case 'unpaid':
      return 'yellow';
    case 'invalid':
    case 'failed':
    case 'rejected':
      return 'red';
    default:
      return 'gray';
  }
}
