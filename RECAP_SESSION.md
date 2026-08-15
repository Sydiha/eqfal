# RECAP_SESSION

## آخر تحديث
2026-08-15

## حالة المشروع
انتقل مشروع **إقفال | EQFAL** من مرحلة تأسيس النواة والربط إلى بناء Core MVP، وتم إغلاق آخر حزمة عمل برمجية بنجاح.

## المرجع المعتمد
- Repository: `Sydiha/eqfal`
- المرجع الوحيد للكود المدمج: `main`
- آخر main معتمد قبل PR التوثيق الحالي: `264393e6188d04c7375909ce34cc6786ed77672a`
- هذا الـcommit هو Merge PR #7 الخاص بـ i18n + Company Switcher Foundation.

## ما تم إنجازه حتى الآن
- Bootstrap Core Foundation — PR #2 merged.
- Data / Tenancy Foundation — PR #3 merged.
- Auth / Users Foundation — PR #4 merged.
- Memberships + Roles + Capabilities Foundation — PR #5 merged.
- Fiscal Years + Initial Audit Foundation — PR #6 merged.
- i18n + Company Switcher Foundation — PR #7 merged.

## آخر تحقق تقني قبل التوثيق
آخر مرحلة برمجية مغلقة حققت:
- Server tests: 93/93 passed.
- Client tests: 40/40 passed.
- Total tests: 133/133 passed.
- TypeScript server: passed.
- TypeScript client: passed.
- Build: passed.
- بعد دمج PR #7 تمت مزامنة Replit على `main` والتحقق من أن HEAD يطابق `origin/main` وأن Working Tree نظيف.

## الحالة الأمنية/المعمارية الحالية
- المستخدم كيان عالمي وMembership مستقلة لكل شركة.
- Roles company-scoped وCapabilities تشغيلية.
- Grant Ceiling يمنع self/privilege escalation ضمن الحدود المبنية.
- `company_id` وحده ليس Authorization؛ كل tenant-scoped flow يجب أن يتحقق من المستخدم والعضوية والشركة والصلاحية.
- Fiscal Year sensitive updates تستخدم transaction + locking مناسب.
- Audit Log أولي مع recursive sanitization للبيانات الحساسة.
- العربية/الإنجليزية وRTL/LTR موجودة كأساس.
- Company Switcher UI/state foundation موجود، لكنه ليس Security Boundary نهائيًا.
- لا توجد شركات Placeholder في Runtime.

## قرار سير العمل الجديد
ابتداءً من المهمة التالية:
- لا يستخدم Replit Agent لتعديل الكود.
- ChatGPT + GitHub يتوليان التنفيذ والفروع والـcommits والـPR والمراجعة والMerge بعد موافقة المستخدم.
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
**اسم المهمة التالية:** Auth / Session + Company Switcher Integration

**الهدف:** بناء طبقة الجلسة والمصادقة اللازمة لربط المستخدم بعضوياته الحقيقية وشركاته المسموح بها، ثم ربط Company Switcher بها بصورة آمنة مع Backend revalidation.

**يجب أن تبدأ المهمة بـ Design Check فقط قبل أي تعديل برمجي.**

## خارج نطاق المهمة التالية
- Fiscal Year API الكامل إلا ما يلزم لحدود التصميم اللاحق.
- Accounting periods.
- Month/Quarter close.
- VAT/Zakat.
- OCR والفواتير والبنوك.
- Dashboard مالي كامل.
- Production deployment.
- أي خدمة مدفوعة جديدة.

## ملاحظة
التفاصيل الكاملة للإنجازات والإصلاحات والBacklog موجودة في `TODO.md`، والقرارات الدائمة موجودة في `DECISIONS.md`.
