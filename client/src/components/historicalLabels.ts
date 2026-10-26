// C5-P4: bilingual labels, error messages and small pure helpers for the historical records UI. Presentation only; the server and the
// database decide what is allowed. No statement line catalog lives here: line codes are free text validated like the API validates them.
export type Pair = { ar: string; en: string };
export type Call = (url: string, init?: RequestInit) => Promise<Record<string, any>>;

export const STATEMENT_TYPES: Record<string, Pair> = {
  financial_position: { ar: 'قائمة المركز المالي', en: 'Statement of financial position' },
  profit_or_loss: { ar: 'قائمة الربح أو الخسارة', en: 'Profit or loss' },
  cash_flow: { ar: 'قائمة التدفقات النقدية', en: 'Cash flow statement' },
  changes_in_equity: { ar: 'قائمة التغيرات في حقوق الملكية', en: 'Changes in equity' },
  zakat_return: { ar: 'إقرار الزكاة', en: 'Zakat return' },
  vat_return: { ar: 'إقرار ضريبة القيمة المضافة', en: 'VAT return' },
};

export const SOURCE_TYPES: Record<string, Pair> = {
  bank_statement: { ar: 'كشف حساب بنكي', en: 'Bank statement' },
  customer_statement: { ar: 'كشف حساب عميل', en: 'Customer statement' },
  supplier_statement: { ar: 'كشف حساب مورّد', en: 'Supplier statement' },
  official_filing: { ar: 'إقرار أو تقديم رسمي', en: 'Official filing' },
  prior_filing: { ar: 'تقديم سابق', en: 'Prior filing' },
  original_document: { ar: 'مستند أصلي', en: 'Original document' },
  internal_ledger: { ar: 'دفتر داخلي', en: 'Internal ledger' },
  management_reconciliation: { ar: 'تسوية إدارية', en: 'Management reconciliation' },
  manual_unverified: { ar: 'إدخال يدوي غير موثّق', en: 'Manual, unverified' },
};

export const CONFIDENCE: Record<string, Pair> = {
  high: { ar: 'عالية', en: 'High' },
  medium: { ar: 'متوسطة', en: 'Medium' },
  low: { ar: 'منخفضة', en: 'Low' },
};

export const COMPLETENESS: Record<string, Pair> = {
  complete: { ar: 'مكتملة', en: 'Complete' },
  incomplete: { ar: 'غير مكتملة', en: 'Incomplete' },
};

export const RECONSTRUCTION: Record<string, Pair> = {
  not_started: { ar: 'لم تبدأ', en: 'Not started' },
  in_progress: { ar: 'قيد الإعداد', en: 'In progress' },
  completed: { ar: 'مكتملة', en: 'Completed' },
};

export const STATE: Record<string, Pair> = {
  draft: { ar: 'مسودة', en: 'Draft' },
  sealed: { ar: 'مختوم', en: 'Sealed' },
  voided: { ar: 'ملغى', en: 'Voided' },
};

export const REVIEW: Record<string, Pair> = {
  none: { ar: 'لم تتم مراجعته', en: 'Not reviewed' },
  reviewed: { ar: 'روجع داخلياً', en: 'Reviewed internally' },
  approved: { ar: 'اعتُمد داخلياً', en: 'Approved internally' },
};

export const PROVENANCE: Record<string, Pair & { note: Pair; tone: 'proof' | 'unverified' | 'internal' }> = {
  official_submitted_with_proof: {
    ar: 'تقديم رسمي — مع إثبات مرفق', en: 'Official submission — with supporting proof', tone: 'proof',
    note: { ar: 'سجل لتقديم رسمي سبق، وله مستند إثبات مرفق من مستندات الشركة.', en: 'A record of an earlier official submission, with a supporting document attached from the company documents.' },
  },
  official_declared_unverified: {
    ar: 'تقديم رسمي بإقرار المستخدم — غير موثّق', en: 'Official submission declared by the user — UNVERIFIED', tone: 'unverified',
    note: { ar: 'تنبيه: هذا إقرار من المستخدم دون أي إثبات مرفق. لم يتحقق إقفال من حدوث هذا التقديم أو من صحة أرقامه.', en: 'Warning: this is the user\'s own declaration with no proof attached. EQFAL has not verified that this submission happened or that its figures are correct.' },
  },
  internal_reconstruction: {
    ar: 'إعادة بناء داخلية', en: 'Internal reconstruction', tone: 'internal',
    note: { ar: 'أرقام أُعيد بناؤها داخلياً من المصادر المذكورة. ليست تقديماً رسمياً.', en: 'Figures rebuilt internally from the stated sources. Not an official submission.' },
  },
  internal_correction: {
    ar: 'تصحيح داخلي', en: 'Internal correction', tone: 'internal',
    note: { ar: 'نسخة داخلية جديدة مبنية على نسخة مختومة، والأصل لم يتغيّر. ليست تقديماً رسمياً.', en: 'A new internal version based on a sealed one; the original is unchanged. Not an official submission.' },
  },
};

export const REVIEW_DISCLAIMER: Pair = {
  ar: 'المراجعة والاعتماد هنا داخليان فقط. لا يعنيان قبول أي جهة حكومية ولا يثبتان صحة المحاسبة.',
  en: 'Review and approval here are internal only. They do not mean any authority accepted the record and do not prove accounting correctness.',
};

export const DIFF_STATUS: Record<string, Pair> = {
  match: { ar: 'مطابق', en: 'Matches' },
  changed: { ar: 'تغيّر', en: 'Changed' },
  only_in_basis: { ar: 'موجود في الأصل فقط', en: 'Only in original' },
  only_in_version: { ar: 'موجود في هذه النسخة فقط', en: 'Only in this version' },
};

export const MESSAGES: Record<string, Pair> = {
  FORBIDDEN: { ar: 'لا تملك صلاحية تنفيذ هذا الإجراء.', en: 'You do not have permission to do this.' },
  NOT_FOUND: { ar: 'السجل غير موجود في هذه الشركة.', en: 'The record was not found in this company.' },
  DB_UNAVAILABLE: { ar: 'قاعدة البيانات غير متاحة حالياً. حاول لاحقاً.', en: 'The database is unavailable right now. Try again later.' },
  CONFIRMATION_REQUIRED: { ar: 'يلزم تأكيد صريح قبل تنفيذ الإجراء.', en: 'Explicit confirmation is required.' },
  HISTORICAL_INPUT_INVALID: { ar: 'بعض البيانات غير صالحة. راجع الحقول وأعد المحاولة.', en: 'Some values are not valid. Check the fields and try again.' },
  HISTORICAL_PERIOD_OVERLAP: { ar: 'تتداخل هذه الفترة مع فترة تاريخية أخرى مسجلة لهذه الشركة. عدّل التواريخ.', en: 'This period overlaps another historical period of this company. Change the dates.' },
  HISTORICAL_PERIOD_DUPLICATE: { ar: 'توجد فترة بنفس التواريخ.', en: 'A period with these dates already exists.' },
  HISTORICAL_RECORD_IMMUTABLE: { ar: 'هذا السجل نهائي ولا يمكن تغييره. أنشئ تصحيحاً داخلياً بدلاً من ذلك.', en: 'This record is final and cannot be changed. Create an internal correction instead.' },
  HISTORICAL_STATUS_REASON_REQUIRED: { ar: 'يلزم سبب جديد لتغيير الحالة.', en: 'A new reason is required to change the status.' },
  HISTORICAL_VERSION_EMPTY: { ar: 'لا يمكن ختم نسخة بلا بنود. أضف بنداً واحداً على الأقل.', en: 'A version cannot be sealed without lines. Add at least one line.' },
  HISTORICAL_BASIS_INVALID: { ar: 'الأساس يجب أن يكون نسخة مختومة لنفس الفترة ونفس القائمة.', en: 'The basis must be a sealed version of the same period and statement.' },
  HISTORICAL_VERSION_INVALID: { ar: 'القيم لا تتوافق مع قواعد السجل التاريخي. راجع البيانات (مثلاً: الإثبات المرفق يتطلب مستنداً، والتقديم غير الموثّق لا يحمل مستنداً).', en: 'The values break the historical record rules (for example: proof attached needs a document, and an unverified declaration carries none).' },
  HISTORICAL_LINE_DUPLICATE: { ar: 'رمز البند أو رقمه مستخدم بالفعل في هذه النسخة.', en: 'This line code or number is already used in this version.' },
  HISTORICAL_VERSION_CONFLICT: { ar: 'تعارض مع سجل قائم. أعد تحميل الصفحة وحاول مجدداً.', en: 'This conflicts with an existing record. Reload and try again.' },
  HISTORICAL_DOCUMENT_NOT_FOUND: { ar: 'المستند غير موجود ضمن مستندات هذه الشركة.', en: 'The document was not found in this company\'s documents.' },
  HISTORICAL_DOCUMENT_PROTECTED: { ar: 'هذا المستند دليل لسجل تاريخي مختوم ولا يمكن تغييره.', en: 'This document is evidence for a sealed historical record and cannot be changed.' },
  HISTORICAL_RECONSTRUCTION_COMPLETED: { ar: 'إعادة البناء لهذه الفترة مكتملة. أعد فتحها أولاً (يتطلب صلاحية الاعتماد وسبباً).', en: 'Reconstruction for this period is completed. Reopen it first (needs approval permission and a reason).' },
  HISTORICAL_NOT_DRAFT: { ar: 'يمكن تعديل المسودات فقط.', en: 'Only a draft can be changed.' },
  HISTORICAL_NOT_SEALED: { ar: 'تمكن مراجعة النسخ المختومة فقط.', en: 'Only a sealed version can be reviewed.' },
  HISTORICAL_STATUS_TRANSITION_INVALID: { ar: 'هذا الانتقال في الحالة غير مسموح. حدّث الصفحة وتحقق من الحالة الحالية.', en: 'This status change is not allowed. Refresh and check the current status.' },
  HISTORICAL_REVIEW_TRANSITION_INVALID: { ar: 'خطوة المراجعة غير مناسبة للحالة الحالية (تمر المراجعة ثم الاعتماد بالترتيب).', en: 'This review step does not fit the current status (review comes before approval).' },
  HISTORICAL_NO_BASIS: { ar: 'لا أساس لهذه النسخة. اختر نسخة أخرى للمقارنة.', en: 'This version has no basis. Choose another version to compare with.' },
  HISTORICAL_COMPARISON_INVALID: { ar: 'تمكن مقارنة نسخ نفس الفترة ونفس القائمة فقط.', en: 'Only versions of the same period and statement can be compared.' },
};

export const GENERIC_ERROR: Pair = { ar: 'تعذر تنفيذ الطلب.', en: 'The request could not be completed.' };

/** Maps a failed call to an actionable message in the active language. */
export function errorMessage(failure: unknown, ar: boolean): string {
  const code = (failure as { code?: string } | null)?.code ?? 'UNKNOWN';
  const m = MESSAGES[code] ?? GENERIC_ERROR;
  return ar ? m.ar : m.en;
}

/** Builds a fetch wrapper that reports 401 to the shell and surfaces the server's error code. */
export function createCall(unauthorized: { current: () => void }): Call {
  return async (url, init) => {
    const response = await fetch(url, { credentials: 'same-origin', ...init });
    if (response.status === 401) { unauthorized.current(); throw new Error('unauthorized'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error('request'), { code: (body as { code?: string }).code ?? 'UNKNOWN' });
    return body as Record<string, any>;
  };
}
export const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
/** Accepts Arabic-Indic digits and the Arabic decimal separator, returns plain ASCII. */
export function normalizeAmount(raw: string): string {
  return raw.trim().replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d))).replace(/٫/g, '.').replace(/[٬,\s]/g, '');
}
/** Same rule as the API: an optional minus, up to 16 integer digits, at most 2 decimals. */
export const isValidAmount = (value: string): boolean => /^-?\d{1,16}(\.\d{1,2})?$/.test(value);
/** Same rule as the API and the database: 1-100 characters after trimming. There is no authoritative catalog to check against. */
export const isValidLineCode = (value: string): boolean => value.trim().length >= 1 && value.trim().length <= 100;
export const isValidCurrency = (value: string): boolean => /^[A-Z]{3}$/.test(value);

export const pick = (pair: Pair | undefined, ar: boolean, fallback = '—'): string => (pair ? (ar ? pair.ar : pair.en) : fallback);
export const lookup = (table: Record<string, Pair>, key: string | null | undefined, ar: boolean): string =>
  key ? pick(table[key], ar, key) : '—';
