// T7.1: read-only field suggestions from digital PDFs (embedded text only, no OCR). Nothing here touches the database, the stored document,
// accounting, VAT or approval. Every value is an untrusted suggestion the user must accept and save through the normal intake update.
// Raw PDF text never leaves this module and is never logged.
import { parseAmount } from '../accounting/cutover-file-import';
import { isValidDocumentDate, isValidDocumentTotalAmount } from './document.types';

export type SuggestionField = 'supplier_name' | 'invoice_number' | 'invoice_date' | 'total_amount';
export type FieldSuggestion = { value: string | null; state: 'found' | 'ambiguous' | 'not_found' };
export type InvoiceSuggestions = Record<SuggestionField, FieldSuggestion>;
export type ExtractionStatus = 'ok' | 'no_text' | 'encrypted' | 'invalid' | 'unsupported' | 'timeout' | 'busy';
export type ExtractionResult = { status: ExtractionStatus; fields: InvoiceSuggestions | null };

export const EXTRACTION_LIMITS = { maxPages: 5, maxTextChars: 100_000, timeoutMs: 8_000, maxConcurrent: 2 };

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeLine(line: string): string {
  return line
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/٫/g, '.').replace(/٬/g, ',')
    .replace(/[‎‏‪-‮⁦-⁩ـ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const pick = (values: string[]): FieldSuggestion => {
  const distinct = [...new Set(values)];
  if (distinct.length === 1) return { value: distinct[0]!, state: 'found' };
  return { value: null, state: distinct.length > 1 ? 'ambiguous' : 'not_found' };
};

// Labels are matched anywhere in the line so the result does not depend on RTL/LTR item order.
const INVOICE_NO_LABEL = /(invoice\s*(no\.?|number|num\.?|#)|inv\.?\s*(no\.?|#)|رقم\s*الفاتورة|فاتورة\s*رقم)/i;
const INVOICE_NO_VALUE = /^[A-Za-z0-9][A-Za-z0-9\-/_.]{0,49}$/;

function invoiceNumber(lines: string[]): FieldSuggestion {
  const found: string[] = [];
  for (const line of lines) {
    const label = INVOICE_NO_LABEL.exec(line);
    if (!label) continue;
    const rest = (line.slice(0, label.index) + ' ' + line.slice(label.index + label[0].length)).replace(/[:#：]/g, ' ');
    const tokens = rest.split(' ').filter((t) => INVOICE_NO_VALUE.test(t) && /\d/.test(t) && !DATE_TOKEN.test(t));
    if (tokens.length === 1) found.push(tokens[0]!); else if (tokens.length > 1) found.push(...tokens);
  }
  return pick(found);
}

const DATE_LABEL_STRONG = /(invoice\s*date|issue\s*date|date\s*of\s*issue|تاريخ\s*الفاتورة|تاريخ\s*الإصدار|تاريخ\s*الاصدار)/i;
const DATE_LABEL_WEAK = /(^|\s)(date|التاريخ)(\s|:|$)/i;
const DATE_EXCLUDE = /(due|supply|delivery|استحقاق|الاستحقاق|التوريد|التسليم)/i;
const DATE_TOKEN = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$|^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;

function dateValue(token: string): string | 'ambiguous' | null {
  const m = DATE_TOKEN.exec(token);
  if (!m) return null;
  let y: number, mo: number, d: number;
  if (m[1]) { y = +m[1]; mo = +m[2]!; d = +m[3]!; } else {
    const a = +m[4]!, b = +m[5]!; y = +m[6]!;
    // DD/MM/YYYY and MM/DD/YYYY cannot be told apart when both parts are 12 or less and differ: never guess.
    if (a <= 12 && b <= 12 && a !== b) return 'ambiguous';
    if (a > 12) { d = a; mo = b; } else if (b > 12) { mo = a; d = b; } else { d = a; mo = b; }
  }
  if (y < 1900 || y > 2100) return null; // also rejects Hijri years
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isValidDocumentDate(iso) ? iso : null;
}

function datesOn(lines: string[], label: RegExp): { values: string[]; ambiguous: boolean } {
  const values: string[] = []; let ambiguous = false;
  for (const line of lines) {
    if (!label.test(line) || DATE_EXCLUDE.test(line)) continue;
    for (const token of line.split(/[\s:]+/)) {
      const v = dateValue(token);
      if (v === 'ambiguous') ambiguous = true; else if (v) values.push(v);
    }
  }
  return { values, ambiguous };
}

function invoiceDate(lines: string[]): FieldSuggestion {
  for (const label of [DATE_LABEL_STRONG, DATE_LABEL_WEAK]) {
    const { values, ambiguous } = datesOn(lines, label);
    if (ambiguous) return { value: null, state: 'ambiguous' };
    if (values.length) return pick(values);
  }
  return { value: null, state: 'not_found' };
}

const TOTAL_STRONG = /(grand\s*total|amount\s*due|total\s*(amount\s*)?(due|payable)|total\s*(incl(\.|uding)?|with)\s*(vat|tax)|total\s*amount\s*incl|الإجمالي\s*شامل|الاجمالي\s*شامل|إجمالي\s*شامل|الإجمالي\s*مع\s*الضريبة|إجمالي\s*المبلغ\s*المستحق|المبلغ\s*المستحق|الإجمالي\s*النهائي|المجموع\s*الكلي)/i;
const TOTAL_WEAK = /(^|\s)(total|الإجمالي|الاجمالي|إجمالي|المجموع)(\s|:|$)/i;
const TOTAL_WEAK_EXCLUDE = /(sub\s*-?\s*total|excl|before|vat|tax|discount|قبل|ضريبة|الضريبة|خصم|الخصم|بدون)/i;
// An exact amount with at most two decimals; anything with more decimals or European separators is not matched at all.
const AMOUNT = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?![\d.,]*\d)/g;

function amountsOn(lines: string[], label: RegExp, exclude?: RegExp): string[] {
  const values: string[] = [];
  for (const line of lines) {
    if (!label.test(line) || exclude?.test(line)) continue;
    const rest = line.replace(/%\s*\d+|\d+(\.\d+)?\s*%/g, ' ');
    for (const m of rest.matchAll(AMOUNT)) {
      try {
        const cents = parseAmount(m[0]);
        if (cents === null || cents <= 0n) continue;
        const v = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
        if (isValidDocumentTotalAmount(v)) values.push(v);
      } catch { /* not an exact amount: ignore */ }
    }
  }
  return values;
}

function totalAmount(lines: string[]): FieldSuggestion {
  const strong = amountsOn(lines, TOTAL_STRONG);
  if (strong.length) return pick(strong);
  return pick(amountsOn(lines, TOTAL_WEAK, TOTAL_WEAK_EXCLUDE));
}

const SUPPLIER_LABEL = /(supplier\s*name|vendor\s*name|seller\s*name|supplier|vendor|seller|اسم\s*المورد|اسم\s*البائع|المورد|البائع)/i;
const SUPPLIER_EXCLUDE = /(vat|tax|number|no\.|registration|address|phone|email|الضريبي|ضريبي|رقم|السجل|العنوان|الهاتف|الجوال|البريد)/i;

function supplierName(lines: string[]): FieldSuggestion {
  const found: string[] = [];
  for (const line of lines) {
    const label = SUPPLIER_LABEL.exec(line);
    if (!label || SUPPLIER_EXCLUDE.test(line)) continue;
    const rest = (line.slice(0, label.index) + ' ' + line.slice(label.index + label[0].length)).replace(/[:：]/g, ' ').replace(/\s+/g, ' ').trim();
    if (rest.length >= 2 && rest.length <= 200 && /\p{L}/u.test(rest)) found.push(rest);
  }
  return pick(found);
}

/** Pure: suggests invoice fields from text lines. Missing or conflicting values are returned as null, never guessed. */
export function suggestInvoiceFields(rawLines: string[]): InvoiceSuggestions {
  const lines = rawLines.map(normalizeLine).filter(Boolean);
  return { supplier_name: supplierName(lines), invoice_number: invoiceNumber(lines), invoice_date: invoiceDate(lines), total_amount: totalAmount(lines) };
}

type TextItem = { str?: string; transform?: number[]; dir?: string };
type PdfPage = { getTextContent(): Promise<{ items: TextItem[] }>; cleanup(): void };
type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPage> };
type LoadingTask = { promise: Promise<PdfDoc>; destroy(): Promise<void> };
type PdfJs = { getDocument(src: Record<string, unknown>): LoadingTask; VerbosityLevel: { ERRORS: number } };

let pdfjs: Promise<PdfJs> | null = null;
const loadPdfjs = () => {
  // pdf.js needs Promise.withResolvers (Node 22+). Production runs Node 24; CI still runs Node 20, so add the standard shape only when missing.
  const P = Promise as unknown as { withResolvers?: () => unknown };
  P.withResolvers ??= () => { let resolve!: (v: unknown) => void, reject!: (e: unknown) => void; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  return (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJs>);
};

const isRtl = (s: string) => /[؀-ۿ]/.test(s);

/** Groups positioned text items into visual lines. Item order inside a line does not matter to the field rules. */
function toLines(items: TextItem[]): string[] {
  const rows: Array<{ y: number; parts: Array<{ x: number; s: string }> }> = [];
  for (const item of items) {
    const s = typeof item.str === 'string' ? item.str : '';
    if (!s.trim() || !item.transform) continue;
    const x = item.transform[4] ?? 0, y = item.transform[5] ?? 0;
    let row = rows.find((r) => Math.abs(r.y - y) <= 2);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, s });
  }
  return rows.sort((a, b) => b.y - a.y).map((r) => {
    const rtl = r.parts.some((p) => isRtl(p.s));
    return r.parts.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x)).map((p) => p.s).join(' ');
  });
}

let running = 0;
/** Number of extractions still holding a concurrency slot, including timed-out ones whose cancellation has not finished. */
export const activeExtractions = () => running;

/**
 * Extracts text from a digital PDF within page, size, time and concurrency limits, then derives suggestions. Never throws.
 * On timeout the caller gets 'timeout' at once, the pdf.js task is destroyed and the work stops at its next page boundary; the concurrency
 * slot is released only when that work has actually settled, so timed-out parses can never push the number of parses above the limit.
 */
export async function extractInvoiceSuggestions(data: Buffer, limits = EXTRACTION_LIMITS): Promise<ExtractionResult> {
  if (data.subarray(0, 5).toString('ascii') !== '%PDF-') return { status: 'unsupported', fields: null };
  if (running >= limits.maxConcurrent) return { status: 'busy', fields: null };
  running++;
  let task: LoadingTask | null = null;
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const release = () => { if (timer) clearTimeout(timer); running--; if (task) void task.destroy().catch(() => undefined); };
  try {
    const lib = await loadPdfjs();
    task = lib.getDocument({
      data: new Uint8Array(data), // copy: pdf.js may detach the buffer
      isEvalSupported: false, enableXfa: false, disableFontFace: true, useSystemFonts: false, disableAutoFetch: true,
      stopAtErrors: false, verbosity: lib.VerbosityLevel.ERRORS,
    });
  } catch (err) {
    release();
    return failure(err);
  }
  const deadline = Date.now() + limits.timeoutMs;
  const stop = () => cancelled || Date.now() >= deadline;
  const work = (async (): Promise<ExtractionResult> => {
    const doc = await task!.promise;
    const lines: string[] = []; let chars = 0;
    for (let n = 1; n <= Math.min(doc.numPages, limits.maxPages) && chars < limits.maxTextChars; n++) {
      if (stop()) return { status: 'timeout', fields: null };
      const page = await doc.getPage(n);
      if (stop()) return { status: 'timeout', fields: null };
      const content = await page.getTextContent();
      page.cleanup();
      for (const line of toLines(content.items)) { chars += line.length; if (chars > limits.maxTextChars) break; lines.push(line); }
    }
    if (stop()) return { status: 'timeout', fields: null };
    if (!lines.some((l) => /[\p{L}\p{N}]/u.test(l))) return { status: 'no_text', fields: null };
    return { status: 'ok', fields: suggestInvoiceFields(lines) };
  })().catch((err: unknown) => failure(err));
  // The slot is freed only after the work itself settles, never when the timeout answers first.
  void work.finally(release);
  const timeout = new Promise<ExtractionResult>((resolve) => {
    timer = setTimeout(() => { cancelled = true; if (task) void task.destroy().catch(() => undefined); resolve({ status: 'timeout', fields: null }); }, limits.timeoutMs);
  });
  return Promise.race([work, timeout]);
}

function failure(err: unknown): ExtractionResult {
  return { status: (err as { name?: string } | null)?.name === 'PasswordException' ? 'encrypted' : 'invalid', fields: null };
}
