import { describe, expect, it } from 'vitest';
import { EXTRACTION_LIMITS, extractInvoiceSuggestions, suggestInvoiceFields } from '../src/modules/documents/document-extraction';
import { buildTextPdf } from './helpers/pdf-fixture';

const englishInvoice = [[
  { text: 'ACME Supplies LLC', x: 50, y: 800 },
  { text: 'Supplier: ACME Supplies LLC', x: 50, y: 780 },
  { text: 'Supplier VAT No: 300000000000003', x: 50, y: 770 },
  { text: 'Invoice No: INV-2024-0042', x: 50, y: 760 },
  { text: 'Invoice Date: 2024-03-15', x: 50, y: 740 },
  { text: 'Due Date: 2024-04-15', x: 50, y: 730 },
  { text: 'Subtotal 1,000.00', x: 50, y: 700 },
  { text: 'VAT 15% 150.05', x: 50, y: 680 },
  { text: 'Total incl. VAT 1,150.05 SAR', x: 50, y: 660 },
]];
// Arabic label on the right and its value on the left, as separate text runs on one line (typical RTL invoice layout).
const arabicInvoice = [[
  { text: 'المورد: شركة الأمل للتجارة', x: 300, y: 800 },
  { text: 'رقم الفاتورة:', x: 400, y: 780 }, { text: 'A-778', x: 100, y: 780 },
  { text: 'تاريخ الفاتورة:', x: 400, y: 760 }, { text: '٢٠٢٤/٠٣/٢٥', x: 100, y: 760 },
  { text: 'الإجمالي قبل الضريبة', x: 400, y: 750 }, { text: '٢٠٠٫٤٤', x: 100, y: 750 },
  { text: 'الإجمالي شامل الضريبة', x: 400, y: 740 }, { text: '٢٣٠٫٥١', x: 100, y: 740 },
]];

describe('T7.1 digital PDF extraction', () => {
  it('suggests all four fields from an English digital PDF with exact decimals', async () => {
    const result = await extractInvoiceSuggestions(buildTextPdf(englishInvoice));
    expect(result).toEqual({ status: 'ok', fields: {
      supplier_name: { value: 'ACME Supplies LLC', state: 'found' },
      invoice_number: { value: 'INV-2024-0042', state: 'found' },
      invoice_date: { value: '2024-03-15', state: 'found' },
      total_amount: { value: '1150.05', state: 'found' },
    } });
  });

  it('suggests all four fields from an Arabic digital PDF with Arabic-Indic digits', async () => {
    const result = await extractInvoiceSuggestions(buildTextPdf(arabicInvoice));
    expect(result.status).toBe('ok');
    expect(result.fields).toEqual({
      supplier_name: { value: 'شركة الأمل للتجارة', state: 'found' },
      invoice_number: { value: 'A-778', state: 'found' },
      invoice_date: { value: '2024-03-25', state: 'found' },
      total_amount: { value: '230.51', state: 'found' },
    });
  });

  it('reports a PDF without embedded text (scanned) as no_text so intake stays manual', async () => {
    expect(await extractInvoiceSuggestions(buildTextPdf([[]]))).toEqual({ status: 'no_text', fields: null });
  });

  it('handles encrypted, malformed and non-PDF input without throwing', async () => {
    expect((await extractInvoiceSuggestions(buildTextPdf([[{ text: 'Total 5.00', x: 1, y: 1 }]], { encrypted: true }))).status).toBe('encrypted');
    expect(await extractInvoiceSuggestions(Buffer.from('%PDF-1.7 garbage'))).toEqual({ status: 'invalid', fields: null });
    expect(await extractInvoiceSuggestions(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toEqual({ status: 'unsupported', fields: null });
  });

  it('reads only the first pages and enforces concurrency and time limits', async () => {
    const pages = Array.from({ length: 6 }, (_, i) => [{ text: i === 5 ? 'Invoice No: LATE-6' : `Page ${i + 1}`, x: 50, y: 700 }]);
    expect((await extractInvoiceSuggestions(buildTextPdf(pages))).fields?.invoice_number).toEqual({ value: null, state: 'not_found' });
    expect(await extractInvoiceSuggestions(buildTextPdf(englishInvoice), { ...EXTRACTION_LIMITS, maxConcurrent: 0 })).toEqual({ status: 'busy', fields: null });
    expect(await extractInvoiceSuggestions(buildTextPdf(englishInvoice), { ...EXTRACTION_LIMITS, timeoutMs: 0 })).toEqual({ status: 'timeout', fields: null });
  });
});

describe('T7.1 field rules never guess', () => {
  it('returns not_found for missing fields', () => {
    expect(suggestInvoiceFields(['Hello world', 'Thank you'])).toEqual({
      supplier_name: { value: null, state: 'not_found' }, invoice_number: { value: null, state: 'not_found' },
      invoice_date: { value: null, state: 'not_found' }, total_amount: { value: null, state: 'not_found' },
    });
  });

  it('returns ambiguous for conflicting totals, numbers and day/month order', () => {
    const f = suggestInvoiceFields(['Grand Total 100.00', 'Amount Due 90.00', 'Invoice No: A-1', 'Invoice Number: B-2', 'Invoice Date: 05/03/2024']);
    expect(f.total_amount).toEqual({ value: null, state: 'ambiguous' });
    expect(f.invoice_number).toEqual({ value: null, state: 'ambiguous' });
    expect(f.invoice_date).toEqual({ value: null, state: 'ambiguous' });
  });

  it('keeps exact amounts and rejects anything with more than two decimals', () => {
    expect(suggestInvoiceFields(['Grand Total 1,234,567.89']).total_amount.value).toBe('1234567.89');
    expect(suggestInvoiceFields(['Grand Total 999999999999.99']).total_amount.value).toBe('999999999999.99');
    expect(suggestInvoiceFields(['Grand Total 0.10']).total_amount.value).toBe('0.10');
    expect(suggestInvoiceFields(['Grand Total 12.345']).total_amount).toEqual({ value: null, state: 'not_found' });
    expect(suggestInvoiceFields(['Grand Total 0.00']).total_amount).toEqual({ value: null, state: 'not_found' });
  });

  it('ignores subtotal and VAT lines for a plain total and rejects Hijri or impossible dates', () => {
    expect(suggestInvoiceFields(['Subtotal 100.00', 'VAT 15.00', 'Total 115.00']).total_amount.value).toBe('115.00');
    expect(suggestInvoiceFields(['Subtotal 100.00', 'VAT total 15.00']).total_amount.state).toBe('not_found');
    expect(suggestInvoiceFields(['Invoice Date: 1445-09-01']).invoice_date.state).toBe('not_found');
    expect(suggestInvoiceFields(['Invoice Date: 2024-02-30']).invoice_date.state).toBe('not_found');
    expect(suggestInvoiceFields(['Invoice Date: 25/03/2024']).invoice_date.value).toBe('2024-03-25');
  });
});
