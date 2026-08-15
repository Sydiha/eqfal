# RECAP_SESSION

## آخر تحديث
2026-08-15

## حالة المشروع
مشروع **إقفال | EQFAL** مستمر في بناء Core MVP. تم إغلاق ودمج طبقة Auth/Session، Fiscal Year API، وFiscal Year UI داخل الـAuthenticated Application Shell، وأصبح GitHub Actions CI يعمل كطبقة تحقق دائمة قبل الدمج.

## المرجع المعتمد
- Repository: `Sydiha/eqfal`
- المرجع الوحيد للكود المدمج: `main`
- آخر main معتمد: `df1c419906a280cc3057e7c99fce8c04530afbb8`
- آخر Merge: PR #14 — Fiscal Years UI / Application Shell Integration.

## ما تم إنجازه حتى الآن
- Bootstrap Core Foundation — PR #2 merged.
- Data / Tenancy Foundation — PR #3 merged.
- Auth / Users Foundation — PR #4 merged.
- Memberships + Roles + Capabilities Foundation — PR #5 merged.
- Fiscal Years + Initial Audit Foundation — PR #6 merged.
- i18n + Company Switcher Foundation — PR #7 merged.
- Tool Routing / Operational Leadership documentation — PR #9 merged.
- Auth / Session + Secure Company Switching — PR #10 merged.
- Documentation recap refresh — PR #11 merged.
- Fiscal Year API / Application Integration — PR #12 merged.
- Permanent Tool & Cost Protocol — PR #13 merged.
- GitHub Actions CI foundation — PR #15 merged.
- Fiscal Years UI / Authenticated Shell Integration — PR #14 merged.

## الحالة التقنية الحالية
- Login/Session/Logout فعلي عبر Server-side sessions في PostgreSQL.
- Session token عشوائي opaque عبر HttpOnly Cookie، ويُخزن hash في DB.
- Active Company تأتي من Session الموثوقة، وتبديل الشركة يعاد التحقق منه Server-side.
- الشركات المتاحة مشتقة من Active Memberships + Active Companies فقط.
- Backend هو Security Boundary للصلاحيات، والـFrontend يستخدم capabilities للـUX فقط.
- Fiscal Year API يدعم list/create/edit/close داخل الشركة النشطة فقط.
- Fiscal Year UI تعرض السنوات المالية وتدعم create/edit/close حسب capabilities.
- تبديل الشركة يعيد تهيئة البيانات company-scoped ويمنع عرض بيانات الشركة السابقة أثناء الانتقال.
- 401 من application requests يعيد الواجهة إلى Login state.
- العربية والإنجليزية وRTL/LTR موجودة.
- لا Production deployment.

## آخر تحقق تقني معتمد
GitHub Actions على PR #14 نجح بالكامل على نفس الـPR المدمج:
- Install dependencies: passed.
- TypeScript: passed.
- Tests: passed.
- Build: passed.

كما نجحت بوابات CI على PR #15 نفسه قبل دمجه.

## GitHub Actions CI
تم اعتماد Workflow دائم على كل PR إلى `main` وعلى push إلى `main` لتشغيل:
1. dependency install.
2. TypeScript.
3. Tests.
4. Build.

ملاحظة تشغيلية مؤقتة:
- `package-lock.json` الحالي يحتوي بعض registry URLs الخاصة ببيئة Replit القديمة.
- الـCI يطبعها مؤقتًا إلى `registry.npmjs.org` داخل Runner فقط قبل `npm ci`.
- تنظيف الـlockfile نفسه يبقى بندًا مستقلًا ولا يغيّر Business Logic.

## قرار سير العمل المعتمد
- `GitHub/main` هو المرجع الدائم.
- لا يستخدم Replit Agent لتعديل كود إقفال.
- Chat + GitHub مسؤولان عن الإدارة والمراجعة والـPR/CI/merge ضمن الصلاحيات المتاحة.
- Codex يستخدم للأعمال البرمجية عند الحاجة، لكن المستخدم لا يكون وسيط نقل يدوي بين Chat وCodex كمسار تشغيل طبيعي.
- Replit يبقى Runtime/Preview فقط عند الحاجة وبأقل تكلفة.
- لا Production دون موافقة صريحة.
- لا خدمات مدفوعة أو تكلفة تشغيلية جديدة دون موافقة.
- مهمة برمجية واحدة فقط في كل مرة.

## قاعدة التوثيق
بعد كل مرحلة جوهرية يتم تحديث رصيد المشروع في GitHub، وبشكل أساسي:
- `TODO.md`
- `DECISIONS.md`
- `RECAP_SESSION.md`
- `SECURITY_AND_TENANCY_CHECKLIST.md` عندما تتغير حالة بند أمني فعليًا.

## نقطة الاستئناف التالية
**اسم المهمة التالية المقترحة:** Core MVP Security & Readiness Review

**الهدف:** مراجعة Read-only شاملة للحدود الأمنية والتكاملات الموجودة بعد اكتمال Auth/Session وFiscal Year API/UI، وتحديد فقط الاختبارات أو الإصلاحات الضرورية قبل الانتقال إلى الوحدة التشغيلية التالية.

**يجب أن تبدأ المهمة بـ Design Check / Read-only review فقط قبل أي تعديل برمجي.**

## نطاق المراجعة التالية
- Auth/session invalidation behavior.
- tenant isolation عبر HTTP/Application boundary.
- Fiscal Year cross-company read/write protections.
- capability enforcement coverage.
- company-switch stale-state behavior.
- audit coverage للأحداث الحساسة الحالية.
- 401/403/404/409 behavior.
- CI verification path.
- تحديد أي blockers حقيقية فقط.

## خارج نطاق المهمة التالية
- Accounting periods.
- Month/Quarter close.
- Reopen workflow الكامل.
- VAT/Zakat.
- OCR والفواتير والبنوك.
- Dashboard مالي كامل.
- Production deployment.
- أي خدمة مدفوعة جديدة.
