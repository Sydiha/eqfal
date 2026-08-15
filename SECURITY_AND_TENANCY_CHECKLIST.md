# SECURITY_AND_TENANCY_CHECKLIST

## عزل الشركات
- [ ] كل كيان مالي تابع لشركة يحمل `company_id` أو علاقة ملكية قابلة للتحقق.
- [ ] كل قراءة وكتابة وبحث وتصدير يتحقق من عضوية الشركة الحالية.
- [ ] منع الوصول عبر ID مباشر لسجل شركة أخرى.
- [ ] اختبار cross-company read/write/search/export لكل الوحدات المالية عند بنائها.
- [x] Company switch يعيد التحقق server-side من العضوية الفعالة والشركة الفعالة قبل تغيير Active Company.
- [x] فشل Company switch لا يغيّر Active Company الحالية.
- [x] قائمة الشركات في الواجهة مشتقة من Active Memberships ولا تعتبر مصدر الصلاحية النهائي.

## المستخدمون والجلسات والصلاحيات
- [x] الحساب الواحد يمكن ربطه بعدة شركات بعضويات مستقلة.
- [x] تعطيل عضوية شركة لا يعطل العضويات الأخرى.
- [x] Roles company-scoped وCapabilities تشغيلية وليست صلاحيات صفحات.
- [x] Grant Ceiling يمنع منح Role تتجاوز قدرات المانح ضمن الحدود الحالية.
- [x] Login يستخدم password hashing/verification ولا يعرض `password_hash` للعميل.
- [x] المستخدم المعطل لا يستطيع تسجيل الدخول.
- [x] Session فعلية Server-side موجودة ومخزنة في PostgreSQL.
- [x] Session token عشوائي opaque وينقل عبر HttpOnly Cookie، ولا يخزن token الخام في DB.
- [x] Session منتهية أو غير صالحة ترفض الوصول.
- [x] Logout يبطل Session الحالية Server-side ويمسح Cookie.
- [x] Active Company جزء من Session الموثوقة وليس مجرد state يتحكم بها Client.
- [x] Backend capability boundary موجود للـendpoints المستقبلية المحمية.
- [x] تغيير Role/Capabilities أو تعطيل Membership ينعكس من DB في الطلبات التالية بدل الاعتماد على صلاحيات طويلة العمر داخل Session.
- [ ] لا Defaults تمنح صلاحيات أعلى من سقف المنشئ في أي مسارات إدارة مستخدمين مستقبلية.

## حماية HTTP / Session
- [x] Cookie الخاصة بالجلسة `HttpOnly` و`SameSite=Lax` و`Secure` في Production.
- [x] الطلبات الحساسة في Auth تستخدم same-origin validation كحماية إضافية.
- [x] request logging لا يسجل bodies/cookies/session tokens.
- [x] أخطاء async في Auth تمر عبر generic backend error boundary بدل تسريب تفاصيل داخلية للعميل.
- [ ] Rate limiting / brute-force protection قبل Production إذا أظهر Design Check الحاجة إليه.
- [ ] Password reset / logout-all-devices invalidation عند بناء هذه الميزات لاحقًا.

## الأسرار والبيئات
- [ ] لا أسرار أو مفاتيح داخل Git — يستمر التحقق مع كل تغيير بيئي.
- [ ] Staging وProduction لا يشتركان في قاعدة البيانات أو الأسرار عند تشغيل البيئتين فعليًا.
- [ ] لا تستخدم بيانات Production الحقيقية في Staging دون تنقيح/إخفاء مناسب.
- [x] Production لم يُنشر ضمن مراحل Core الحالية ولا يجوز نشره دون موافقة صريحة.

## التدقيق والبيانات الحساسة
- [x] Audit Log foundation موجودة للأحداث الحساسة المبنية حتى الآن مع before/after عند الحاجة.
- [x] تنقية البيانات الحساسة recursive وcase-insensitive قبل Audit storage.
- [ ] لا حذف نهائي صامت للسجلات المالية الحساسة — يطبق ويختبر عند بناء كل كيان مالي.
- [ ] يمنع overwrite الصامت عند التزامن باستخدام locking/versioning المناسب حسب نوع الكيان.

## التحقق المنفذ بعد Auth / Session + Company Switcher
- [x] TypeScript server: 0 errors.
- [x] TypeScript client: 0 errors.
- [x] Server tests: 106/106 passed.
- [x] Client tests: 42/42 passed.
- [x] Total tests: 148/148 passed.
- [x] Server build: passed.
- [x] Client build: passed.
- [x] PR #10 reviewed and merged to `main` at `ff52b059b2f0ade41625d4c5a3a727061c47d6a3`.

## بوابة المراجعة
لا تعتبر هذه القائمة مكتملة بمجرد وجودها. البنود العامة التي تخص كيانات أو وحدات لم تُبنَ بعد تبقى مفتوحة، وتتحول إلى اختبارات فعلية عند بناء كل boundary ذات صلة.
