/**
 * Human-readable names for capability IDs (UI only). IDs stay untouched in state and API payloads.
 * A label is composed as "<verb> <object>": the last ID segment is the verb, the preceding
 * segments (longest known prefix) name the object. Unknown parts fall back to a readable form.
 */
export type Lang = 'ar' | 'en';
type Pair = readonly [en: string, ar: string];
export const langOf = (language: string | undefined): Lang => (language?.startsWith('ar') ? 'ar' : 'en');
const pick = (pair: Pair, lang: Lang) => (lang === 'ar' ? pair[1] : pair[0]);

const VERBS: Record<string, Pair> = {
  view: ['View', 'عرض'], create: ['Create', 'إنشاء'], edit: ['Edit', 'تعديل'], manage: ['Manage', 'إدارة'],
  approve: ['Approve', 'اعتماد'], review: ['Review', 'مراجعة'], submit: ['Submit', 'إرسال'], post: ['Post', 'ترحيل'],
  close: ['Close', 'إغلاق'], reopen: ['Reopen', 'إعادة فتح'], cancel: ['Cancel', 'إلغاء'], disable: ['Disable', 'تعطيل'],
  confirm: ['Confirm', 'تأكيد'], settle: ['Settle', 'تسوية'], delete: ['Delete', 'حذف'], dispose: ['Dispose of', 'استبعاد'],
  import: ['Import', 'استيراد'], match: ['Match', 'مطابقة'], reconcile: ['Reconcile', 'تسوية'], upload: ['Upload', 'رفع'],
  grant: ['Grant', 'منح'], revoke: ['Revoke', 'سحب'], assign: ['Assign', 'تعيين'], finalize: ['Finalize', 'اعتماد نهائي لـ'],
  handoff: ['Hand off', 'تسليم'], file: ['File', 'تقديم'], remove: ['Remove', 'إزالة'], update: ['Update', 'تحديث'],
};
const OBJECTS: Record<string, Pair> = {
  access: ['access administration', 'إدارة الصلاحيات'],
  'access.membership': ['company memberships', 'عضويات المستخدمين'],
  'access.membership.role': ['membership roles', 'أدوار الأعضاء'],
  'access.membership.status': ['membership status', 'حالة العضوية'],
  'access.role': ['roles', 'الأدوار'],
  'access.role.capability': ['role permissions', 'صلاحيات الدور'],
  accounting: ['accounting', 'المحاسبة'], 'accounting.chart': ['chart of accounts', 'دليل الحسابات'],
  'accounting.journal': ['journal entries', 'قيود اليومية'],
  annual_close: ['annual closing', 'الإقفال السنوي'], 'annual_close.package': ['annual closing packages', 'حزم الإقفال السنوي'],
  'annual_close.package.snapshot': ['annual closing package snapshots', 'لقطات حزمة الإقفال السنوي'],
  asset: ['fixed assets', 'الأصول الثابتة'], 'asset.estimate_change': ['asset estimate changes', 'تغييرات تقدير الأصول'],
  'asset.policy': ['depreciation policies', 'سياسات الإهلاك'],
  audit: ['audit log', 'سجل التدقيق'],
  bank: ['bank data', 'بيانات البنك'], 'bank.account': ['bank accounts', 'الحسابات البنكية'],
  company: ['companies', 'الشركات'], 'company.status': ['company status', 'حالة الشركة'],
  company_accounting_profile: ['company accounting profile', 'الملف المحاسبي للشركة'],
  counterparty: ['counterparties', 'الأطراف المقابلة'],
  custody: ['custody advances', 'العهد'], document: ['documents', 'المستندات'],
  fiscal_year: ['fiscal years', 'السنوات المالية'], monthly_close: ['monthly closing', 'الإقفال الشهري'],
  obligation: ['obligations', 'الالتزامات'], 'obligation.settlement': ['obligation settlements', 'تسويات الالتزامات'],
  opening_balance: ['opening balances', 'الأرصدة الافتتاحية'], 'opening_balance.item': ['opening balance items', 'بنود الأرصدة الافتتاحية'],
  partner: ['partners', 'الشركاء'], 'partner.ownership': ['partner ownership', 'ملكية الشركاء'],
  periodic_adjustment: ['periodic adjustments', 'التسويات الدورية'], report: ['reports', 'التقارير'],
  tax_workpaper: ['tax working papers', 'أوراق العمل الضريبية'], 'tax_workpaper.adjustment': ['tax working paper adjustments', 'تعديلات أوراق العمل الضريبية'],
  vat: ['VAT', 'ضريبة القيمة المضافة'], wht_review: ['withholding tax reviews', 'مراجعات الضريبة المقتطعة'],
};
/** Group headings shown above related capabilities (first ID segment). */
const GROUPS: Record<string, Pair> = {
  access: ['Access', 'إدارة الصلاحيات'], accounting: ['Accounting', 'المحاسبة'], annual_close: ['Annual closing', 'الإقفال السنوي'],
  asset: ['Fixed assets', 'الأصول الثابتة'], audit: ['Audit log', 'سجل التدقيق'], bank: ['Banking', 'البنوك'], company: ['Companies', 'الشركات'],
  company_accounting_profile: ['Company accounting profile', 'الملف المحاسبي للشركة'], counterparty: ['Counterparties', 'الأطراف المقابلة'],
  custody: ['Custody', 'العهد'], document: ['Documents', 'المستندات'], fiscal_year: ['Fiscal years', 'السنوات المالية'],
  monthly_close: ['Monthly closing', 'الإقفال الشهري'], obligation: ['Obligations', 'الالتزامات'], opening_balance: ['Opening balances', 'الأرصدة الافتتاحية'],
  partner: ['Partners', 'الشركاء'], periodic_adjustment: ['Periodic adjustments', 'التسويات الدورية'], report: ['Reports', 'التقارير'],
  tax_workpaper: ['Tax working papers', 'أوراق العمل الضريبية'], vat: ['VAT', 'ضريبة القيمة المضافة'], wht_review: ['Withholding tax reviews', 'مراجعات الضريبة المقتطعة'],
};
/** Whole-ID overrides where composition would read poorly. */
const OVERRIDES: Record<string, Pair> = {
  'access.view': ['View users & permissions', 'عرض المستخدمين والصلاحيات'], 'access.manage': ['Manage users & permissions', 'إدارة الصلاحيات'],
  'access.membership.create': ['Add company members', 'إنشاء عضوية مستخدم'], 'access.membership.role.assign': ['Assign roles to members', 'تعيين دور للعضو'],
  'access.membership.status.edit': ['Change membership status', 'تعديل حالة العضوية'], 'access.role.create': ['Create roles', 'إنشاء دور'],
  'access.role.capability.grant': ['Grant permissions to roles', 'منح صلاحيات للدور'], 'access.role.capability.revoke': ['Revoke permissions from roles', 'سحب صلاحيات من الدور'],
  'annual_close.package.finalize': ['Finalize annual closing packages', 'الاعتماد النهائي لحزمة الإقفال السنوي'],
  'annual_close.package.handoff': ['Hand off annual closing packages', 'تسليم حزمة الإقفال السنوي'],
  'annual_close.package.snapshot.create': ['Create annual closing package snapshots', 'إنشاء لقطة لحزمة الإقفال السنوي'],
  'audit.view': ['View audit log', 'عرض سجل التدقيق'],
  'bank.import': ['Import bank statements', 'استيراد كشوف البنك'], 'bank.match': ['Match bank transactions', 'مطابقة المعاملات البنكية'],
  'bank.reconcile': ['Reconcile bank transactions', 'تسوية المعاملات البنكية'],
  'obligation.settle': ['Settle obligations', 'تسوية الالتزامات'], 'invoice.create': ['Create invoices', 'إنشاء الفواتير'],
  'payment.settle': ['Settle payments', 'تسوية الدفعات'],
  'document.upload': ['Upload documents', 'رفع المستندات'], 'document.submit': ['Submit documents for review', 'إرسال المستندات للمراجعة'],
};

const humanize = (id: string) => id.replace(/[._]+/g, ' ');
export function capabilityGroupKey(id: string): string { return id.split('.')[0]; }
export function capabilityGroupLabel(group: string, lang: Lang): string {
  const pair = GROUPS[group]; return pair ? pick(pair, lang) : humanize(group);
}
export function capabilityLabel(id: string, lang: Lang): string {
  const override = OVERRIDES[id]; if (override) return pick(override, lang);
  const parts = id.split('.');
  const verb = VERBS[parts[parts.length - 1]];
  const object = OBJECTS[parts.slice(0, -1).join('.')] ?? (parts.length === 1 ? OBJECTS[id] : undefined);
  if (verb && object) return `${pick(verb, lang)} ${pick(object, lang)}`;
  return humanize(id); // unknown or new capability: readable fallback, never blank
}
