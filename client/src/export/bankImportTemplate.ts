import { buildXlsx, type ExportLayout, type ExportRows } from './xlsx-builder';
import { downloadBlob, XLSX_MIME } from './downloadExport';

export type BankTemplateLang = 'ar' | 'en';

// Headings use names the existing bank importer already recognises (see headerKind in bank.router.ts),
// so the file auto-maps in debit/credit mode with no manual column selection.
export const BANK_TEMPLATE_HEADERS = ['Date / التاريخ', 'Description / البيان', 'Debit / مدين', 'Credit / دائن', 'Balance / الرصيد', 'Reference / المرجع'];

const TEXT: Record<BankTemplateLang, { sheet: string; title: string; how: string; signs: string; example: string }> = {
  ar: {
    sheet: 'كشف البنك',
    title: 'قالب استيراد كشف حساب البنك — إقفال',
    how: 'أدخل حركاتك في الصفوف الفارغة تحت صف العناوين مباشرة (صف واحد لكل حركة). التاريخ بصيغة YYYY-MM-DD. لا تغيّر العناوين ولا تستخدم معادلات.',
    signs: 'مدين = مبلغ خارج من الحساب البنكي، دائن = مبلغ داخل إليه. املأ أحدهما فقط في كل صف.',
    example: 'مثال توضيحي فقط (لا يُستورد):',
  },
  en: {
    sheet: 'Bank Statement',
    title: 'Bank statement import template — EQFAL',
    how: 'Enter your transactions in the empty rows directly below the heading row, one row per transaction. Dates use YYYY-MM-DD. Do not rename the headings or use formulas.',
    signs: 'Debit = money leaving the bank account, Credit = money coming in. Fill only one of them per row.',
    example: 'Illustrative example only (not imported):',
  },
};

/** Instructions and the labelled example sit above the heading row; the data area below it stays empty. */
export function bankImportTemplate(lang: BankTemplateLang): { sheetName: string; rows: ExportRows; layout: ExportLayout; rtl: boolean } {
  const t = TEXT[lang];
  const rows: ExportRows = [
    [t.title], [t.how], [t.signs], [t.example],
    ['2026-01-15', 'Customer payment', null, { num: '1500.00' }, { num: '11500.00' }, 'EX-001'],
    [],
    BANK_TEMPLATE_HEADERS,
  ];
  return { sheetName: t.sheet, rows, layout: { metaEnd: 5, headerRows: [6], totalRows: [], sectionRows: [] }, rtl: lang === 'ar' };
}

export function buildBankImportTemplate(lang: BankTemplateLang): Uint8Array {
  const { sheetName, rows, layout, rtl } = bankImportTemplate(lang);
  return buildXlsx(sheetName, rows, rtl, layout);
}

export const downloadBankImportTemplate = (lang: BankTemplateLang) =>
  downloadBlob(new Blob([buildBankImportTemplate(lang) as BlobPart], { type: XLSX_MIME }), `eqfal-bank-statement-template-${lang}.xlsx`);
