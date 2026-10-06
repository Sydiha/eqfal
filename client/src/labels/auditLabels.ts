/** Human-readable audit action / entity / field / value labels (UI only; raw values stay the filter and API values). */
import { capabilityLabel, Lang } from './capabilityLabels';
type Pair = readonly [en: string, ar: string];
const pick = (pair: Pair, lang: Lang) => (lang === 'ar' ? pair[1] : pair[0]);
const humanize = (raw: string) => { const text = raw.replace(/[._]+/g, ' ').trim(); return text ? text[0].toUpperCase() + text.slice(1) : raw; };

const ACTIONS: Record<string, Pair> = {
  'access.membership.create': ['Add member', 'إضافة عضو'], 'access.membership.role.assign': ['Assign member role', 'تعيين دور عضو'],
  'access.role.create': ['Create role', 'إنشاء دور'], 'access.user.create': ['Create user', 'إنشاء مستخدم'],
  'asset.depreciation.post': ['Post depreciation', 'ترحيل الإهلاك'], 'asset.depreciation.generate': ['Generate depreciation', 'توليد الإهلاك'],
  'company.create': ['Create company', 'إنشاء شركة'], 'company.update': ['Update company', 'تعديل شركة'],
  'document.intake_update': ['Update document intake', 'تحديث بيانات استلام المستند'], 'document.submit_review': ['Submit document for review', 'إرسال المستند للمراجعة'],
  'document.upload': ['Upload document', 'رفع مستند'], 'document_settlement.create': ['Create document settlement', 'إنشاء تسوية مستند'],
  'document_settlement.delete': ['Delete document settlement', 'حذف تسوية مستند'], 'journal.post': ['Post journal entry', 'ترحيل قيد يومية'],
  'journal.create': ['Create journal entry', 'إنشاء قيد يومية'], 'journal.update': ['Update journal entry', 'تعديل قيد يومية'],
  'journal.lines.replace': ['Replace journal lines', 'استبدال بنود القيد'],
  'account.classification.update': ['Update account classification', 'تعديل تصنيف حساب'], 'account.create': ['Create account', 'إنشاء حساب'], 'account.update': ['Update account', 'تعديل حساب'],
  'annual_package.created': ['Annual package created', 'إنشاء حزمة الإقفال السنوي'], 'annual_package.finalized': ['Annual package finalized', 'اعتماد حزمة الإقفال السنوي نهائياً'],
  'annual_package.handed_off': ['Annual package handed off', 'تسليم حزمة الإقفال السنوي'], 'annual_package.snapshot_created': ['Annual package snapshot created', 'إنشاء لقطة لحزمة الإقفال السنوي'],
  'asset.approve': ['Approve asset', 'اعتماد أصل'], 'asset.cancel': ['Cancel asset', 'إلغاء أصل'], 'asset.dispose': ['Dispose of asset', 'استبعاد أصل'],
  'asset.update': ['Update asset', 'تعديل أصل'], 'asset.category.update': ['Update asset category', 'تعديل فئة أصول'],
  'asset.create.from_document': ['Create asset from document', 'إنشاء أصل من مستند'], 'asset.create.manual': ['Create asset manually', 'إنشاء أصل يدوياً'],
  'asset.estimate_change.approve': ['Approve estimate change', 'اعتماد تغيير تقدير'], 'asset.estimate_change.create': ['Create estimate change', 'إنشاء تغيير تقدير'],
  'asset.estimate_change.review': ['Review estimate change', 'مراجعة تغيير تقدير'], 'asset.estimate_change.schedule_rebuild': ['Rebuild schedule after estimate change', 'إعادة بناء الجدول بعد تغيير التقدير'],
  'asset.estimate_change.update': ['Update estimate change', 'تعديل تغيير تقدير'],
  'asset.policy.approve': ['Approve depreciation policy', 'اعتماد سياسة إهلاك'], 'asset.policy.create': ['Create depreciation policy', 'إنشاء سياسة إهلاك'],
  'asset.policy.review': ['Review depreciation policy', 'مراجعة سياسة إهلاك'], 'asset.policy.supersede': ['Supersede depreciation policy', 'استبدال سياسة إهلاك'],
  'asset.policy.update': ['Update depreciation policy', 'تعديل سياسة إهلاك'],
  'bank_account.create': ['Create bank account', 'إنشاء حساب بنكي'], 'bank_import.confirm': ['Confirm bank import', 'تأكيد استيراد بنكي'], 'bank_import.preview': ['Preview bank import', 'معاينة استيراد بنكي'],
  'bank_transaction.match': ['Match bank transaction', 'مطابقة معاملة بنكية'], 'bank_transaction.reconcile': ['Reconcile bank transaction', 'تسوية معاملة بنكية'],
  'bank_transaction.reopen_reconciliation': ['Reopen bank reconciliation', 'إعادة فتح تسوية بنكية'], 'bank_transaction.unmatch': ['Unmatch bank transaction', 'إلغاء مطابقة معاملة بنكية'],
  'counterparty.create': ['Create counterparty', 'إنشاء طرف مقابل'],
  'custody.close': ['Close custody', 'إغلاق عهدة'], 'custody.create': ['Create custody', 'إنشاء عهدة'], 'custody.reopen': ['Reopen custody', 'إعادة فتح عهدة'],
  'custody.document.allocate': ['Allocate document to custody', 'تخصيص مستند لعهدة'], 'custody.document.remove': ['Remove document from custody', 'إزالة مستند من عهدة'],
  'custody.return.link': ['Link custody return', 'ربط إرجاع عهدة'], 'custody.return.unlink': ['Unlink custody return', 'فك ربط إرجاع عهدة'],
  'document_vat_review.create': ['Create document VAT review', 'إنشاء مراجعة ضريبة مستند'], 'document_vat_review.update': ['Update document VAT review', 'تعديل مراجعة ضريبة مستند'],
  'monthly_close.close': ['Close month', 'إغلاق شهر'], 'monthly_close.create': ['Create monthly close', 'إنشاء إقفال شهري'], 'monthly_close.reopen': ['Reopen month', 'إعادة فتح شهر'],
  'obligation.create': ['Create obligation', 'إنشاء التزام'], 'obligation_settlement.create': ['Create obligation settlement', 'إنشاء تسوية التزام'], 'obligation_settlement.remove': ['Remove obligation settlement', 'إزالة تسوية التزام'],
  'opening_balance.approve': ['Approve opening balances', 'اعتماد الأرصدة الافتتاحية'], 'opening_balance.create': ['Create opening balance review', 'إنشاء مراجعة الأرصدة الافتتاحية'],
  'opening_balance_item.create': ['Create opening balance item', 'إنشاء بند رصيد افتتاحي'], 'opening_balance_item.delete': ['Delete opening balance item', 'حذف بند رصيد افتتاحي'],
  'opening_balance_item.update': ['Update opening balance item', 'تعديل بند رصيد افتتاحي'],
  'partner.create': ['Create partner', 'إنشاء شريك'], 'partner_ownership.create': ['Create partner ownership', 'إنشاء ملكية شريك'],
  'periodic_adjustment.approve': ['Approve periodic adjustment', 'اعتماد تسوية دورية'], 'periodic_adjustment.create': ['Create periodic adjustment', 'إنشاء تسوية دورية'],
  'periodic_adjustment.return_to_draft': ['Return periodic adjustment to draft', 'إرجاع تسوية دورية إلى مسودة'], 'periodic_adjustment.schedule.post': ['Post adjustment schedule row', 'ترحيل صف من جدول التسوية'],
  'periodic_adjustment.submit_review': ['Submit periodic adjustment for review', 'إرسال تسوية دورية للمراجعة'], 'periodic_adjustment.update': ['Update periodic adjustment', 'تعديل تسوية دورية'],
  review: ['Review', 'مراجعة'], submit: ['Submit', 'إرسال'],
  'tax_workpaper.adjustment.create': ['Create tax adjustment', 'إنشاء تعديل ضريبي'], 'tax_workpaper.adjustment.delete': ['Delete tax adjustment', 'حذف تعديل ضريبي'],
  'tax_workpaper.adjustment.professional_review.resolve': ['Resolve adjustment professional review', 'حسم المراجعة المهنية لتعديل ضريبي'],
  'tax_workpaper.adjustment.update': ['Update tax adjustment', 'تحديث تعديل ضريبي'], 'tax_workpaper.create': ['Create tax working paper', 'إنشاء ورقة عمل ضريبية'],
  'tax_workpaper.professional_review.resolve': ['Resolve professional review', 'حسم المراجعة المهنية'], 'tax_workpaper.reconcile': ['Reconcile tax working paper', 'تسوية ورقة عمل ضريبية'],
  'tax_workpaper.update': ['Update tax working paper', 'تعديل ورقة عمل ضريبية'],
  'vat_adjustment.create': ['Create VAT adjustment', 'إنشاء تعديل ضريبة القيمة المضافة'], 'vat_adjustment.update': ['Update VAT adjustment', 'تحديث تعديل ضريبة القيمة المضافة'],
  'vat_period.close': ['Close VAT period', 'إغلاق فترة ضريبية'], 'vat_period.create': ['Create VAT period', 'إنشاء فترة ضريبية'], 'vat_period.reopen': ['Reopen VAT period', 'إعادة فتح فترة ضريبية'],
  'vat_return.approve': ['Approve VAT return', 'اعتماد إقرار ضريبي'], 'vat_return.create': ['Create VAT return', 'إنشاء إقرار ضريبي'], 'vat_return.file': ['File VAT return', 'تقديم إقرار ضريبي'],
};
const ENTITIES: Record<string, Pair> = {
  asset_depreciation_entry: ['Depreciation entry', 'قيد إهلاك'], company: ['Company', 'شركة'], document: ['Document', 'مستند'], document_settlement: ['Document settlement', 'تسوية مستند'],
  journal_entry: ['Journal entry', 'قيد يومية'], membership: ['Membership', 'عضوية'], role: ['Role', 'دور'], user: ['User', 'مستخدم'], account: ['Account', 'حساب'],
  annual_closing_package: ['Annual closing package', 'حزمة إقفال سنوي'], annual_closing_package_snapshot: ['Annual closing package snapshot', 'لقطة حزمة إقفال سنوي'],
  asset_category: ['Asset category', 'فئة أصول'], asset_category_depreciation_policy: ['Depreciation policy', 'سياسة إهلاك'], asset_estimate_change: ['Asset estimate change', 'تغيير تقدير أصل'],
  bank_account: ['Bank account', 'حساب بنكي'], bank_import_batch: ['Bank import batch', 'دفعة استيراد بنكي'], bank_transaction: ['Bank transaction', 'معاملة بنكية'],
  company_accounting_profile: ['Company accounting profile', 'ملف محاسبي للشركة'], counterparty: ['Counterparty', 'طرف مقابل'], custody: ['Custody', 'عهدة'],
  document_vat_review: ['Document VAT review', 'مراجعة ضريبة مستند'], fixed_asset: ['Fixed asset', 'أصل ثابت'], monthly_close_period: ['Monthly close period', 'فترة إقفال شهري'],
  obligation: ['Obligation', 'التزام'], obligation_settlement: ['Obligation settlement', 'تسوية التزام'], opening_balance_item: ['Opening balance item', 'بند رصيد افتتاحي'],
  opening_balance_review: ['Opening balance review', 'مراجعة أرصدة افتتاحية'], partner: ['Partner', 'شريك'], partner_ownership: ['Partner ownership', 'ملكية شريك'],
  periodic_adjustment: ['Periodic adjustment', 'تسوية دورية'], periodic_adjustment_schedule: ['Adjustment schedule', 'جدول تسوية'], tax_working_paper: ['Tax working paper', 'ورقة عمل ضريبية'],
  tax_working_paper_adjustment: ['Tax working paper adjustment', 'تعديل ورقة عمل ضريبية'], vat_adjustment: ['VAT adjustment', 'تعديل ضريبة القيمة المضافة'], vat_period: ['VAT period', 'فترة ضريبية'],
  vat_return: ['VAT return', 'إقرار ضريبي'], wht_review: ['Withholding tax review', 'مراجعة ضريبة مقتطعة'],
};
const FIELDS: Record<string, Pair> = {
  status: ['Status', 'الحالة'], name: ['Name', 'الاسم'], email: ['Email', 'البريد الإلكتروني'], version: ['Version', 'الإصدار'], capabilities: ['Permissions', 'الصلاحيات'],
  company_id: ['Company ID', 'معرّف الشركة'], is_active: ['Active', 'نشط'], lines: ['Lines', 'البنود'], periods: ['Periods', 'الفترات'], effective_from: ['Effective from', 'ساري من'],
  effective_to: ['Effective to', 'ساري إلى'], remaining_periods: ['Remaining periods', 'الفترات المتبقية'], residual_value: ['Residual value', 'القيمة التخريدية'],
  net_book_value: ['Net book value', 'صافي القيمة الدفترية'], journal_entry_id: ['Journal entry ID', 'معرّف قيد اليومية'], posted_by: ['Posted by', 'رُحّل بواسطة'],
  posted_at: ['Posted at', 'تاريخ الترحيل'], package_id: ['Package ID', 'معرّف الحزمة'], snapshot_no: ['Snapshot no.', 'رقم اللقطة'], snapshot_type: ['Snapshot type', 'نوع اللقطة'],
  source_fingerprint: ['Source fingerprint', 'بصمة المصدر'], final_snapshot_id: ['Final snapshot ID', 'معرّف اللقطة النهائية'], handed_off_at: ['Handed off at', 'تاريخ التسليم'],
  handoff_note: ['Handoff note', 'ملاحظة التسليم'], handoff_reference: ['Handoff reference', 'مرجع التسليم'], reviewed_at: ['Reviewed at', 'تاريخ المراجعة'],
  approved_at: ['Approved at', 'تاريخ الاعتماد'], review_note: ['Review note', 'ملاحظة المراجعة'], approval_note: ['Approval note', 'ملاحظة الاعتماد'], partner_id: ['Partner ID', 'معرّف الشريك'],
  change_reason: ['Change reason', 'سبب التغيير'], reason: ['Reason', 'السبب'], amount: ['Amount', 'المبلغ'], date: ['Date', 'التاريخ'], note: ['Note', 'ملاحظة'], notes: ['Notes', 'ملاحظات'],
  created_at: ['Created at', 'تاريخ الإنشاء'], updated_at: ['Updated at', 'تاريخ التحديث'], role_id: ['Role ID', 'معرّف الدور'], user_id: ['User ID', 'معرّف المستخدم'],
};
const VALUES: Record<string, Pair> = {
  draft: ['Draft', 'مسودة'], open: ['Open', 'مفتوح'], closed: ['Closed', 'مغلق'], pending: ['Pending', 'قيد الانتظار'], posted: ['Posted', 'مرحّل'], in_review: ['In review', 'قيد المراجعة'],
  approved: ['Approved', 'معتمد'], reviewed: ['Reviewed', 'تمت المراجعة'], final: ['Final', 'نهائي'], finalized: ['Finalized', 'نهائي'], preview: ['Preview', 'معاينة'],
  cancelled: ['Cancelled', 'ملغى'], canceled: ['Cancelled', 'ملغى'], disposed: ['Disposed', 'مستبعد'], active: ['Active', 'نشط'], inactive: ['Inactive', 'غير نشط'],
  handed_off: ['Handed off', 'مُسلَّم'], filed: ['Filed', 'مُقدَّم'], confirmed: ['Confirmed', 'مؤكد'], settled: ['Settled', 'مسوّى'], reconciled: ['Reconciled', 'مسوّى بنكياً'],
};

export const auditActionLabel = (value: string, lang: Lang) => ACTIONS[value] ? pick(ACTIONS[value], lang) : humanize(value);
export const auditEntityLabel = (value: string, lang: Lang) => ENTITIES[value] ? pick(ENTITIES[value], lang) : humanize(value);
export const auditFieldLabel = (key: string, lang: Lang) => FIELDS[key] ? pick(FIELDS[key], lang) : humanize(key);
export const auditStatusLabel = (value: string, lang: Lang) => VALUES[value] ? pick(VALUES[value], lang) : null;
export { capabilityLabel };
