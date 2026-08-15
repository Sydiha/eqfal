# RECAP_SESSION

## آخر تحديث
2026-08-15

## حالة المشروع
مشروع **إقفال | EQFAL** مستمر في بناء Core MVP، وتم إغلاق ودمج حزمة **Auth / Session + Company Switcher Integration** بنجاح.

## المرجع المعتمد
- Repository: `Sydiha/eqfal`
- المرجع الوحيد للكود المدمج: `main`
- آخر main معتمد: `ff52b059b2f0ade41625d4c5a3a727061c47d6a3`
- هذا الـcommit هو Merge PR #10 الخاص بـ Auth / Session + Secure Company Switching.

## ما تم إنجازه حتى الآن
- Bootstrap Core Foundation — PR #2 merged.
- Data / Tenancy Foundation — PR #3 merged.
- Auth / Users Foundation — PR #4 merged.
- Memberships + Roles + Capabilities Foundation — PR #5 merged.
- Fiscal Years + Initial Audit Foundation — PR #6 merged.
- i18n + Company Switcher Foundation — PR #7 merged.
- Tool Routing / Operational Leadership documentation — PR #9 merged.
- Auth / Session + Company Switcher Integration — PR #10 merged.

## آخر تحقق تقني
تم التحقق فعليًا على head `151d765a` قبل دمج PR #10:
- Server tests: 106/106 passed.
- Client tests: 42/42 passed.
- Total tests: 148/148 passed.
- TypeScript server: passed with 0 errors.
- TypeScript client: passed with 0 errors.
- Build server: passed.
- Build client: passed.
- PR #10 تمت مراجعته وكان mergeable بلا blockers ثم دُمج إلى `main`.

## الحالة الأمنية/المعمارية الحالية
- المستخدم كيان عالمي وMembership مستقلة لكل شركة.
- Roles company-scoped وCapabilities تشغيلية.
- Grant Ceiling يمنع self/privilege escalation ضمن الحدود المبنية.
- `company_id` وحده ليس Authorization؛ كل tenant-scoped flow يجب أن يتحقق من المستخدم والعضوية والشركة والصلاحية.
- Auth الفعلي أصبح مبنيًا على Server-side sessions مخزنة في PostgreSQL.
- Session token عشوائي opaque يُنقل عبر HttpOnly Cookie، ويُخزن في DB على شكل hash وليس token خام.
- Login وSession bootstrap وLogout أصبحت موجودة فعليًا.
- المستخدم المعطل أو Session المنتهية لا تمنح وصولًا.
- الشركات المسموحة تُستخرج من Active Memberships مع استبعاد الشركات والعضويات المعطلة.
- Active Company مرتبطة بالجلسة ويعاد التحقق منها في Backend عند Company Switch.
- Company Switch الفاشل لا يغيّر الشركة النشطة الحالية.
- Capability enforcement boundary موجود في Backend ولا يعتمد على إخفاء عناصر Frontend.
- تغيير Role/Capabilities أو تعطيل Membership ينعكس في الطلبات التالية من المصدر الموثوق في DB.
- Fiscal Year sensitive updates تستخدم transaction + locking مناسب.
- Audit Log أولي مع recursive sanitization للبيانات الحساسة.
- العربية/الإنجليزية وRTL/LTR موجودة كأساس.
- Company Switcher أصبح مربوطًا بالمستخدم الحقيقي والجلسة الحقيقية، وليس ببيانات Placeholder.

## قرار سير العمل المعتمد
- لا يستخدم Replit Agent لتعديل الكود.
- ChatGPT + GitHub يتوليان التنفيذ والفروع والـcommits والـPR والمراجعة والMerge حسب قواعد المشروع.
- Replit يبقى مؤقتًا للتشغيل والاختبارات والBuild والPreview عند الحاجة.
- لا Production دون موافقة صريحة.
- لا خدمات مدفوعة أو تكلفة تشغيلية جديدة دون موافقة.
- مهمة برمجية واحدة فقط في كل مرة.

## قاعدة التوثيق
بعد كل مرحلة أو حزمة عمل جوهرية أو قرار معماري/تشغيلي مؤثر، يتم تحديث رصيد المشروع في GitHub قبل الانتقال للمهمة التالية، وبشكل أساسي:
- `TODO.md`
- `DECISIONS.md`
- `RECAP_SESSION.md`
- `SECURITY_AND_TENANCY_CHECKLIST.md` عند تغير حالة بند أمني فعليًا.

## نقطة الاستئناف التالية
**اسم المهمة التالية المقترحة:** Fiscal Year API / Application Integration

**الهدف:** ربط Fiscal Years الموجودة فعليًا بطبقة HTTP/Application باستخدام Session الحالية وActive Company الموثوقة وCapability enforcement، مع الحفاظ على tenant isolation وAudit الحالي.

**يجب أن تبدأ المهمة بـ Design Check فقط قبل أي تعديل برمجي.**

## خارج نطاق المهمة التالية
- Accounting periods.
- Month/Quarter close.
- Reopen workflow الكامل.
- VAT/Zakat.
- OCR والفواتير والبنوك.
- Dashboard مالي كامل.
- Production deployment.
- أي خدمة مدفوعة جديدة.

## ملاحظة
التفاصيل الكاملة للإنجازات والإصلاحات والBacklog موجودة في `TODO.md`، والقرارات الدائمة موجودة في `DECISIONS.md`.
