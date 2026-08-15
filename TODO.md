# إقفال | EQFAL
# Project Progress & Status Report

آخر تحديث: 2026-08-15

## 1. الحالة التنفيذية المختصرة

المشروع انتقل بنجاح من مرحلة تأسيس النواة والربط إلى بناء Core MVP.

المرجع الدائم والوحيد للكود المدمج:
- Repository: `Sydiha/eqfal`
- Branch: `main`
- آخر main معتمد قبل هذا التحديث: `264393e6188d04c7375909ce34cc6786ed77672a`

آخر مرحلة مكتملة:
- i18n + Company Switcher Foundation

المهمة التالية:
- Auth / Session + ربط Company Switcher بعضويات المستخدم الحقيقية.

Production:
- غير منشور.
- لا يجوز النشر دون موافقة صريحة.

---

## 2. Completed Features & Tasks

### 2.1 تأسيس المشروع والمرجع الدائم
- إنشاء المستودع الخاص `Sydiha/eqfal`.
- اعتماد `GitHub/main` كمرجع دائم ووحيد للكود المدمج.
- ربط GitHub بالمشروع والتحقق من صلاحية الوصول.
- ربط Replit بالمستودع.
- التحقق عند إغلاق كل مرحلة من تطابق `main` مع `origin/main` ونظافة Working Tree.
- إنشاء التوثيق الأساسي: `ARCHITECTURE.md` و`DECISIONS.md` و`DEVELOPMENT_WORKFLOW.md` و`PROJECT_BRIEF.md` و`RECAP_SESSION.md` و`SECURITY_AND_TENANCY_CHECKLIST.md` و`docs/ENVIRONMENTS.md`.

### 2.2 Bootstrap Core Foundation — مكتمل ومُدمج
- Frontend: React + TypeScript + Vite + Mobile-first + RTL/LTR foundation.
- Backend: Node.js + TypeScript + Express ضمن Modular Monolith.
- Environment configuration، Structured logging، Health endpoint، PostgreSQL foundation، Migrations foundation.
- TypeScript ناجح، Tests ناجحة، Build ناجح.
- PR #2 — merged.

### 2.3 Data / Tenancy Foundation — مكتمل ومُدمج
- Company entity/repository وTenant-aware lookup primitive.
- PostgreSQL migrations وMigration execution controls.
- Advisory lock لحماية تشغيل migrations المتزامن.
- `company_id` كأساس للعزل مع tenancy tests في الحدود المبنية.
- فشل DB/migration الحرج أصبح fatal عند startup.
- TypeScript ناجح، Tests: 20/20 عند إغلاق المرحلة، Build ناجح.
- PR #3 — merged.

### 2.4 Auth / Users Foundation — مكتمل ومُدمج
- Users model/repository/service.
- Password hashing وverification.
- Dummy bcrypt hash صالح لتقليل فروقات timing في محاولات الدخول غير الصحيحة.
- هذه مرحلة Auth/User foundation فقط؛ Session/API login flow الفعلي لم يُبنَ بعد.
- TypeScript ناجح، Tests: 34/34 عند إغلاق المرحلة، Build ناجح.
- PR #4 — merged.

### 2.5 Memberships + Roles + Capabilities Foundation — مكتمل ومُدمج
- Membership مستقلة بين المستخدم والشركة مع دعم عدة شركات للمستخدم الواحد.
- تعطيل عضوية شركة لا يعطل المستخدم عالميًا.
- Roles company-scoped.
- منع إسناد دور من شركة أخرى لعضوية مختلفة الشركة.
- Capabilities تشغيلية مستقلة عن صلاحيات الصفحات.
- استخراج القدرات الفعالة للمستخدم داخل شركة محددة.
- Grant Ceiling يمنع منح صلاحيات أعلى من صلاحيات المانح ويمنع self-escalation.
- TypeScript ناجح، Tests: 54/54 عند إغلاق المرحلة، Build ناجح.
- PR #5 — merged.

### 2.6 Fiscal Years Foundation — مكتمل ومُدمج
- Fiscal Years مرتبطة بـ `company_id`.
- حالات `open` و`closed`.
- التحقق من `start_date < end_date`.
- منع تداخل السنوات المالية داخل نفس الشركة مع السماح بنفس الفترات لشركات مختلفة.
- company-aware operations وعدم الاعتماد على ID فقط.
- transaction-scoped advisory lock في سيناريوهات overlap.
- `SELECT ... FOR UPDATE` عند update/close.
- status check + write + audit داخل نفس transaction/client.
- خارج النطاق الحالي: Accounting periods، Month/Quarter close، Reopen workflow، VAT periods.
- PR #6 — merged.

### 2.7 Initial Audit Log Foundation — مكتمل ومُدمج
- Audit fields: `company_id`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `before_data`, `after_data`, `reason`, `created_at`.
- ربط أولي بالأحداث الحساسة في Fiscal Years.
- Sanitization مركزي recursive للـobjects والـarrays وبفحص case-insensitive للمفاتيح الحساسة.
- عدم تسجيل passwords/secrets.
- state change + audit event داخل نفس transaction في المسارات الحساسة.
- Audit Log حاليًا append-only على مستوى التطبيق؛ لا يوصف بأنه DB-immutable دون enforcement صريح.
- PR #6 — merged.

### 2.8 Internationalization — i18n — مكتمل كأساس
- العربية والإنجليزية باستخدام i18next وreact-i18next.
- العربية هي اللغة الافتراضية.
- حفظ اختيار اللغة في localStorage مع whitelist للقيم المدعومة.
- تحديث `document.lang` و`document.dir`.
- Arabic → RTL، English → LTR.
- لا خدمات أو مكتبات مدفوعة إضافية.

### 2.9 Company Switcher Foundation — مكتمل ومُدمج
- `CompanyContext` مركزي يدير `activeCompanyId`, `activeCompany`, `allowedCompanies`, `setActiveCompany`, `companyKey`.
- لا يعرض إلا `allowedCompanies` المقدمة له.
- منع اختيار Company ID خارج القائمة المسموحة وعدم تغيير الحالة عند المحاولة.
- لا توجد شركات Demo/Placeholder في Runtime؛ القائمة الافتراضية فارغة حتى Auth/Session الحقيقي.
- reconciliation عند تغير `allowedCompanies`:
  - وصول شركات بعد قائمة فارغة → اختيار شركة مسموحة.
  - فقد الوصول للشركة الحالية → fallback مسموح.
  - بقاء الشركة الحالية مسموحة → لا reset غير ضروري.
  - إعادة اختيار نفس الشركة → no-op ولا يزيد `companyKey`.
- Company Switcher ليس Security Boundary نهائيًا؛ التحقق الحقيقي يجب أن يكون في Backend عبر authenticated user + membership + company + capability.
- التحقق النهائي: Server 93/93، Client 40/40، الإجمالي 133/133، TypeScript ناجح، Build ناجح.
- PR #7 — merged.
- Merge commit: `264393e6188d04c7375909ce34cc6786ed77672a`.

---

## 3. Bug Fixes & Refactors

### 3.1 Migration/startup failure handling — محسوم
- جعل فشل DB/migrations الحرج fatal وواضحًا.
- إضافة advisory lock حول migrations.

### 3.2 Tenant access clarification — محسوم معماريًا
- `company_id` وcompany lookup primitive جزء من الحماية فقط وليسا Authorization كاملًا.
- كل API/service/operation مستقبلية يجب أن تطبق company + membership + capability checks.
- إخفاء الصفحة أو الزر ليس Security mechanism.

### 3.3 Auth timing behavior — محسوم
- استخدام dummy bcrypt hash صالح وإضافة اختبار timing-related behavior.

### 3.4 Permission Grant Ceiling flaw — محسوم
- إزالة الاعتماد على caller-provided `granterCompanyId`.
- اشتقاق company scope من membership والسياق الموثوق.
- إضافة bypass test.

### 3.5 Fiscal Year overlap race condition — محسوم
- company-level transaction advisory lock.
- overlap validation والكتابة على نفس transaction/client.

### 3.6 Fiscal Year stale update / audit race — محسوم
- transaction + `SELECT ... FOR UPDATE`.
- status validation من الصف المقفول.
- update + audit على نفس PoolClient.
- `before_data` من الحالة الحالية داخل transaction.

### 3.7 Audit sensitive data sanitization — محسوم
- recursive sanitizer للـobjects والـarrays مع case-insensitive sensitive keys.

### 3.8 Company Switcher placeholder data — محسوم
- إزالة كل شركات Placeholder/Demo من Runtime.
- `allowedCompanies` تبدأ فارغة.

### 3.9 Same-company unnecessary reset — محسوم
- same-company selection أصبح no-op و`companyKey` لا يتغير.

### 3.10 Dynamic allowedCompanies reconciliation — محسوم
- منع stale/null `activeCompanyId` بعد تغير قائمة الشركات المسموحة.
- الحفاظ على الحالية إن بقيت مسموحة وإلا fallback مسموح.

### 3.11 Test command reporting error — محسوم تشغيليًا
- تم تجاهل نتيجة تشغيل Jest اليدوي الخاطئ لأن المشروع يستخدم Vitest.
- اعتماد scripts الرسمية من root فقط في تقارير المشروع.
- النتيجة الصحيحة النهائية: Server 93/93 + Client 40/40 = 133/133.

---

## 4. Current Status

لا توجد مهمة برمجية مفتوحة حاليًا.

آخر عمل مدمج:
- PR #7 — i18n persistence and Company Switcher foundation.

النقطة التالية المعتمدة:
- **Auth / Session + Company Switcher Integration**.

يجب أن تبدأ بـ Design Check فقط قبل كتابة أي كود.

طريقة العمل من المرحلة التالية:
- ChatGPT + GitHub مسؤولان عن تنفيذ الكود والفروع والـPR والمراجعة والدمج بعد الموافقة.
- لا يستخدم Replit Agent لتعديل الكود.
- Replit يبقى مؤقتًا للتشغيل والاختبارات والBuild والPreview عند الحاجة.

---

## 5. Remaining MVP Backlog / TODO

### Priority P0 — Core Security & Identity

#### 5.1 Auth / Session Integration — NEXT
- Login/session flow فعلي.
- authenticated user من مصدر موثوق وليس قيمة يتحكم بها Client.
- session bootstrap وlogout وsession invalidation behavior.
- auth boundary لحماية endpoints المستقبلية.

#### 5.2 Authorized Companies from Memberships
- تحميل Active Memberships للمستخدم.
- استخراج الشركات المسموحة فقط.
- استبعاد memberships المعطلة.
- إعادة التحقق server-side عند اختيار شركة.
- رفض cross-company selection.
- عدم اعتبار client `allowedCompanies` مرجعًا أمنيًا.

#### 5.3 Active Company / Tenant Context
- active company مرتبطة بالمستخدم والجلسة.
- التحقق من membership عند كل switch وكل tenant-scoped request.
- عدم الثقة بقيمة `company_id` الواردة من الواجهة دون verification.

#### 5.4 Capability Enforcement
- ربط capabilities الفعلية بطبقة التنفيذ.
- Backend authorization middleware/service boundary.
- اختبارات unauthorized، inactive membership، cross-company، missing capability، valid capability.

### Priority P1 — Core MVP Completion

#### 5.5 Fiscal Year API / Application Integration
بعد اكتمال Auth/Session:
- endpoints/use-cases الضرورية لإدارة Fiscal Years.
- company context من session.
- capability checks.
- tenant-safe read/write.
- audit integration الحالية.

لا يشمل: periods، monthly close، VAT.

#### 5.6 Initial Application Shell
- login state.
- authenticated layout.
- Company Switcher الحقيقي.
- Language Switcher.
- basic navigation structure.
- mobile-first + RTL/LTR.
- لا Dashboard مالي كامل قبل اكتمال Core security.

#### 5.7 Core MVP Final Security Tests
- Login tests.
- Session tests.
- Company switch tests.
- Membership/Capability tests.
- Cross-company read/write tests.
- inactive membership tests.
- tenant context tests.
- Fiscal Year authorization tests.

### Priority P2 — Core Operational Readiness

#### 5.8 Audit coverage review
- Audit فقط للعمليات الحساسة ذات القيمة المحاسبية/الإدارية، وليس لكل request.

#### 5.9 Documentation refresh
بعد إغلاق Core MVP:
- تحديث `TODO.md`, `DECISIONS.md`, `RECAP_SESSION.md`, `SECURITY_AND_TENANCY_CHECKLIST.md`.
- تحديث README/ARCHITECTURE فقط إذا تغير واقع معماري فعلي.

#### 5.10 Staging validation
قبل أي Production:
- migrations على Staging.
- اختبار Auth/Tenancy/Permissions.
- Build + smoke test.
- مراجعة secrets/environment isolation.
- Production ممنوع حتى الموافقة الصريحة.

---

## 6. Deferred — خارج Core MVP الحالي
- Bank transactions / reconciliation.
- OCR.
- Purchase/Sales invoices.
- Expenses workflow.
- Unknown transfers.
- Personal withdrawals.
- Advances.
- Manpower payroll.
- VAT reconciliation.
- Zakat.
- Month/Quarter/Year-end close workflow الكامل.
- Financial statements وQawaem output.
- Notifications / email alerts.
- External integrations / E-invoicing / ERP integrations.
- Native mobile application.
- Paid AI/APIs.
- Permanent workers/queues.

---

## 7. Definition of Done — المرحلة التالية
مهمة Auth / Session + Company Switcher Integration لا تعتبر مكتملة إلا إذا:
- Design Check معتمد قبل التنفيذ.
- branch مستقل.
- authenticated identity لا تأتي من client-controlled value.
- الشركات تأتي من memberships الفعلية وتستبعد inactive memberships.
- Company switch يُعاد التحقق منه server-side.
- cross-company selection مرفوض.
- capabilities محترمة ضمن حدود المهمة.
- لا توسع خارج scope ولا خدمات/تكلفة جديدة.
- TypeScript ناجح.
- الاختبارات المرتبطة والكاملة الرسمية ناجحة.
- Build ناجح.
- diff reviewed.
- PR مفتوح ومراجع.
- Merge فقط بعد موافقة صريحة.
- main يُزامن بعد الدمج وGit نظيف.
- تحديث تقرير الحالة والقرارات قبل الانتقال للمهمة التالية.
