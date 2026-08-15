# SECURITY_AND_TENANCY_CHECKLIST

آخر تحديث: 2026-08-15

## عزل الشركات
- [x] الكيانات company-scoped الحالية تستخدم `company_id` أو ownership قابلة للتحقق.
- [x] Active Company تأتي من Session الموثوقة وليست من client authority مستقلة.
- [x] Company switch يعيد التحقق server-side من العضوية الفعالة والشركة الفعالة قبل التغيير.
- [x] فشل Company switch لا يغيّر Active Company الحالية.
- [x] قائمة الشركات في الواجهة مشتقة من Active Memberships + Active Companies ولا تعتبر Security Boundary.
- [x] Fiscal Year read/write company-scoped ومحمية من cross-company direct-ID access.
- [x] Document metadata/file retrieval company-scoped.
- [x] Document review mutations تستخدم lookup مقيدًا بـ`id + company_id`.
- [x] cross-company document lookup يعطي safe 404 ولا يكشف وجود السجل.
- [ ] تطبيق واختبار نفس النمط على كل كيان مالي جديد عند بنائه.

## المستخدمون والجلسات والصلاحيات
- [x] الحساب الواحد يمكن ربطه بعدة شركات بعضويات مستقلة.
- [x] تعطيل عضوية شركة لا يعطل العضويات الأخرى.
- [x] Roles company-scoped وCapabilities تشغيلية وليست صلاحيات صفحات.
- [x] Grant Ceiling وself-escalation protection موجودان ضمن الحدود الحالية.
- [x] Login يستخدم password hashing/verification ولا يعرض `password_hash` للعميل.
- [x] المستخدم المعطل لا يستطيع تسجيل الدخول.
- [x] Session فعلية Server-side في PostgreSQL.
- [x] Session token opaque وعشوائي عبر HttpOnly Cookie، والـDB يخزن hash لا token خام.
- [x] Session المنتهية/الملغاة ترفض الوصول.
- [x] Logout يبطل Session الحالية ويمسح Cookie.
- [x] Backend هو مرجع capability enforcement النهائي.
- [x] capability changes تنعكس من DB بدل الاعتماد على صلاحيات طويلة العمر داخل Session.
- [x] `document.view` و`document.upload` منفصلتان.
- [x] `document.review` و`document.approve` منفصلتان؛ امتلاك review وحدها لا يسمح بالاعتماد.
- [ ] أي مسارات إدارة مستخدمين مستقبلية تمنع defaults أو grants التي تتجاوز سقف المنشئ.

## حماية HTTP / Session
- [x] Session Cookie: `HttpOnly` و`SameSite=Lax` و`Secure` في Production.
- [x] Auth mutations تستخدم Same-Origin validation حيث يلزم.
- [x] Document upload يستخدم Same-Origin validation.
- [x] Document submit-review/review mutations تستخدم Same-Origin validation.
- [x] request logging لا يسجل bodies/cookies/session tokens.
- [x] أخطاء async الحساسة تمر عبر generic backend error handling بدل تسريب التفاصيل الداخلية.
- [x] Document review rejects invalid decisions/notes قبل mutation.
- [ ] Rate limiting / brute-force protection يراجع قبل Production إذا أظهر Design Check الحاجة إليه.
- [ ] Password reset / logout-all-devices يطبق فقط عند بناء هذه الميزات.

## المستندات والتخزين
- [x] لا BLOBs للمستندات داخل PostgreSQL.
- [x] Storage Adapter قابل للاستبدال.
- [x] لا permanent public file URLs في التدفق الحالي.
- [x] رفع الملفات مقيد حاليًا بـPDF/JPEG/PNG/WebP.
- [x] الحد الأقصى 10 MB.
- [x] extension + MIME + file signature validation قبل التخزين المنطقي.
- [x] SHA-256 يحسب Server-side.
- [x] file retrieval يتحقق من metadata authorization قبل قراءة storage key.
- [x] storage key لا يأتي من Client كمرجع authority.
- [ ] no-hard-delete policy تطبق وتختبر عند إضافة أي delete/version/replace flow مستقبلًا.

## Document Review Workflow
- [x] الحالة الابتدائية للرفع `uploaded`.
- [x] `uploaded -> needs_review` فقط عبر submit-review و`document.upload`.
- [x] submit-review لا يضع `reviewed_by_user_id` أو `reviewed_at` أو `review_note`.
- [x] `needs_review -> incomplete/rejected` يتطلب `document.review`.
- [x] `needs_review -> approved` يتطلب `document.approve`.
- [x] incomplete/rejected يتطلبان reason غير فارغ.
- [x] approved يسمح note اختيارية.
- [x] review note max 500 في HTTP validation وDB constraint.
- [x] transition lookup يستخدم `SELECT ... FOR UPDATE` داخل transaction.
- [x] invalid/stale transition يعيد 409.
- [x] final review mutation وAudit داخل نفس transaction.
- [x] Audit actions منفصلة: `document.submit_review`, `document.mark_incomplete`, `document.reject`, `document.approve`.
- [x] UI capability visibility ليست Security Boundary؛ Backend يعيد التحقق دائمًا.

## التدقيق والبيانات الحساسة
- [x] Audit Log foundation موجودة للأحداث الحساسة المبنية حتى الآن.
- [x] Audit sanitization recursive وcase-insensitive.
- [x] Fiscal Year sensitive changes تستخدم transaction/locking/audit مناسبًا.
- [x] Document upload يسجل Audit.
- [x] Document review state changes تسجل before/after status والactor/company.
- [ ] لا حذف نهائي صامت للسجلات المالية الحساسة عند بناء flows جديدة.

## الأسرار والبيئات
- [ ] يستمر التحقق مع كل تغيير بيئي من عدم وجود أسرار/مفاتيح داخل Git.
- [ ] Staging وProduction لا يشتركان في DB أو secrets عند تشغيلهما فعليًا.
- [ ] بيانات Production لا تستخدم في Staging دون تنقيح/إخفاء مناسب.
- [x] Production غير منشور حاليًا ولا يجوز نشره دون موافقة صريحة.

## التحقق التنفيذي الحالي
- [x] GitHub Actions CI يعمل على PRs إلى `main` وعلى push إلى `main`.
- [x] PR #20 Phase 2B اجتاز Install dependencies.
- [x] PR #20 Phase 2B اجتاز TypeScript.
- [x] PR #20 Phase 2B اجتاز Tests.
- [x] PR #20 Phase 2B اجتاز Build.
- [x] PR #20 reviewed ثم merged إلى `main`.
- [x] Design Check compliance جزء من Definition of Done عبر `AGENTS.md`.
- [x] One-Shot Rule وZero-Loop Rule موثقتان كحواجز تشغيل دائمة في حزمة Documentation Recovery.

## بوابة المراجعة
لا تعتبر هذه القائمة مكتملة نهائيًا. البنود التي تخص وحدات لم تُبنَ بعد تبقى مفتوحة، وكل module جديد يجب أن يضيف اختبارات tenant/capability/concurrency/audit المناسبة لحدوده الفعلية قبل الدمج.
