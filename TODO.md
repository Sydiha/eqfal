# إقفال | EQFAL
# Project Progress & Status Report

آخر تحديث: 2026-08-15

## 1. الحالة التنفيذية المختصرة

المشروع مستمر في بناء Core MVP بعد اكتمال طبقة الهوية والجلسة وربط Company Switcher بالمستخدم الحقيقي.

المرجع الدائم والوحيد للكود المدمج:
- Repository: `Sydiha/eqfal`
- Branch: `main`
- آخر main معتمد: `ff52b059b2f0ade41625d4c5a3a727061c47d6a3`

آخر مرحلة مكتملة:
- Auth / Session + Company Switcher Integration — PR #10 merged.

المهمة التالية المقترحة:
- Fiscal Year API / Application Integration.

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
- SafeUser لا يعرض `password_hash` للعميل.
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

### 2.6 Fiscal Years Foundation — مكتمل ومُدمج كأساس Domain
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
- لا توجد شركات Demo/Placeholder في Runtime.
- reconciliation عند تغير `allowedCompanies`.
- إعادة اختيار نفس الشركة = no-op.
- التحقق النهائي وقت الإغلاق: Server 93/93، Client 40/40، الإجمالي 133/133، TypeScript ناجح، Build ناجح.
- PR #7 — merged.

### 2.10 Tool Routing / Operational Leadership — مكتمل توثيقيًا
- توثيق مسؤولية ChatGPT في اختيار Chat/Work/Codex حسب طبيعة المهمة.
- GitHub/main يبقى المرجع الدائم بغض النظر عن الأداة.
- لا يستخدم Replit Agent لتعديل كود إقفال.
- PR #9 — merged.
- Merge commit السابق للمهمة البرمجية الحالية: `b51e4692121e2f307b663c31783b010703afc494`.

### 2.11 Auth / Session + Secure Company Switching — مكتمل ومُدمج
- Login flow فعلي باستخدام AuthService الحالي.
- Server-side sessions في PostgreSQL.
- opaque random session token عبر HttpOnly Cookie.
- تخزين hash للتوكن في DB بدل التوكن الخام.
- Session bootstrap فعلي.
- Logout يبطل Session الحالية ويمسح Cookie.
- المستخدم المعطل أو Session المنتهية/غير الصالحة لا تمنح وصولًا.
- استخراج الشركات من Active Memberships + Active Companies فقط.
- اختيار Active Company ابتدائية بصورة deterministic.
- `activeCompanyId` محفوظة داخل Session الموثوقة.
- Company Switch يعيد التحقق server-side من العضوية والشركة قبل التحديث.
- failed switch لا يغير Active Company الحالية.
- client `allowedCompanies`, `companyId`, `capabilities` ليست مرجعًا أمنيًا نهائيًا.
- Capability enforcement middleware/boundary موجود في Backend.
- capability lookup محمي أيضًا من cross-company role drift.
- تغيير Membership/Role/Capabilities ينعكس من DB في الطلبات التالية.
- AuthContext فعلي في Frontend مع Login/Logout/Session bootstrap.
- Company Switcher مربوط بالـBackend validation قبل تغيير الحالة المحلية.
- request logging لا يسجل bodies/cookies/tokens.
- async Auth failures تمر عبر generic backend error boundary.
- PR #10 — reviewed and merged.
- Merge commit: `ff52b059b2f0ade41625d4c5a3a727061c47d6a3`.

التحقق النهائي قبل Merge PR #10:
- Server TypeScript: 0 errors.
- Client TypeScript: 0 errors.
- Server tests: 106/106 passed.
- Client tests: 42/42 passed.
- Total tests: 148/148 passed.
- Server build: passed.
- Client build: passed.

---

## 3. Bug Fixes & Security Hardening المحسومة

### 3.1 Migration/startup failure handling
- جعل فشل DB/migrations الحرج fatal وواضحًا.
- إضافة advisory lock حول migrations.

### 3.2 Tenant access clarification
- `company_id` وcompany lookup primitive جزء من الحماية فقط وليسا Authorization كاملًا.
- Backend company + membership + capability checks هي المرجع.

### 3.3 Auth timing behavior
- dummy bcrypt hash صالح لمسار البريد غير الموجود.

### 3.4 Permission Grant Ceiling flaw
- عدم الاعتماد على caller-provided `granterCompanyId`.
- منع self-escalation وcross-company ceiling bypass.

### 3.5 Fiscal Year concurrency
- advisory lock للـoverlap.
- `SELECT ... FOR UPDATE` للعمليات الحساسة.
- write + audit في transaction واحدة.

### 3.6 Audit sensitive data sanitization
- recursive + arrays + case-insensitive sensitive keys.

### 3.7 Company Switcher placeholder/stale state
- إزالة Placeholder runtime data.
- reconciliation للـallowed companies.
- same-company switch no-op.

### 3.8 Session / tenant authority
- Active Company لم تعد Client-only state.
- switch غير المصرح به يرفض server-side.
- Session/role/membership stale authority لا تعتمد على نسخة Client طويلة العمر.

### 3.9 Cross-company capability drift defense
- capability lookup يتحقق من توافق Role مع Company عبر membership relation ولا يسمح بدور من شركة مختلفة بأن يمنح capabilities فعالة.

### 3.10 Backend error leakage
- Auth async failures تمر إلى generic Express error boundary بدل تسريب تفاصيل داخلية للعميل.

---

## 4. Current Status

لا توجد مهمة برمجية مفتوحة حاليًا.

آخر عمل مدمج:
- PR #10 — Auth / Session + Secure Company Switching.

آخر main معتمد:
- `ff52b059b2f0ade41625d4c5a3a727061c47d6a3`.

النقطة التالية المقترحة:
- **Fiscal Year API / Application Integration**.

يجب أن تبدأ بـ Design Check فقط قبل كتابة أي كود.

طريقة العمل:
- ChatGPT + GitHub مسؤولان عن تنفيذ الكود والفروع والـPR والمراجعة والدمج وفق قواعد المشروع.
- لا يستخدم Replit Agent لتعديل الكود.
- Replit يبقى مؤقتًا للتشغيل والاختبارات والBuild والPreview عند الحاجة.

---

## 5. Remaining MVP Backlog / TODO

### Priority P0 — Core Security & Identity

#### 5.1 Auth / Session Integration — DONE
- Login/session flow فعلي ✅
- authenticated user من مصدر Server-side موثوق ✅
- session bootstrap/logout/invalidation current-session ✅
- auth middleware boundary ✅

#### 5.2 Authorized Companies from Memberships — DONE
- Active Memberships + Active Companies فقط ✅
- استبعاد memberships/companies المعطلة ✅
- server-side revalidation عند switch ✅
- cross-company selection مرفوض ✅
- client `allowedCompanies` ليست authority ✅

#### 5.3 Active Company / Tenant Context — DONE كأساس
- Active Company مرتبطة بالجلسة ✅
- membership validation عند switch ✅
- tenant-scoped endpoints المستقبلية يجب أن تستخدم Active Company الموثوقة، وهذا يطبق عند بناء كل endpoint جديد.

#### 5.4 Capability Enforcement — DONE كأساس
- Backend capability middleware/service boundary ✅
- fresh DB-backed capability evaluation ✅
- اختبارات authorization الأساسية موجودة ✅
- كل endpoint جديد يجب أن يحدد Capability المطلوبة عند بنائه.

### Priority P1 — Core MVP Completion

#### 5.5 Fiscal Year API / Application Integration — NEXT
المطلوب بعد Design Check:
- endpoints/use-cases الضرورية لإدارة Fiscal Years.
- authenticated user من Session.
- Active Company من Session الموثوقة.
- capability checks لكل operation.
- tenant-safe read/write.
- الاستفادة من Fiscal Year service والlocking/audit الموجود بدل إعادة بناء Domain logic.

لا يشمل:
- Accounting periods.
- Month/Quarter close.
- VAT.
- Reopen workflow الكامل إلا إذا كان مطلوبًا لتكامل API الأساسي وتم اعتماده تصميميًا.

#### 5.6 Initial Application Shell — PARTIAL
المكتمل:
- login state ✅
- Company Switcher الحقيقي ✅
- Language Switcher ✅
- mobile-first + RTL/LTR foundation ✅

المتبقي:
- authenticated layout المنظم.
- basic navigation structure.
- ربط أول module فعلي بعد Auth بالواجهة.
- لا Dashboard مالي كامل قبل اكتمال Core MVP.

#### 5.7 Core MVP Final Security Tests — IN PROGRESS
مكتمل ضمن Auth/Session:
- Login tests ✅
- Session tests ✅
- Company switch tests ✅
- Membership/Capability tests ✅
- inactive membership tests ✅
- tenant context foundation tests ✅

متبقي مع بناء وحدات التطبيق:
- cross-company read/write tests لكل business endpoint.
- Fiscal Year authorization tests عبر HTTP/Application boundary.

### Priority P2 — Core Operational Readiness

#### 5.8 Audit coverage review
- Audit فقط للعمليات الحساسة ذات القيمة المحاسبية/الإدارية، وليس لكل request.
- يراجع coverage مع كل module فعلي.

#### 5.9 Documentation refresh
- بعد كل حزمة جوهرية: تحديث `TODO.md`, `DECISIONS.md`, `RECAP_SESSION.md`, و`SECURITY_AND_TENANCY_CHECKLIST.md` عند تغير حالة أمنية.
- README/ARCHITECTURE فقط إذا تغير واقع معماري فعلي.

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
- MFA/OAuth حتى تظهر حاجة معتمدة.
- Password reset / logout-all-devices حتى مرحلة إدارة الحسابات.

---

## 7. Definition of Done — المهمة التالية المقترحة
مهمة Fiscal Year API / Application Integration لا تعتبر مكتملة إلا إذا:
- Design Check معتمد قبل التنفيذ.
- branch مستقل من latest `main`.
- identity تأتي من Session لا من client-controlled user ID.
- company context تأتي من Session/validated membership.
- كل operation تحدد capability المطلوبة وتفرضها Backend-side.
- لا endpoint يستطيع قراءة/تعديل Fiscal Year لشركة أخرى عبر ID مباشر.
- لا إعادة بناء لمنطق Fiscal Year الموجود بلا حاجة.
- audit behavior الحالي يبقى صحيحًا للعمليات الحساسة.
- لا توسع إلى Accounting periods/VAT/monthly close.
- TypeScript ناجح.
- الاختبارات المرتبطة والكاملة الرسمية ناجحة.
- Build ناجح.
- diff reviewed.
- PR مفتوح ومراجع.
- Merge وفق قواعد المشروع.
- تحديث تقرير الحالة والقرارات قبل الانتقال للمهمة التالية.
